// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';

/**
 * The Code App source is synced to every member, and the mesh applies what any member
 * sends. Before seals, a viewer on a patched client could rewrite index.html and the
 * manifest, and the new code ran everywhere — on an owner's device with owner rights.
 * These tests play that member against the seal.
 */

interface Device { publicKey: string; privateKey: string }

const state = vi.hoisted(() => ({
  docs: new Map<string, unknown>(),
  me: { publicKey: '', privateKey: '' },
  roles: new Map<string, string>(),
  formerOwners: new Map<string, number>(),
  membersKnown: true,
  founder: '',
}));

function docOf(key: string): Y.Doc {
  let doc = state.docs.get(key) as Y.Doc | undefined;
  if (!doc) {
    doc = new Y.Doc();
    state.docs.set(key, doc);
  }
  return doc;
}

vi.mock('../services/store/docs.ts', () => ({
  getDappDoc: (dappId: string) => docOf(`${dappId}:main`),
  getDappSourceDoc: (dappId: string) => docOf(`${dappId}:source`),
  getDappSourcePersistence: () => null,
}));
vi.mock('../services/store/auth.ts', () => ({
  requireRole: (_dappId: string, role: string) => {
    if (state.roles.get(state.me.publicKey) !== role) throw new Error('auth: not permitted');
  },
  getRole: (_dappId: string, publicKey: string) => state.roles.get(publicKey) ?? null,
  getVerifiedMembers: () => (state.membersKnown ? new Map() : null),
  formerOwnerUntil: (_dappId: string, publicKey: string) => Promise.resolve(state.formerOwners.get(publicKey) ?? null),
  onVerifiedMembersChange: () => () => undefined,
  getFounder: () => state.founder || undefined,
}));
vi.mock('../services/identity.ts', () => ({
  getIdentity: () => ({ publicKey: state.me.publicKey, displayName: 'me' }),
  getSigningIdentity: () => Promise.resolve(state.me),
}));

const { replaceCodeAppFiles, setCodeAppFile } = await import('../services/store/source.ts');
const {
  SOURCE_SEAL_POLICY, SOURCE_SEAL_TIMINGS, clearSourceSealMemory, forgetSourceSeal, getRunnableCodeAppFile, getSourceSealState, sealSourceNow,
  subscribeSourceSeal, watchSourceSeal,
} = await import('../services/store/sourceSeal.ts');
const { setDeviceLocalStore } = await import('../services/store/deviceStore.ts');

async function device(): Promise<Device> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  return {
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: bufferToHex(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  };
}

const manifest = (extra = '') => `name: Notes\nroutes:\n  - path: /\n    label: Home\n${extra}`;
const GOOD = { 'index.html': '<h1>notes</h1>', 'manifest.yaml': manifest() };
const EVIL_MANIFEST = manifest('permissions:\n  network:\n    connect:\n      - https://evil.example\n');

/** What a member on a patched client does: write straight into the synced doc. */
function tamper(dappId: string, path: string, content: string): void {
  const text = docOf(`${dappId}:source`).getMap<Y.Text>('files').get(path);
  if (!text) throw new Error('no such file');
  text.delete(0, text.length);
  text.insert(0, content);
}

const status = (dappId: string) => getSourceSealState(dappId).status;
const until = (check: () => void) => vi.waitFor(check, { timeout: 4000, interval: 20 });

let owner: Device;
let otherOwner: Device;
let viewer: Device;
let dappId: string;

beforeAll(async () => {
  [owner, otherOwner, viewer] = await Promise.all([device(), device(), device()]);
});

beforeEach(() => {
  localStorage.clear();
  state.roles = new Map([[owner.publicKey, 'owner'], [otherOwner.publicKey, 'owner'], [viewer.publicKey, 'viewer']]);
  state.formerOwners.clear();
  state.membersKnown = true;
  state.me = owner;
  state.founder = owner.publicKey; // the device that creates the app in `sealedApp`
  SOURCE_SEAL_TIMINGS.restoreGraceMs = 60_000; // restoring is tested on its own
  SOURCE_SEAL_POLICY.enforce = true; // the shipped default; the last describe covers the emergency switch
  dappId = `seal-${crypto.randomUUID()}`;
});

