// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The keeper orchestrator itself (`runtime.ts`): the boot sequence and the cron ticker. Three
 * of the bugs fixed in September sat exactly here (2.8 the mesh started on an empty document,
 * 4.3 the control dapp was fed to n8n after a restart, 4.15 a restart swallowed a due rule),
 * and nothing but the smoke test — which only proves the process comes up — covered it.
 *
 * Everything that would touch the network is replaced; the real store stack runs (fake
 * IndexedDB), so catalog, members, signing and automations behave as in production.
 */

const mesh = vi.hoisted(() => ({
  /** dappId → the doc content the mesh saw when it was asked to connect that dapp. */
  connectedWith: new Map<string, string | undefined>(),
  channels: [] as string[],
  destroyed: [] as string[],
}));

vi.mock('../services/blobRoomManager.ts', async () => {
  const docs = await import('../services/store/docs.ts');
  return {
    ensureBlobChannel: (dappId: string) => {
      mesh.channels.push(dappId);
      // What the mesh would serve and decide trust from at this moment (2.8).
      mesh.connectedWith.set(dappId, docs.getDappDoc(dappId).getMap('config').get('probe') as string | undefined);
      return Promise.resolve(true);
    },
    destroyBlobChannel: (dappId: string) => { mesh.destroyed.push(dappId); },
    replicateAllBlobs: () => Promise.resolve(),
    syncDappStateFromPeers: () => Promise.resolve(),
    getBlobChannelStatus: () => ({ active: false, brokerConnected: false, brokerUrl: null, brokers: [], peers: [], docs: null }),
  };
});
vi.mock('../services/meshPresence.ts', () => ({ getMeshPeerKeys: () => [], publishMeshPeerKeys: () => undefined }));
vi.mock('../services/store/sourceSeal.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/store/sourceSeal.ts')>(),
  watchSourceSeal: () => undefined,
}));
vi.mock('../headless/pushSender.ts', () => ({ sendPendingShareTickles: () => Promise.resolve() }));

const { HeadlessRuntime } = await import('../headless/runtime.ts');
const { loadOrCreateHeadlessIdentity } = await import('../headless/identityFile.ts');
const { getDappDoc, getDappsList } = await import('../services/store/docs.ts');
const { addDappByCredentials, createDapp } = await import('../services/store/config.ts');
const { putAutomationRule, listAutomationRules } = await import('../services/store/automations.ts');
const { getEntityRecords } = await import('../services/store/data.ts');
const { readMemberBaseline, saveMemberBaseline } = await import('../services/store/memberBaseline.ts');

const dataDirs: string[] = [];

async function dataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'keeper-runtime-'));
  dataDirs.push(dir);
  return dir;
}

async function startRuntime(dir: string) {
  const identity = await loadOrCreateHeadlessIdentity(dir, 'Test Keeper');
  const runtime = new HeadlessRuntime({ dataDir: dir, identity, signalingUrls: [], replicateFiles: true });
  await runtime.start();
  return runtime;
}

