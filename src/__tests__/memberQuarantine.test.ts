import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';

/**
 * What a device does with a member entry it can neither verify nor disprove.
 *
 * The case that produces one: the device is offline while two devices join and then rename
 * each other. Member entries are last-writer-wins, so each of the two now carries only the
 * OTHER's signature — the founder's original signature is gone from the document, and a
 * device whose verified baseline predates all of it has no way to reach them.
 *
 * It must not delete them. Deleting would destroy real members over a gap in ONE device's
 * knowledge and push that deletion to everyone else, which is what the reverted
 * rebuild-from-the-founder did on 2026-09-18 (`memberCrossSigned.test.ts`). They are left in
 * the document and out of the verified set: no role, no mesh access, records untouched.
 */

const docs = new Map<string, Y.Doc>();
const deviceState = new Map<string, string>();

vi.mock('../services/store/docs.ts', () => ({
  getDappDoc: (dappId: string) => {
    let doc = docs.get(dappId);
    if (!doc) {
      doc = new Y.Doc();
      docs.set(dappId, doc);
    }
    return doc;
  },
}));
vi.mock('../services/identity.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/identity.ts')>(),
  getIdentity: () => ({ displayName: 'Self', publicKey: 'aa'.repeat(32), privateKey: '', deviceId: 'self' }),
}));

const {
  setupAuthObserver, teardownAuthObserver, getVerifiedMembers, getQuarantinedMembers, whenAuthObserversIdle,
} = await import('../services/store/auth.ts');
const { setDeviceLocalStore } = await import('../services/store/deviceStore.ts');
const { getDappDoc } = await import('../services/store/docs.ts');
const { writeSignedMember, yMapFromObject, signWithIdentity } = await import('../services/store/protocolCore.ts');

async function device(name: string) {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  return {
    name,
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: bufferToHex(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  };
}

type Device = Awaited<ReturnType<typeof device>>;

async function addRecord(doc: Y.Doc, entity: string, record: Record<string, unknown>, signer: Device): Promise<void> {
  const signed = { ...record, ...await signWithIdentity(signer, record) };
  let container = doc.getMap('data').get(entity) as Y.Map<unknown> | undefined;
  if (!container) {
    container = new Y.Map<unknown>();
    doc.getMap('data').set(entity, container);
  }
  container.set(String(record.id), signed);
}

/** A session on this device: the observer starts, settles, and is torn down again. */
async function session(dappId: string, run?: () => Promise<void> | void): Promise<void> {
  setupAuthObserver(dappId, { scanDebounceMs: 0 });
  getDappDoc(dappId).getMap('appData').set('nudge', crypto.randomUUID());
  await whenAuthObserversIdle();
  await run?.();
  await whenAuthObserversIdle();
}

beforeEach(() => {
  deviceState.clear();
  setDeviceLocalStore({
    read: (key) => deviceState.get(key) ?? null,
    write: (key, value) => { deviceState.set(key, value); return true; },
    remove: (key) => { deviceState.delete(key); },
  });
});

describe('a member entry this device can neither verify nor disprove', () => {
  it('is kept, ignored and reported — never deleted', async () => {
    const dappId = `quarantine-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);
    const founder = await device('Founder');
    const laptop = await device('Laptop');
    const phone = await device('Phone');

    const meta = new Y.Map<unknown>();
    meta.set('createdBy', founder.publicKey);
    doc.getMap('config').set('meta', meta);
    doc.getMap('members').set(founder.publicKey, yMapFromObject({ publicKey: founder.publicKey, role: 'owner', name: 'Founder' }));

    // Session 1: this device has only ever seen the founder, which becomes its stored baseline.
    await session(dappId);
    expect([...(getVerifiedMembers(dappId)?.keys() ?? [])]).toEqual([founder.publicKey]);
    teardownAuthObserver(dappId);

    // Offline: the founder adds two owner devices, which then rename each other and write data.
    await writeSignedMember(doc, { publicKey: laptop.publicKey, name: 'Laptop', role: 'owner' }, founder);
    await writeSignedMember(doc, { publicKey: phone.publicKey, name: 'Phone', role: 'owner' }, founder);
    await writeSignedMember(doc, { publicKey: phone.publicKey, name: 'Phone (work)', role: 'owner' }, laptop);
    await writeSignedMember(doc, { publicKey: laptop.publicKey, name: 'Laptop (home)', role: 'owner' }, phone);
    await addRecord(doc, 'notes', { id: 'n1', title: 'written by the laptop', createdAt: new Date().toISOString() }, laptop);

    // Session 2: back online, starting from the stored baseline.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await session(dappId);
    warn.mockRestore();

    // Nothing was deleted, and the two are simply not verified here.
    expect([...doc.getMap('members').keys()].sort()).toEqual([founder.publicKey, laptop.publicKey, phone.publicKey].sort());
    expect([...(getVerifiedMembers(dappId)?.keys() ?? [])]).toEqual([founder.publicKey]);
    expect([...getQuarantinedMembers(dappId)].sort()).toEqual([laptop.publicKey, phone.publicKey].sort());
    // Their data is left exactly as it is — reverting it would start a war with every peer
    // that has them verified.
    expect((doc.getMap('data').get('notes') as Y.Map<unknown>).has('n1')).toBe(true);
    teardownAuthObserver(dappId);

    // An owner this device DOES verify touches the entries: that resolves both of them.
    await writeSignedMember(doc, { publicKey: laptop.publicKey, name: 'Laptop (home)', role: 'owner' }, founder);
    await session(dappId, async () => {
      await writeSignedMember(doc, { publicKey: phone.publicKey, name: 'Phone (work)', role: 'owner' }, founder);
    });
    expect([...(getVerifiedMembers(dappId)?.keys() ?? [])].sort())
      .toEqual([founder.publicKey, laptop.publicKey, phone.publicKey].sort());
    expect(getQuarantinedMembers(dappId).size).toBe(0);
  }, 30_000);

  it('still deletes what is provably wrong: unsigned, badly signed, or signed by a known non-owner', async () => {
    const dappId = `quarantine-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);
    const founder = await device('Founder');
    const viewer = await device('Viewer');
    const planted = await device('Planted');
    const forged = await device('Forged');
    const viaViewer = await device('Via viewer');

    const meta = new Y.Map<unknown>();
    meta.set('createdBy', founder.publicKey);
    doc.getMap('config').set('meta', meta);
    doc.getMap('members').set(founder.publicKey, yMapFromObject({ publicKey: founder.publicKey, role: 'owner', name: 'Founder' }));

    await session(dappId);
    await writeSignedMember(doc, { publicKey: viewer.publicKey, name: 'Viewer', role: 'viewer' }, founder);
    await whenAuthObserversIdle();
    teardownAuthObserver(dappId);

    // Written straight into the local database while the app was closed.
    doc.getMap('members').set(planted.publicKey, yMapFromObject({ publicKey: planted.publicKey, role: 'owner', name: 'No signature' }));
    const good = await writeSignedMember(doc, { publicKey: forged.publicKey, name: 'Bad signature', role: 'owner' }, founder).then(
      () => doc.getMap('members').get(forged.publicKey) as Y.Map<unknown>,
    );
    good.set('_signature', 'ff'.repeat(64));
    await writeSignedMember(doc, { publicKey: viaViewer.publicKey, name: 'Added by a viewer', role: 'editor' }, viewer);

    await session(dappId);
    expect([...doc.getMap('members').keys()].sort()).toEqual([founder.publicKey, viewer.publicKey].sort());
    expect(getQuarantinedMembers(dappId).size).toBe(0);
  }, 30_000);
});