/** An owner creates the app on this device and the seal lands. */
async function sealedApp(): Promise<void> {
  replaceCodeAppFiles(dappId, GOOD);
  await until(() => expect(status(dappId)).toBe('sealed'));
}

/** Same synced state, fresh process: what a reload (or another device) sees. */
function reloadAs(who: Device): void {
  forgetSourceSeal(dappId);
  state.me = who;
  watchSourceSeal(dappId);
}

describe('source seal', () => {
  it('seals every owner write, and members run exactly that', async () => {
    await sealedApp();
    setCodeAppFile(dappId, 'index.html', '<h1>notes v2</h1>');
    await until(() => expect(getRunnableCodeAppFile(dappId, 'index.html')).toBe('<h1>notes v2</h1>'));
    expect(status(dappId)).toBe('sealed');

    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('sealed'));
    expect(getRunnableCodeAppFile(dappId, 'index.html')).toBe('<h1>notes v2</h1>');
  });

  it('keeps running the sealed version when a member rewrites the code — and its manifest grants itself nothing', async () => {
    await sealedApp();
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('sealed'));

    tamper(dappId, 'index.html', '<script>steal()</script>');
    tamper(dappId, 'manifest.yaml', EVIL_MANIFEST);
    await until(() => expect(status(dappId)).toBe('held'));

    expect(getRunnableCodeAppFile(dappId, 'index.html')).toBe(GOOD['index.html']);
    expect(getRunnableCodeAppFile(dappId, 'manifest.yaml')).not.toContain('evil.example');
    expect(getSourceSealState(dappId).reason).toMatch(/changed after an owner sealed it/);
  });

  it('runs nothing after a reload of tampered source, also when the member deleted or forged the seal', async () => {
    await sealedApp();
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('sealed')); // this device has seen a seal for the app

    tamper(dappId, 'index.html', '<script>steal()</script>');
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('blocked'));
    expect(getRunnableCodeAppFile(dappId, 'index.html')).toBe('');
    expect(getRunnableCodeAppFile(dappId, 'manifest.yaml')).toBe(''); // no manifest, no permissions

    // Deleting the seal is no way back to "unsealed legacy app".
    docOf(`${dappId}:source`).getMap('seal').delete('current');
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('blocked'));

    // Neither is sealing it with the member's own key: sealSourceNow refuses, a hand-made seal is rejected.
    expect(await sealSourceNow(dappId)).toBe(false);
    state.roles.set(viewer.publicKey, 'owner'); // only to MAKE the forged seal…
    expect(await sealSourceNow(dappId)).toBe(true);
    state.roles.set(viewer.publicKey, 'viewer'); // …which every device judges by the real role
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('blocked'));
    expect(getSourceSealState(dappId).reason).toMatch(/not signed by an owner/);
  });

  it('lets an owner device put the sealed source back, which heals everyone', async () => {
    await sealedApp();
    SOURCE_SEAL_TIMINGS.restoreGraceMs = 150;
    tamper(dappId, 'index.html', '<script>steal()</script>');
    await until(() => expect(status(dappId)).toBe('held'));
    await until(() => expect(status(dappId)).toBe('sealed'));
    expect(docOf(`${dappId}:source`).getMap<Y.Text>('files').get('index.html')?.toJSON()).toBe(GOOD['index.html']);
  });

  it('does not fight another owner: its write is held only until its seal arrives', async () => {
    await sealedApp();
    SOURCE_SEAL_TIMINGS.restoreGraceMs = 400;
    // The other owner's write reaches this device first…
    tamper(dappId, 'index.html', '<h1>by the other owner</h1>');
    await until(() => expect(status(dappId)).toBe('held'));
    // …its seal a moment later.
    state.me = otherOwner;
    expect(await sealSourceNow(dappId)).toBe(true);
    state.me = owner;
    await until(() => expect(status(dappId)).toBe('sealed'));
    await new Promise((resolve) => setTimeout(resolve, 500)); // past the restore grace
    expect(getRunnableCodeAppFile(dappId, 'index.html')).toBe('<h1>by the other owner</h1>');
  });

  it('still accepts what an owner sealed before it left, and an app from before seals existed', async () => {
    await sealedApp();
    state.roles.delete(owner.publicKey);
    state.formerOwners.set(owner.publicKey, Date.now() + 1_000); // owner until a moment from now
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('sealed'));

    // A dapp this device never saw a seal for: runs as before (owner devices seal it on first open).
    const legacy = `legacy-${crypto.randomUUID()}`;
    const files = docOf(`${legacy}:source`).getMap<Y.Text>('files');
    for (const [path, content] of Object.entries(GOOD)) files.set(path, new Y.Text(content));
    watchSourceSeal(legacy);
    await until(() => expect(status(legacy)).toBe('legacy'));
    expect(getRunnableCodeAppFile(legacy, 'index.html')).toBe(GOOD['index.html']);

    // An owner device opening it signs nothing it never verified — its first write seals it.
    forgetSourceSeal(legacy);
    state.me = owner;
    state.roles.set(owner.publicKey, 'owner');
    watchSourceSeal(legacy);
    await until(() => expect(status(legacy)).toBe('legacy'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(docOf(`${legacy}:source`).getMap('seal').get('current')).toBeUndefined();
    setCodeAppFile(legacy, 'index.html', '<h1>notes v2</h1>');
    await until(() => expect(status(legacy)).toBe('sealed'));
  });

  it('treats a fresh joiner that does not know the owners yet as still loading, not as tampering', async () => {
    await sealedApp();
    state.membersKnown = false;
    state.roles.clear();
    clearSourceSealMemory(dappId); // a joiner has never verified a seal for this app
    reloadAs(viewer);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(status(dappId)).toBe('pending');
  });
});

