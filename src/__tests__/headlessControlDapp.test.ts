import { describe, expect, it, vi } from 'vitest';
import type { VerifiedRecordsChange } from '../services/store/auth.ts';
import type { AutomationRule } from '../types.ts';
import { ControlDapp, CONTROL_DAPP_NAME, type AiAccess, type KeeperOps } from '../headless/controlDapp.ts';
import type { GenerateRequest, GeneratedDapp } from '../headless/dappGenerator.ts';
import type { ControlStore, LobbyPeer } from '../headless/controlStore.ts';
import type { RuntimeStatus } from '../headless/runtime.ts';

const KEEPER_KEY = 'aa'.repeat(32);
const OPERATOR_KEY = 'bb'.repeat(32);
const STRANGER_KEY = 'cc'.repeat(32);
const CONTROL_ID = 'control-dapp-id';

interface Stored { collection: string; id: string; data: Record<string, unknown> }

/** In-memory ControlStore: records per collection, a members map, and a lobby per dapp. */
function fakeStore() {
  const records = new Map<string, Stored>();
  const owners = new Map<string, Array<{ publicKey: string; name: string }>>([[CONTROL_ID, [{ publicKey: OPERATOR_KEY, name: 'Phone' }]]]);
  const lobbies = new Map<string, LobbyPeer[]>();
  const listeners = new Map<string, (change: VerifiedRecordsChange) => void>();
  const approved: Array<{ dappId: string; publicKey: string; role: string }> = [];
  const invites: Array<{ dappId: string; uses: number }> = [];
  const dapps = new Set<string>([CONTROL_ID, 'owned-1']);
  const sources = new Map<string, Record<string, string>>([[CONTROL_ID, { 'index.html': '<!doctype html>', 'manifest.yaml': 'name: Keeper Control' }]]);
  const manifestSynced: string[] = [];
  /** What the auth observer accepted before anyone subscribed (the boot window). */
  const verified = new Map<string, VerifiedRecordsChange['upserts']>();
  const store: ControlStore = {
    sourceFiles: (dappId) => sources.get(dappId) ?? {},
    replaceSource: (dappId, files) => { sources.set(dappId, { ...files }); },
    replaceSourceAndManifest: (dappId, files) => { sources.set(dappId, { ...files }); manifestSynced.push(dappId); },
    createDappFromFiles: (name, _icon, _color, files) => {
      const id = `generated-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      dapps.add(id);
      sources.set(id, { ...files });
      return id;
    },
    dappIdentity: (dappId) => ({ name: dappId === 'owned-1' ? 'Recipes' : dappId, icon: '🍲', color: '#123456' }),
    roleOf: (dappId) => (dapps.has(dappId) ? 'owner' : null),
    createControlDapp: vi.fn((name: string) => {
      expect(name).toBe(CONTROL_DAPP_NAME);
      dapps.add('fresh-control');
      owners.set('fresh-control', []);
      return 'fresh-control';
    }),
    hasDapp: (id) => dapps.has(id),
    owners: (dappId) => owners.get(dappId) ?? [],
    isMember: () => false,
    ownedDappIds: () => [...dapps],
    createInvite: (dappId, uses) => { invites.push({ dappId, uses }); return Promise.resolve(`dapp://invite/app/lobby-${dappId}/pw`); },
    lobbyPeers: (dappId) => Promise.resolve(lobbies.get(dappId) ?? []),
    pendingApprovals: (dappId) => Promise.resolve(dappId === 'pending-1' ? [{ safetyNumber: '424242', ownerDisplayName: 'Laptop' }, { safetyNumber: '171717', ownerDisplayName: 'Phone' }] : []),
    approve: (dappId, peer, role) => {
      approved.push({ dappId, publicKey: peer.publicKey, role });
      lobbies.set(dappId, (lobbies.get(dappId) ?? []).filter((entry) => entry.publicKey !== peer.publicKey));
      return Promise.resolve();
    },
    records: (dappId, collection) => [...records.values()].filter((entry) => entry.collection === `${dappId}/${collection}`).map((entry) => ({ ...entry.data, id: entry.id })),
    createRecord: (dappId, collection, data) => {
      records.set(`${dappId}/${collection}/${String(data.id)}`, { collection: `${dappId}/${collection}`, id: String(data.id), data: { ...data } });
      return Promise.resolve();
    },
    updateRecord: (dappId, collection, id, data) => {
      const key = `${dappId}/${collection}/${id}`;
      const existing = records.get(key);
      records.set(key, { collection: `${dappId}/${collection}`, id, data: { ...(existing?.data ?? {}), ...data } });
      return Promise.resolve();
    },
    subscribe: (dappId, listener) => { listeners.set(dappId, listener); return () => { listeners.delete(dappId); }; },
    verifiedRecords: (dappId) => verified.get(dappId) ?? [],
  };
  const push = (dappId: string, change: VerifiedRecordsChange) => {
    const listener = listeners.get(dappId);
    if (!listener) throw new Error('not subscribed');
    listener(change);
  };
  const command = (id: string) => records.get(`${CONTROL_ID}/commands/${id}`)?.data;
  const statusRecord = () => records.get(`${CONTROL_ID}/keeper/status`)?.data;
  /** A record that is in the doc and in the verified set, but was never announced to a listener. */
  const seedUnannounced = (dappId: string, collection: string, record: Record<string, unknown>) => {
    records.set(`${dappId}/${collection}/${String(record.id)}`, { collection: `${dappId}/${collection}`, id: String(record.id), data: { ...record } });
    verified.set(dappId, [...(verified.get(dappId) ?? []), { entityId: collection, record }]);
  };
  return { store, push, command, statusRecord, lobbies, approved, invites, owners, sources, manifestSynced, seedUnannounced };
}

function runtimeStatus(): RuntimeStatus {
  return {
    identity: { publicKey: KEEPER_KEY, displayName: 'NAS Keeper', deviceId: 'dev' },
    startedAt: '2026-09-09T10:00:00.000Z',
    signalingUrls: [],
    dapps: [
      { id: CONTROL_ID, name: 'Keeper Control', icon: '🛰️', joinMethod: 'owner', hasCredentials: true, role: 'owner', memberCount: 2, connectedPeers: 1, blob: { active: false, brokerConnected: false, brokerUrl: null, brokers: [], peers: [], docs: null }, blobReplication: 'pinAll', pendingGrant: null },
      { id: 'owned-1', name: 'Recipes', icon: '🍲', joinMethod: 'owner', hasCredentials: true, role: 'owner', memberCount: 1, connectedPeers: 0, blob: { active: false, brokerConnected: false, brokerUrl: null, brokers: [], peers: [], docs: null }, blobReplication: 'pinAll', pendingGrant: null },
      { id: 'pending-1', name: 'Diary', icon: '📓', joinMethod: 'lobby', hasCredentials: false, role: null, memberCount: 0, connectedPeers: 0, blob: { active: false, brokerConnected: false, brokerUrl: null, brokers: [], peers: [], docs: null }, blobReplication: 'onDemand', pendingGrant: { approvedBy: 'cc'.repeat(32), approverName: 'Somebody', code: '12345678' } },
    ],
    automations: [],
    integrations: { llm: { baseUrl: 'http://gw/v1', model: 'm' }, n8n: null },
  };
}

function fakeKeeper() {
  const calls: Array<[string, unknown[]]> = [];
  const rule: AutomationRule = {
    schemaVersion: 1, id: 'r1', name: 'Rule', enabled: true, trigger: { kind: 'cron', schedule: '0 8 * * *' }, steps: [], createdAt: 'x', updatedAt: 'x',
  };
  const keeper: KeeperOps = {
    status: runtimeStatus,
    join: (invite) => { calls.push(['join', [invite]]); return Promise.resolve('joined-id'); },
    removeDapp: (id, options) => { calls.push(['removeDapp', options?.dropFounded ? [id, 'dropFounded'] : [id]]); return Promise.resolve(true); },
    setReplication: (id, mode) => { calls.push(['setReplication', [id, mode]]); return Promise.resolve(); },
    decideGrant: (id, accept) => { calls.push(['decideGrant', [id, accept]]); return id === 'pending-1'; },
    putRule: (input) => { calls.push(['putRule', [input]]); return { ...rule, ...input }; },
    deleteRule: (id) => { calls.push(['deleteRule', [id]]); return true; },
    runRuleNow: (id) => { calls.push(['runRuleNow', [id]]); return Promise.resolve(); },
  };
  return { keeper, calls };
}

function fakeAi() {
  const snapshots = new Map<string, Array<{ id: string; at: string; note: string; files: Record<string, string> }>>();
  const generated: GenerateRequest[] = [];
  const persistedModels: string[] = [];
  let counter = 0;
  const ai: AiAccess = {
    llm: { model: 'chatgpt/gpt-6-astra', baseUrl: 'http://gw/v1', keyConfigured: true, listModels: () => Promise.resolve(['chatgpt/gpt-5.6-terra', 'chatgpt/gpt-6-astra']) },
    generator: {
      generate: (request) => {
        generated.push(request);
        const result: GeneratedDapp = request.current
          ? { name: request.current.name, icon: request.current.icon, color: request.current.color, files: { ...request.current.files, 'index.html': `<!doctype html><!-- ${request.prompt} -->` } }
          : { name: request.suggested?.name ?? 'Fresh App', icon: '🧪', color: '#00ff00', files: { 'index.html': '<!doctype html><p>new</p>', 'manifest.yaml': 'name: Fresh App' } };
        return Promise.resolve(result);
      },
    },
    revisions: {
      save: (dappId, files, note) => {
        counter += 1;
        const id = `rev-${counter}`;
        snapshots.set(dappId, [{ id, at: `2026-09-09T12:00:0${counter}.000Z`, note, files: { ...files } }, ...(snapshots.get(dappId) ?? [])]);
        return Promise.resolve(id);
      },
      list: (dappId) => Promise.resolve((snapshots.get(dappId) ?? []).map(({ id, at, note }) => ({ id, at, note }))),
      load: (dappId, id) => {
        const found = (snapshots.get(dappId) ?? []).find((entry) => entry.id === id);
        return found ? Promise.resolve(found.files) : Promise.reject(new Error('no such revision'));
      },
    },
    persistModel: (model) => { persistedModels.push(model); return Promise.resolve(); },
  };
  return { ai, snapshots, generated, persistedModels };
}

function makeControl(overrides: { controlDappId?: string; appUrl?: string; ai?: AiAccess; executedCommandIds?: string[]; persistExecutedCommands?: (ids: string[]) => Promise<void> } = {}) {
  const fake = fakeStore();
  const { keeper, calls } = fakeKeeper();
  const persisted: string[] = [];
  const aiFake = fakeAi();
  const control = new ControlDapp({
    store: fake.store,
    keeper,
    identity: { publicKey: KEEPER_KEY, displayName: 'NAS Keeper' },
    files: { 'index.html': '<!doctype html>', 'manifest.yaml': 'name: Keeper Control' },
    controlDappId: CONTROL_ID,
    ai: aiFake.ai,
    persistControlDappId: (id) => { persisted.push(id); return Promise.resolve(); },
    now: () => new Date('2026-09-09T12:00:00.000Z'),
    timers: false,
    ...overrides,
  });
  return { control, fake, calls, persisted, aiFake };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function commandChange(id: string, data: Record<string, unknown>): VerifiedRecordsChange {
  // The keeper's clock in these tests stands at 12:00:00 — a command has to be fresh to run.
  return { upserts: [{ entityId: 'commands', record: { id, status: 'new', _signedBy: OPERATOR_KEY, createdAt: '2026-09-09T11:59:30.000Z', ...data } }], deletes: [] };
}

describe('ControlDapp', () => {
  it('creates the dapp once, persists its id, and mirrors status into the keeper record', async () => {
    const { control, fake, persisted } = makeControl({ controlDappId: undefined });
    expect(control.id).toBeNull();
    const id = await control.ensure();
    expect(id).toBe('fresh-control');
    expect(persisted).toEqual(['fresh-control']);
    expect(fake.store.createControlDapp).toHaveBeenCalledTimes(1);
    await control.ensure();
    expect(fake.store.createControlDapp).toHaveBeenCalledTimes(1);
    control.stop();
  });

  it('rolls the shipped bundle into an existing control dapp when it changed', async () => {
    const { control, fake } = makeControl();
    fake.sources.set(CONTROL_ID, { 'index.html': '<!doctype html><!-- old -->', 'manifest.yaml': 'name: Keeper Control' });
    await control.ensure();
    expect(fake.sources.get(CONTROL_ID)).toEqual({ 'index.html': '<!doctype html>', 'manifest.yaml': 'name: Keeper Control' });
    control.stop();
  });

  it('writes the status record with operators, lobby, and integrations', async () => {
    const { control, fake } = makeControl();
    await control.ensure();
    await flush();
    const status = fake.statusRecord();
    expect(status).toBeDefined();
    expect(status?.controlDappId).toBe(CONTROL_ID);
    expect(status?.operators).toEqual([{ publicKey: OPERATOR_KEY, name: 'Phone' }]);
    const dapps = status?.dapps as Array<{ id: string; isControl: boolean; pendingApprovals: unknown }>;
    expect(dapps.map((dapp) => [dapp.id, dapp.isControl])).toEqual([[CONTROL_ID, true], ['owned-1', false], ['pending-1', false]]);
    expect(dapps.map((dapp) => dapp.pendingApprovals)).toEqual([[], [], [{ safetyNumber: '424242', ownerDisplayName: 'Laptop' }, { safetyNumber: '171717', ownerDisplayName: 'Phone' }]]);
    expect(status?.integrations).toEqual({
      llm: { baseUrl: 'http://gw/v1', model: 'chatgpt/gpt-6-astra', keyConfigured: true, models: ['chatgpt/gpt-5.6-terra', 'chatgpt/gpt-6-astra'], modelsError: null },
      n8n: null,
    });
    expect(dapps.map((dapp) => (dapp as unknown as { canEdit: boolean }).canEdit)).toEqual([false, true, false]);
    expect(status?.updatedAt).toBe('2026-09-09T12:00:00.000Z');
    control.stop();
  });

  it('executes operator commands and records the outcome; ignores non-operator signers', async () => {
    const { control, fake, calls } = makeControl();
    await control.ensure();
    fake.push(CONTROL_ID, commandChange('c1', { type: 'join-invite', args: { invite: 'dapp://invite/app/x/y' } }));
    fake.push(CONTROL_ID, { upserts: [{ entityId: 'commands', record: { id: 'c2', status: 'new', _signedBy: STRANGER_KEY, type: 'join-invite', args: { invite: 'evil' } } }], deletes: [] });
    await flush();
    await flush();
    expect(calls).toEqual([['join', ['dapp://invite/app/x/y']]]);
    expect(fake.command('c1')).toMatchObject({ status: 'done', result: { dappId: 'joined-id' }, finishedAt: '2026-09-09T12:00:00.000Z' });
    expect(fake.command('c2')).toBeUndefined();
    control.stop();
  });

  it('picks up commands that arrived before it subscribed, and fails one the previous session left working', async () => {
    const { control, fake, calls } = makeControl({ controlDappId: CONTROL_ID });
    fake.seedUnannounced(CONTROL_ID, 'commands', { id: 'early', status: 'new', _signedBy: OPERATOR_KEY, createdAt: '2026-09-09T11:59:30.000Z', type: 'join-invite', args: { invite: 'dapp://invite/app/x/y' } });
    fake.seedUnannounced(CONTROL_ID, 'commands', { id: 'orphan', status: 'working', _signedBy: KEEPER_KEY, createdAt: '2026-09-09T11:50:00.000Z', type: 'join-invite', args: { invite: 'dapp://invite/app/a/b' } });
    control.start();
    await flush();
    await flush();
    expect(calls).toEqual([['join', ['dapp://invite/app/x/y']]]);
    expect(fake.command('early')).toMatchObject({ status: 'done' });
    expect(fake.command('orphan')).toMatchObject({ status: 'failed', error: 'keeper restarted while this command was running' });

    // The verified set still shows the old states (it trails the doc by a scan): nothing runs twice.
    await control.tick();
    await flush();
    expect(calls).toHaveLength(1);
    expect(fake.command('early')).toMatchObject({ status: 'done' });
    control.stop();
  });

  it('runs a command once: a replayed copy, a stale one and one from before a restart are refused', async () => {
    const persisted: string[][] = [];
    const { control, fake, calls } = makeControl({
      executedCommandIds: ['before-restart'],
      persistExecutedCommands: (ids) => { persisted.push(ids); return Promise.resolve(); },
    });
    await control.ensure();
    const join = { type: 'join-invite', args: { invite: 'dapp://invite/app/x/y' } };

    fake.push(CONTROL_ID, commandChange('c1', join));
    await flush();
    await flush();
    expect(fake.command('c1')?.status).toBe('done');
    expect(persisted.at(-1)).toEqual(['before-restart', 'c1']);

    // An editor puts the operator's original signed `new` version back.
    fake.push(CONTROL_ID, commandChange('c1', join));
    // A validly signed command from last week, and one the previous keeper session already ran.
    fake.push(CONTROL_ID, commandChange('old', { ...join, createdAt: '2026-09-02T12:00:00.000Z' }));
    fake.push(CONTROL_ID, commandChange('before-restart', join));
    fake.push(CONTROL_ID, commandChange('undated', { ...join, createdAt: undefined }));
    await flush();
    await flush();

    expect(calls).toEqual([['join', ['dapp://invite/app/x/y']]]); // exactly one join
    expect(String(fake.command('c1')?.error)).toContain('already ran');
    expect(String(fake.command('old')?.error)).toContain('older than 10 minutes');
    expect(String(fake.command('before-restart')?.error)).toContain('already ran');
    expect(fake.command('undated')?.status).toBe('failed');
    control.stop();
  });

  it('reports an approval it holds and joins only on an operator\'s confirm-join', async () => {
    const { control, fake, calls } = makeControl();
    await control.ensure();
    await flush();
    await flush();
    const dapps = fake.statusRecord()?.dapps as Array<{ id: string; pendingGrant: unknown }>;
    expect(dapps.find((dapp) => dapp.id === 'pending-1')?.pendingGrant).toEqual({ approvedBy: 'cc'.repeat(32), approverName: 'Somebody', code: '12345678' });
    expect(dapps.find((dapp) => dapp.id === 'owned-1')?.pendingGrant).toBeNull();

    fake.push(CONTROL_ID, commandChange('j1', { type: 'confirm-join', args: { dappId: 'pending-1', accept: false } }));
    fake.push(CONTROL_ID, commandChange('j2', { type: 'confirm-join', args: { dappId: 'pending-1' } }));
    fake.push(CONTROL_ID, commandChange('j3', { type: 'confirm-join', args: { dappId: 'owned-1' } }));
    fake.push(CONTROL_ID, { upserts: [{ entityId: 'commands', record: { id: 'j4', status: 'new', _signedBy: STRANGER_KEY, createdAt: '2026-09-09T11:59:30.000Z', type: 'confirm-join', args: { dappId: 'pending-1' } } }], deletes: [] });
    await flush();
    await flush();
    expect(fake.command('j1')).toMatchObject({ status: 'done', result: { dappId: 'pending-1', joined: false } });
    expect(fake.command('j2')).toMatchObject({ status: 'done', result: { dappId: 'pending-1', joined: true } });
    expect(String(fake.command('j3')?.error)).toContain('holds no approval');
    expect(calls).toEqual([['decideGrant', ['pending-1', false]], ['decideGrant', ['pending-1', true]], ['decideGrant', ['owned-1', true]]]);
    control.stop();
  });

  it('fails commands with bad arguments and refuses to leave the control dapp', async () => {
    const { control, fake, calls } = makeControl();
    await control.ensure();
    fake.push(CONTROL_ID, commandChange('c1', { type: 'leave-dapp', args: { dappId: 'owned-1' } }));
    fake.push(CONTROL_ID, commandChange('c2', { type: 'leave-dapp', args: { dappId: CONTROL_ID, confirm: true } }));
    fake.push(CONTROL_ID, commandChange('c3', { type: 'leave-dapp', args: { dappId: 'owned-1', confirm: true } }));
    fake.push(CONTROL_ID, commandChange('c4', { type: 'nonsense', args: {} }));
    // Dropping a dapp the keeper founded is only ever done on explicit request.
    fake.push(CONTROL_ID, commandChange('c5', { type: 'leave-dapp', args: { dappId: 'owned-1', confirm: true, dropFounded: true } }));
    await flush();
    await flush();
    expect(fake.command('c1')?.status).toBe('failed');
    expect(String(fake.command('c1')?.error)).toContain('confirm');
    expect(String(fake.command('c2')?.error)).toContain('control dapp');
    expect(fake.command('c3')).toMatchObject({ status: 'done', result: { removed: true } });
    expect(String(fake.command('c4')?.error)).toContain('unknown command type');
    expect(calls).toEqual([['removeDapp', ['owned-1']], ['removeDapp', ['owned-1', 'dropFounded']]]);
    control.stop();
  });

  it('handles invites, replication, rules, and device approval', async () => {
    const { control, fake, calls } = makeControl({ appUrl: 'https://dapp.example' });
    await control.ensure();
    fake.lobbies.set('owned-1', [{ publicKey: STRANGER_KEY, displayName: 'Friend', inviteId: 'inv', rejoin: false, safetyNumber: '123456', encPublicKey: 'enc' }]);
    fake.push(CONTROL_ID, commandChange('inv', { type: 'create-invite', args: { dappId: 'owned-1', uses: 2 } }));
    fake.push(CONTROL_ID, commandChange('rep', { type: 'set-replication', args: { dappId: 'owned-1', mode: 'onDemand' } }));
    fake.push(CONTROL_ID, commandChange('badrep', { type: 'set-replication', args: { dappId: 'owned-1', mode: 'sometimes' } }));
    fake.push(CONTROL_ID, commandChange('rule', { type: 'put-rule', args: { rule: { id: 'r9', name: 'Nine', trigger: { kind: 'cron', schedule: '* * * * *' }, steps: [] } } }));
    fake.push(CONTROL_ID, commandChange('run', { type: 'run-rule', args: { ruleId: 'r9' } }));
    fake.push(CONTROL_ID, commandChange('del', { type: 'delete-rule', args: { ruleId: 'r9' } }));
    fake.push(CONTROL_ID, commandChange('appr', { type: 'approve-device', args: { dappId: 'owned-1', publicKey: STRANGER_KEY, role: 'viewer' } }));
    await flush();
    await flush();
    await flush();
    expect(fake.command('inv')).toMatchObject({ status: 'done', result: { uri: 'dapp://invite/app/lobby-owned-1/pw', link: 'https://dapp.example/invite#code=dapp%3A%2F%2Finvite%2Fapp%2Flobby-owned-1%2Fpw' } });
    expect(fake.invites).toEqual([{ dappId: 'owned-1', uses: 2 }]);
    expect(fake.command('rep')?.status).toBe('done');
    expect(fake.command('badrep')?.status).toBe('failed');
    expect(fake.command('rule')?.status).toBe('done');
    expect(fake.command('run')?.status).toBe('done');
    expect(fake.command('del')?.status).toBe('done');
    expect(fake.command('appr')).toMatchObject({ status: 'done', result: { approved: STRANGER_KEY, role: 'viewer' } });
    expect(calls.map(([name]) => name)).toEqual(['setReplication', 'putRule', 'runRuleNow', 'deleteRule']);
    expect(fake.approved).toEqual([{ dappId: 'owned-1', publicKey: STRANGER_KEY, role: 'viewer' }]);
    control.stop();
  });

  it('admits operator devices as owner of keeper-owned dapps, but never strangers', async () => {
    const { control, fake } = makeControl();
    fake.lobbies.set('owned-1', [
      { publicKey: OPERATOR_KEY, displayName: 'Phone', inviteId: 'inv', rejoin: false, safetyNumber: '111111', encPublicKey: 'enc' },
      { publicKey: STRANGER_KEY, displayName: 'Friend', inviteId: 'inv', rejoin: false, safetyNumber: '222222', encPublicKey: 'enc' },
    ]);
    fake.lobbies.set(CONTROL_ID, [{ publicKey: STRANGER_KEY, displayName: 'Friend', inviteId: 'inv2', rejoin: false, safetyNumber: '333333' }]);
    await control.ensure();
    await flush();
    expect(fake.approved).toEqual([{ dappId: 'owned-1', publicKey: OPERATOR_KEY, role: 'owner' }]);
    const status = fake.statusRecord();
    const dapps = status?.dapps as Array<{ id: string; lobby: LobbyPeer[] }>;
    expect(dapps.find((dapp) => dapp.id === 'owned-1')?.lobby.map((peer) => peer.publicKey)).toEqual([STRANGER_KEY]);
    expect(dapps.find((dapp) => dapp.id === CONTROL_ID)?.lobby.map((peer) => peer.publicKey)).toEqual([STRANGER_KEY]);
    const info = await control.info();
    expect(info?.lobby.map((peer) => peer.displayName)).toEqual(['Friend']);
    control.stop();
  });

  it('marks its own stale "working" commands failed after a restart', async () => {
    const { control, fake } = makeControl();
    await control.ensure();
    fake.push(CONTROL_ID, { upserts: [{ entityId: 'commands', record: { id: 'stale', status: 'working', _signedBy: KEEPER_KEY, type: 'join-invite' } }], deletes: [] });
    await flush();
    expect(fake.command('stale')).toMatchObject({ status: 'failed' });
    expect(String(fake.command('stale')?.error)).toContain('restarted');
    control.stop();
  });

  it('selects a model from the gateway list and persists it', async () => {
    const { control, fake, aiFake } = makeControl();
    await control.ensure();
    fake.push(CONTROL_ID, commandChange('m1', { type: 'set-model', args: { model: 'chatgpt/gpt-5.6-terra' } }));
    fake.push(CONTROL_ID, commandChange('m2', { type: 'set-model', args: { model: 'made-up' } }));
    await flush();
    await flush();
    expect(fake.command('m1')).toMatchObject({ status: 'done', result: { model: 'chatgpt/gpt-5.6-terra' } });
    expect(aiFake.persistedModels).toEqual(['chatgpt/gpt-5.6-terra']);
    expect(aiFake.ai.llm.model).toBe('chatgpt/gpt-5.6-terra');
    expect(String(fake.command('m2')?.error)).toContain('unknown model');
    expect((fake.statusRecord()?.integrations as { llm: { model: string } }).llm.model).toBe('chatgpt/gpt-5.6-terra');
    control.stop();
  });

  it('creates a dapp with AI, snapshots it, and answers with an invite for every operator', async () => {
    const { control, fake, aiFake } = makeControl({ appUrl: 'https://dapp.example' });
    await control.ensure();
    fake.push(CONTROL_ID, commandChange('c1', { type: 'create-dapp', args: { prompt: 'a shopping list', name: 'Groceries', color: '#ABCDEF' } }));
    await flush();
    await flush();
    await flush();
    const result = fake.command('c1')?.result as Record<string, unknown>;
    expect(fake.command('c1')?.status).toBe('done');
    expect(result).toMatchObject({ dappId: 'generated-groceries', name: 'Groceries', icon: '🧪', revision: 'rev-1' });
    expect(String(result.inviteLink)).toContain('https://dapp.example/invite#code=');
    expect(aiFake.generated[0]).toEqual({ prompt: 'a shopping list', suggested: { name: 'Groceries', color: '#abcdef' } });
    expect(fake.invites).toEqual([{ dappId: 'generated-groceries', uses: 1 }]);
    expect(fake.sources.get('generated-groceries')?.['index.html']).toBe('<!doctype html><p>new</p>');
    control.stop();
  });

  it('edits an owned dapp with a snapshot first, reverts, and refuses the control dapp', async () => {
    const { control, fake, aiFake } = makeControl();
    fake.sources.set('owned-1', { 'index.html': '<!doctype html><p>v1</p>', 'manifest.yaml': 'name: Recipes' });
    await control.ensure();
    fake.push(CONTROL_ID, commandChange('u1', { type: 'update-dapp', args: { dappId: 'owned-1', prompt: 'make it blue' } }));
    fake.push(CONTROL_ID, commandChange('u2', { type: 'update-dapp', args: { dappId: CONTROL_ID, prompt: 'nope' } }));
    fake.push(CONTROL_ID, commandChange('u3', { type: 'update-dapp', args: { dappId: 'owned-1' } }));
    await flush();
    await flush();
    await flush();
    expect(fake.command('u1')).toMatchObject({ status: 'done', result: { dappId: 'owned-1', revision: 'rev-1', changedFiles: ['index.html'] } });
    expect(fake.sources.get('owned-1')?.['index.html']).toBe('<!doctype html><!-- make it blue -->');
    expect(fake.manifestSynced).toEqual(['owned-1']);
    expect(aiFake.generated[0].current?.files['index.html']).toBe('<!doctype html><p>v1</p>');
    expect(String(fake.command('u2')?.error)).toContain('control dapp');
    expect(String(fake.command('u3')?.error)).toContain('"prompt"');

    fake.push(CONTROL_ID, commandChange('r1', { type: 'revert-dapp', args: { dappId: 'owned-1', revision: 'rev-1' } }));
    await flush();
    await flush();
    await flush();
    expect(fake.command('r1')).toMatchObject({ status: 'done', result: { dappId: 'owned-1', restored: 'rev-1', revision: 'rev-2' } });
    expect(fake.sources.get('owned-1')?.['index.html']).toBe('<!doctype html><p>v1</p>');
    await control.tick();
    const dapps = fake.statusRecord()?.dapps as Array<{ id: string; revisions: Array<{ id: string }> }>;
    expect(dapps.find((dapp) => dapp.id === 'owned-1')?.revisions.map((entry) => entry.id)).toEqual(['rev-2', 'rev-1']);
    control.stop();
  });
});