/** Wipes the in-memory store singletons so a "restart" really reloads from the data directory. */
async function freshStoreModules(): Promise<void> {
  vi.resetModules();
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

beforeEach(() => {
  mesh.connectedWith.clear();
  mesh.channels.length = 0;
  mesh.destroyed.length = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dataDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('keeper boot sequence', () => {
  it('loads a dapp from disk BEFORE it brings the mesh up, and keeps the catalog across a restart', async () => {
    const dir = await dataDir();
    const first = await startRuntime(dir);
    const dappId = addDappByCredentials('room-boot', 'pw'.repeat(16));
    getDappDoc(dappId).getMap('config').set('probe', 'written-before-restart');
    // The catalog observer connects the new dapp; give that pass time to finish.
    await vi.waitFor(() => { expect(mesh.channels).toContain(dappId); }, { timeout: 5000 });
    await first.stop();

    // Restart on the same data directory: nothing is in memory any more.
    mesh.channels.length = 0;
    mesh.connectedWith.clear();
    const second = await startRuntime(dir);
    try {
      expect(mesh.channels).toContain(dappId);
      // The mesh serves documents and decides trust from them, so it must never see an empty one.
      expect(mesh.connectedWith.get(dappId)).toBe('written-before-restart');
      expect([...getDappsList()].map((item) => item.get('id'))).toEqual([dappId]);
      expect(await fs.readdir(path.join(dir, 'docs'))).toContain(`dapp-${dappId}`);
    } finally {
      await second.stop();
    }
  }, 30_000);

  it('refuses to start when the root document on disk is damaged instead of compacting an empty one over it', async () => {
    const dir = await dataDir();
    const runtime = await startRuntime(dir);
    addDappByCredentials('room-precious', 'pw'.repeat(16));
    await runtime.stop();

    const snapshot = path.join(dir, 'docs', 'root', 'snapshot.bin');
    const damaged = new Uint8Array([0x07, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0x02]);
    await fs.writeFile(snapshot, damaged);
    await freshStoreModules();
    const { HeadlessRuntime: Restarted } = await import('../headless/runtime.ts');
    const { loadOrCreateHeadlessIdentity: loadIdentity } = await import('../headless/identityFile.ts');
    const identity = await loadIdentity(dir, 'Test Keeper');
    const second = new Restarted({ dataDir: dir, identity, signalingUrls: [], replicateFiles: true });

    await expect(second.start()).rejects.toThrow(/refusing to start/);
    // The file is untouched — it can still be restored from a backup.
    expect(new Uint8Array(await fs.readFile(snapshot))).toEqual(damaged);
  }, 30_000);
});

describe('keeper cron ticker', () => {
  it('fires a due rule once per minute and catches up on the minutes a restart was down', async () => {
    const dir = await dataDir();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-09-18T08:00:10.000Z'));

    const runtime = await startRuntime(dir);
    // A dapp the keeper owns: its automation steps write signed records like any member device.
    const dappId = createDapp('Cron target', '⏰', '#123456');
    putAutomationRule({
      id: 'every-minute',
      name: 'Every minute',
      enabled: true,
      trigger: { kind: 'cron', schedule: '* * * * *' },
      steps: [{ kind: 'create-record', dappId, collection: 'entries', data: { title: 'tick {{now.time}}' } }],
    });

    // Still the same minute as the boot: nothing is due yet.
    vi.setSystemTime(new Date('2026-09-18T08:00:50.000Z'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(getEntityRecords(dappId, 'entries') ?? []).toHaveLength(0);

    vi.setSystemTime(new Date('2026-09-18T08:01:05.000Z'));
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.waitFor(() => { expect(getEntityRecords(dappId, 'entries') ?? []).toHaveLength(1); }, { timeout: 5000 });

    // Another tick in the same minute must not fire the rule a second time.
    vi.setSystemTime(new Date('2026-09-18T08:01:40.000Z'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(getEntityRecords(dappId, 'entries') ?? []).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'cron-state.json'), 'utf8'))).toEqual({
      lastMinute: Math.floor(Date.parse('2026-09-18T08:01:00.000Z') / 60_000),
    });
    await runtime.stop();

    // Restarted two minutes later: the stored minute is what makes the keeper catch up on the
    // minutes it was down (08:02 and 08:03). Without it a restart silently swallows them.
    vi.setSystemTime(new Date('2026-09-18T08:03:05.000Z'));
    const restarted = await startRuntime(dir);
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.waitFor(() => { expect(getEntityRecords(dappId, 'entries') ?? []).toHaveLength(3); }, { timeout: 5000 });

    // And it does not go back further than the minutes it actually missed.
    vi.setSystemTime(new Date('2026-09-18T08:03:50.000Z'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(getEntityRecords(dappId, 'entries') ?? []).toHaveLength(3);
    await restarted.stop();
  }, 30_000);

  it('refuses a rule whose schedule the ticker could never match', async () => {
    const dir = await dataDir();
    const runtime = await startRuntime(dir);
    try {
      expect(() => runtime.putRule({
        id: 'broken', name: 'Broken', enabled: true,
        trigger: { kind: 'cron', schedule: 'every minute please' },
        steps: [{ kind: 'create-record', dappId: 'whatever', collection: 'entries', data: {} }],
      })).toThrow(/cron/i);
      // A schedule the ticker cannot parse is silently never due, so it must not be stored at all.
      expect(listAutomationRules().some((rule) => rule.id === 'broken')).toBe(false);
    } finally {
      await runtime.stop();
    }
  }, 30_000);
});

describe('keeper device-local state', () => {
  it('keeps the verified member baseline across a restart, although localStorage is volatile', async () => {
    const dir = await dataDir();
    const first = await startRuntime(dir);
    const dappId = addDappByCredentials('room-device-state', 'pw'.repeat(16));
    const memberKey = 'ab'.repeat(32);
    const entry = { publicKey: memberKey, role: 'owner', name: 'Founder', memberUpdatedAt: '2026-09-18T08:00:00.000Z' };
    // What the auth observer does after a scan that changed the verified set.
    expect(saveMemberBaseline(dappId, new Map([[memberKey, entry]]), new Map())).toBe(true);
    await first.stop();

    const stored: unknown = JSON.parse(await fs.readFile(path.join(dir, 'device-state.json'), 'utf8'));
    expect(stored).toHaveProperty(`vibedapp:members:${dappId}`);

    // A keeper boots with an empty localStorage every time (env.ts installs a volatile polyfill),
    // which is exactly why the baseline lives in the data directory rather than in it.
    localStorage.clear();
    expect(readMemberBaseline(dappId)).toBeNull();

    const second = await startRuntime(dir);
    try {
      expect([...(readMemberBaseline(dappId)?.members.keys() ?? [])]).toEqual([memberKey]);
      expect(readMemberBaseline(dappId)?.members.get(memberKey)).toEqual(entry);
    } finally {
      await second.stop();
    }
  }, 30_000);
});