/**
 * 2026-09-23: a dapp's id is device-local — every join picks its own UUID for the catalog
 * entry — but the seal was only accepted when its `dappId` equalled the local one. Every seal
 * written on ANOTHER device read as "no seal", and the keeper and a browser (both owners)
 * restored each other's source every ~4 s. Two local ids over the same documents are two
 * devices here.
 */
describe('source seal, across devices', () => {
  const sealOf = (id: string) => docOf(`${id}:source`).getMap('seal').get('current') as { _signedBy: string } | undefined;
  const textOf = (id: string, path: string) => docOf(`${id}:source`).getMap<Y.Text>('files').get(path);

  /** The same dapp, known on the other device under its own id. */
  function sameDappElsewhere(): string {
    const otherId = `seal-${crypto.randomUUID()}`;
    state.docs.set(`${otherId}:source`, docOf(`${dappId}:source`));
    state.docs.set(`${otherId}:main`, docOf(`${dappId}:main`));
    return otherId;
  }

  it('accepts a seal written on a device that knows the dapp under another id', async () => {
    await sealedApp();
    const elsewhere = sameDappElsewhere();
    state.me = otherOwner;
    watchSourceSeal(elsewhere);
    await until(() => expect(status(elsewhere)).toBe('sealed'));
    await new Promise((resolve) => setTimeout(resolve, 300)); // an owner device that doubted the seal would re-sign it
    expect(sealOf(elsewhere)?._signedBy).toBe(owner.publicKey);
  });

  it('follows an owner edit made on the other device instead of restoring its own snapshot', async () => {
    await sealedApp();
    const elsewhere = sameDappElsewhere();
    SOURCE_SEAL_TIMINGS.restoreGraceMs = 150;
    state.me = otherOwner;
    watchSourceSeal(elsewhere);
    await until(() => expect(status(elsewhere)).toBe('sealed'));

    state.me = owner;
    setCodeAppFile(dappId, 'index.html', '<h1>edited on the first device</h1>');
    await until(() => expect(sealOf(dappId)?._signedBy).toBe(owner.publicKey));
    state.me = otherOwner;
    await until(() => expect(getRunnableCodeAppFile(elsewhere, 'index.html')).toBe('<h1>edited on the first device</h1>'));
    await new Promise((resolve) => setTimeout(resolve, 400)); // past the restore grace
    expect(textOf(elsewhere, 'index.html')?.toJSON()).toBe('<h1>edited on the first device</h1>');
    expect(status(elsewhere)).toBe('sealed');
  });
});

/**
 * 2026-09-23: owner devices "repaired" a seal by a key they could not place, or by a member
 * without the owner role, by signing the LIVE files. A member sealed its own rewrite with a
 * throwaway key, and the owner device (the always-on keeper) signed it for everyone.
 */
describe('source seal, only what an owner verified is signed', () => {
  const sealOf = (id: string) => docOf(`${id}:source`).getMap('seal').get('current') as { _signedBy: string } | undefined;

  for (const signer of ['a viewer', 'a key that is no member'] as const) {
    it(`does not sign a rewrite that ${signer} sealed — it puts its verified version back`, async () => {
      await sealedApp();
      SOURCE_SEAL_TIMINGS.restoreGraceMs = 150;
      const forger = signer === 'a viewer' ? viewer : await device();
      tamper(dappId, 'index.html', '<script>steal()</script>');
      state.me = forger;
      state.roles.set(forger.publicKey, 'owner'); // only to MAKE the seal…
      expect(await sealSourceNow(dappId)).toBe(true);
      if (forger === viewer) state.roles.set(viewer.publicKey, 'viewer'); else state.roles.delete(forger.publicKey);
      state.me = owner;

      await until(() => expect(docOf(`${dappId}:source`).getMap<Y.Text>('files').get('index.html')?.toJSON()).toBe(GOOD['index.html']));
      await until(() => expect(sealOf(dappId)?._signedBy).toBe(owner.publicKey));
      expect(getRunnableCodeAppFile(dappId, 'index.html')).toBe(GOOD['index.html']);
    });
  }

  it('signs nothing on first sight, where it has nothing verified to vouch for', async () => {
    await sealedApp();
    const stranger = await device();
    tamper(dappId, 'index.html', '<script>steal()</script>');
    state.me = stranger;
    state.roles.set(stranger.publicKey, 'owner');
    expect(await sealSourceNow(dappId)).toBe(true);
    state.roles.delete(stranger.publicKey);
    clearSourceSealMemory(dappId); // an owner device that never saw this dapp
    reloadAs(otherOwner);
    await until(() => expect(status(dappId)).toBe('legacy'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sealOf(dappId)?._signedBy).toBe(stranger.publicKey);
  });
});

/**
 * The genesis (`dappGenesis.ts`) binds a seal to its dapp: dapp ids are device-local, so before
 * it a member of two dapps that share an owner could copy one's sealed source into the other.
 */
describe('source seal, bound to its dapp', () => {
  type Seal = { v: number; genesis?: string; _signedBy: string };
  const sealOf = (id: string) => docOf(`${id}:source`).getMap('seal').get('current') as Seal | undefined;

  /** Another app on the same devices, created (and so founded) by the same owner. */
  async function secondApp(content: string): Promise<string> {
    const other = `seal-${crypto.randomUUID()}`;
    replaceCodeAppFiles(other, { ...GOOD, 'index.html': content });
    await until(() => expect(sealOf(other)?.v).toBe(2));
    return other;
  }

  /** What a member of both apps does: copy one app's files and seal into the other. */
  function copySource(from: string, to: string): void {
    const source = docOf(`${from}:source`);
    const target = docOf(`${to}:source`);
    source.getMap<Y.Text>('files').forEach((text, path) => tamper(to, path, text.toJSON()));
    target.getMap('seal').set('current', { ...(source.getMap('seal').get('current') as object) });
  }

  it("seals new apps with the founder's genesis", async () => {
    await sealedApp();
    await until(() => expect(sealOf(dappId)?.v).toBe(2));
    expect(sealOf(dappId)?.genesis).toBe((docOf(`${dappId}:main`).getMap('config').get('genesis') as { id: string }).id);
  });

  it("does not run another app's sealed source, on a device that verified this app or sees it for the first time", async () => {
    await sealedApp();
    await until(() => expect(sealOf(dappId)?.v).toBe(2));
    const other = await secondApp('<h1>the other app</h1>');
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('sealed'));

    copySource(other, dappId);
    await until(() => expect(status(dappId)).toBe('held'));
    expect(getSourceSealState(dappId).reason).toMatch(/belongs to another app/);
    expect(getRunnableCodeAppFile(dappId, 'index.html')).toBe(GOOD['index.html']);

    forgetSourceSeal(dappId);
    localStorage.clear(); // a fresh device: it pins the genesis in the doc
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('blocked'));
  });

  it('does not take an unbound seal for new content once it verified a bound one', async () => {
    await sealedApp();
    await until(() => expect(sealOf(dappId)?.v).toBe(2));
    state.founder = ''; // an app whose founder is gone has no genesis: its seals stay unbound
    const unbound = `seal-${crypto.randomUUID()}`;
    replaceCodeAppFiles(unbound, { ...GOOD, 'index.html': '<h1>unbound</h1>' });
    await until(() => expect(sealOf(unbound)?.v).toBe(1));
    state.founder = owner.publicKey;
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('sealed'));

    copySource(unbound, dappId);
    await until(() => expect(status(dappId)).toBe('held'));
    expect(getSourceSealState(dappId).reason).toMatch(/not bound to this app/);
  });

  it('upgrades an existing unbound seal without interrupting anybody', async () => {
    state.founder = ''; // sealed before genesis existed
    await sealedApp();
    expect(sealOf(dappId)?.v).toBe(1);
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('sealed'));

    state.founder = owner.publicKey; // the founder's device opens it with this build
    reloadAs(owner);
    await until(() => expect(sealOf(dappId)?.v).toBe(2));
    expect(sealOf(dappId)?._signedBy).toBe(owner.publicKey);
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('sealed'));
    expect(getRunnableCodeAppFile(dappId, 'index.html')).toBe(GOOD['index.html']);
  });

  it("puts a deleted genesis back from the founder's device", async () => {
    await sealedApp();
    const config = docOf(`${dappId}:main`).getMap('config');
    await until(() => expect(config.get('genesis')).toBeDefined());
    const genesis = JSON.stringify(config.get('genesis'));
    config.delete('genesis');
    await until(() => expect(JSON.stringify(config.get('genesis'))).toBe(genesis));
  });
});

describe('source seal, restoring', () => {
  const textOf = (path: string) => docOf(`${dappId}:source`).getMap<Y.Text>('files').get(path);

  beforeEach(() => {
    SOURCE_SEAL_TIMINGS.restoreGraceMs = 100;
    SOURCE_SEAL_TIMINGS.repairIntervalMs = 30_000;
  });

  it('only re-seals when the files are still what it verified — no source rewrite', async () => {
    await sealedApp();
    const before = textOf('index.html');
    docOf(`${dappId}:source`).getMap('seal').delete('current'); // the files are fine, the seal is gone
    await until(() => expect(docOf(`${dappId}:source`).getMap('seal').get('current')).toBeDefined()); // re-signed
    expect(status(dappId)).toBe('sealed'); // it never stopped running what it verified
    expect(textOf('index.html')).toBe(before); // the same Y.Text: nothing was rewritten
  });

  it('puts the source back at most once per interval, whatever keeps rewriting it', async () => {
    await sealedApp();
    const sealedAt = () => (docOf(`${dappId}:source`).getMap('seal').get('current') as { sealedAt: string }).sealedAt;
    const firstSeal = sealedAt();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      tamper(dappId, 'index.html', '<script>one()</script>');
      await until(() => expect(textOf('index.html')?.toJSON()).toBe(GOOD['index.html']));
      await until(() => expect(sealedAt()).not.toBe(firstSeal)); // the restore's own seal landed
      tamper(dappId, 'index.html', '<script>two()</script>');
      await until(() => expect(status(dappId)).toBe('held'));
      await new Promise((resolve) => setTimeout(resolve, 400)); // several restore graces
      expect(textOf('index.html')?.toJSON()).toBe('<script>two()</script>');
      expect(getRunnableCodeAppFile(dappId, 'index.html')).toBe(GOOD['index.html']); // still runs the verified version
      expect(warn.mock.calls.filter(([message]) => String(message).includes('restoring'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * 2026-09-18: a dapp whose founder had left carried a seal signed by a key that was no member
 * any more and had no tombstone proving it once was an owner, so every device blocked it and the
 * seal had to be switched off. Since 2026-09-22 a seal survives the loss of its signer.
 */
describe('source seal, after its signer is gone', () => {
  /** The reported case: the founder sealed the app and is gone, with no tombstone to prove it was an owner. */
  function founderLeft(): void {
    state.roles.delete(owner.publicKey);
    state.formerOwners.delete(owner.publicKey);
  }
  const sealOf = (id: string) => docOf(`${id}:source`).getMap('seal').get('current') as { _signedBy: string } | undefined;

  it('keeps running on a device that verified the seal while the founder was an owner', async () => {
    await sealedApp();
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('sealed'));
    founderLeft();
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('sealed'));
    expect(getRunnableCodeAppFile(dappId, 'index.html')).toBe(GOOD['index.html']);
  });

  it('runs as legacy on a device that never verified a seal, as it would without one', async () => {
    await sealedApp();
    founderLeft();
    clearSourceSealMemory(dappId); // a device that sees this dapp for the first time
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('legacy'));
    expect(getRunnableCodeAppFile(dappId, 'index.html')).toBe(GOOD['index.html']);
  });

  it('is re-signed by a remaining owner that verified it, which makes it sealed again for fresh devices', async () => {
    await sealedApp();
    reloadAs(otherOwner);
    await until(() => expect(status(dappId)).toBe('sealed')); // verified while the founder was an owner
    founderLeft();
    reloadAs(otherOwner);
    await until(() => expect(sealOf(dappId)?._signedBy).toBe(otherOwner.publicKey));
    await until(() => expect(status(dappId)).toBe('sealed'));

    clearSourceSealMemory(dappId);
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('sealed'));
  });

  it('still blocks tampered source sealed by an unknown key on a device that verified the real seal', async () => {
    await sealedApp();
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('sealed'));

    const stranger = await device();
    tamper(dappId, 'manifest.yaml', EVIL_MANIFEST);
    state.me = stranger;
    state.roles.set(stranger.publicKey, 'owner'); // only to MAKE the forged seal…
    expect(await sealSourceNow(dappId)).toBe(true);
    state.roles.delete(stranger.publicKey); // …by a key that is no member at all
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('blocked'));
    expect(getRunnableCodeAppFile(dappId, 'manifest.yaml')).toBe('');
  });

  it('blocks a seal signed by a current member that is not an owner, also on first sight', async () => {
    await sealedApp();
    tamper(dappId, 'manifest.yaml', EVIL_MANIFEST);
    state.me = viewer;
    state.roles.set(viewer.publicKey, 'owner');
    expect(await sealSourceNow(dappId)).toBe(true);
    state.roles.set(viewer.publicKey, 'viewer');
    clearSourceSealMemory(dappId);
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('blocked'));
  });

  it('does not answer the seal of another owner over content it does not have', async () => {
    await sealedApp();
    state.me = otherOwner;
    await sealSourceNow(dappId);
    await until(() => expect(sealOf(dappId)?._signedBy).toBe(otherOwner.publicKey));
    const before = JSON.stringify(sealOf(dappId));

    state.me = owner;
    tamper(dappId, 'index.html', '<h1>not what the other owner sealed</h1>');
    await until(() => expect(status(dappId)).toBe('held'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(JSON.stringify(sealOf(dappId))).toBe(before); // no answering seal write
  });

  it('keeps its memory in the device store, where the keeper persists it', async () => {
    const stored = new Map<string, string>();
    setDeviceLocalStore({
      read: (key) => stored.get(key) ?? null,
      write: (key, value) => { stored.set(key, value); },
      remove: (key) => { stored.delete(key); },
    });
    try {
      await sealedApp();
      expect([...stored.keys()].some((key) => key.endsWith(dappId))).toBe(true);
      expect(localStorage.length).toBe(0);
      founderLeft();
      reloadAs(viewer);
      await until(() => expect(status(dappId)).toBe('sealed'));
    } finally {
      setDeviceLocalStore(null);
    }
  });
});

/**
 * The emergency switch: with enforcement off the seal is still written and checked, but it
 * does not decide what runs (the setting shipped from 2026-09-18 to 2026-09-22).
 */
describe('source seal, enforcement off', () => {
  beforeEach(() => {
    SOURCE_SEAL_POLICY.enforce = false;
  });

  /** The reported case: the founder sealed the app and is gone, with no tombstone to prove it was an owner. */
  function founderLeft(): void {
    state.roles.delete(owner.publicKey);
    state.formerOwners.delete(owner.publicKey);
  }

  it('runs an app whose founder has left, on a device that cannot vouch for the seal', async () => {
    await sealedApp();
    founderLeft();
    clearSourceSealMemory(dappId);
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('legacy'));
    expect(getRunnableCodeAppFile(dappId, 'index.html')).toBe(GOOD['index.html']);
  });

  it('lets any remaining owner re-sign such an app, which makes it sealed again for everyone', async () => {
    await sealedApp();
    founderLeft();
    reloadAs(otherOwner);
    await until(() => expect(status(dappId)).toBe('sealed'));

    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('sealed'));
  });

  it('still prefers a seal that does verify', async () => {
    await sealedApp();
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('sealed'));
  });

  /**
   * The 2026-09-18 flicker: re-sealing on ANY failed verdict made two owner devices answer
   * each other's seal write with their own for ever (~4 source updates/second on every dapp
   * that had an owner peer), and because the published snapshot was compared by object
   * identity every one of those writes tore the Code App's iframe down and up again.
   */
  const sealOf = (id: string) => docOf(`${id}:source`).getMap('seal').get('current') as { sealedAt: string; _signedBy: string } | undefined;

  it('does not answer ANOTHER owner\'s seal over content it does not have — the loop that caused the flicker', async () => {
    await sealedApp();
    // The seal in the doc is another owner's, and the live source does not match it: exactly
    // what device A sees a moment after device B sealed its own copy.
    state.me = otherOwner;
    await sealSourceNow(dappId);
    await until(() => expect(sealOf(dappId)?._signedBy).toBe(otherOwner.publicKey));
    const before = sealOf(dappId);

    state.me = owner;
    tamper(dappId, 'index.html', '<h1>not what the other owner sealed</h1>');
    await until(() => expect(status(dappId)).toBe('legacy'));
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(sealOf(dappId)?.sealedAt).toBe(before?.sealedAt); // no answering seal write
    expect(sealOf(dappId)?._signedBy).toBe(otherOwner.publicKey);
  });

  it('never re-signs a seal this device signed itself', async () => {
    await sealedApp();
    const before = sealOf(dappId);
    state.roles.clear(); // this device cannot vouch for anybody, including its own past self
    state.roles.set(owner.publicKey, 'owner');
    forgetSourceSeal(dappId);
    state.roles.delete(owner.publicKey);
    state.roles.set(owner.publicKey, 'owner');
    watchSourceSeal(dappId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sealOf(dappId)?.sealedAt).toBe(before?.sealedAt);
  });

  it('does not notify the runtime when a seal write leaves the runnable files unchanged', async () => {
    await sealedApp();
    let notifications = 0;
    const stop = subscribeSourceSeal(dappId, () => { notifications += 1; });
    const files = getSourceSealState(dappId).files;

    // Another owner re-seals the very same content: a new, valid seal over an unchanged source.
    state.me = otherOwner;
    expect(await sealSourceNow(dappId)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sealOf(dappId)?._signedBy).toBe(otherOwner.publicKey); // the write really happened

    expect(notifications).toBe(0);
    expect(getSourceSealState(dappId).files).toBe(files); // same object — no iframe rebuild
    stop();
  });

  // What this costs while enforcement is off — the hole the seal was built to close.
  it('runs source a member rewrote, instead of holding or blocking it', async () => {
    await sealedApp();
    state.me = viewer;
    tamper(dappId, 'manifest.yaml', EVIL_MANIFEST);
    reloadAs(viewer);
    await until(() => expect(status(dappId)).toBe('legacy'));
    expect(getRunnableCodeAppFile(dappId, 'manifest.yaml')).toBe(EVIL_MANIFEST);
  });
});
