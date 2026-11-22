import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';

/**
 * The verified member baseline persisted per device (review item 1.9).
 *
 * Before it, every session took the member list as the local database happened to hold it, so
 * forged state that got in earlier — a patched build, a mesh push that landed before the first
 * scan — was adopted as history. Now a session starts from the members THIS device verified
 * last time and judges the document against them by the normal rules.
 *
 * The other half of the contract is what must NOT happen: nothing is ever deleted because a
 * baseline is missing, corrupt or does not apply. Those cases fall back to trusting the list as
 * found, exactly as before (and `memberCrossSigned.test.ts` guards the rebuild that must never
 * come back).
 */

const docs = new Map<string, Y.Doc>();

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

const { setupAuthObserver, teardownAuthObserver, getVerifiedMembers, whenAuthObserversIdle } = await import('../services/store/auth.ts');
const { getDappDoc } = await import('../services/store/docs.ts');
const { writeSignedMember, writeSignedMemberRemoval, yMapFromObject, signWithIdentity } = await import('../services/store/protocolCore.ts');
const { clearMemberBaseline, readMemberBaseline } = await import('../services/store/memberBaseline.ts');

async function createDevice(name: string) {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  return {
    name,
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: bufferToHex(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  };
}

type Device = Awaited<ReturnType<typeof createDevice>>;

/** A dapp whose document holds nothing but its founder, as a fresh install does. */
async function seedDapp(): Promise<{ dappId: string; doc: Y.Doc; founder: Device }> {
  const dappId = `baseline-${crypto.randomUUID()}`;
  const doc = getDappDoc(dappId);
  const founder = await createDevice('Founder');
  const meta = new Y.Map<unknown>();
  meta.set('createdBy', founder.publicKey);
  doc.transact(() => {
    doc.getMap('config').set('meta', meta);
    doc.getMap('members').set(founder.publicKey, yMapFromObject({ publicKey: founder.publicKey, role: 'owner', name: founder.name }));
  });
  return { dappId, doc, founder };
}

/** Opens a session and lets the observer settle after `work`; `endSession` is the reload. */
async function session(dappId: string, work: () => Promise<void> | void = () => undefined): Promise<void> {
  setupAuthObserver(dappId, { scanDebounceMs: 0 });
  await work();
  // Nothing to react to otherwise: the observer only scans when the document changes.
  getDappDoc(dappId).getMap('appData').set('nudge', crypto.randomUUID());
  await whenAuthObserversIdle();
}

/** The device is shut down: the in-memory verified set goes, the stored baseline stays. */
function endSession(dappId: string): void {
  teardownAuthObserver(dappId);
}

function memberKeys(dappId: string): string[] {
  return [...getDappDoc(dappId).getMap('members').keys()].sort();
}

function storedKeys(dappId: string): string[] {
  return [...(readMemberBaseline(dappId)?.members.keys() ?? [])].sort();
}

/** What a patched build writes straight into its own database: an entry it signed for itself. */
async function forgeOwnEntry(doc: Y.Doc, device: Device): Promise<void> {
  const payload = { publicKey: device.publicKey, name: device.name, role: 'owner', memberUpdatedAt: new Date().toISOString() };
  const signature = await signWithIdentity(device, payload);
  doc.getMap('members').set(device.publicKey, yMapFromObject({ ...payload, ...signature }));
}

describe('the verified member baseline', () => {
  it('reverts an entry that is in the document but not in the baseline and not owner-signed', async () => {
    const { dappId, doc, founder } = await seedDapp();
    const laptop = await createDevice('Laptop');
    await session(dappId, async () => {
      await writeSignedMember(doc, { publicKey: laptop.publicKey, name: laptop.name, role: 'editor' }, founder);
    });
    const legitimate = [founder.publicKey, laptop.publicKey].sort();
    expect(storedKeys(dappId)).toEqual(legitimate);
    endSession(dappId);

    // Between the sessions, with nothing watching, forged state reaches the local database.
    const attacker = await createDevice('Attacker');
    await forgeOwnEntry(doc, attacker);
    doc.getMap('members').set('unsigned-key', yMapFromObject({ publicKey: 'unsigned-key', role: 'owner', name: 'No Signature' }));
    expect(memberKeys(dappId)).toHaveLength(4);

    await session(dappId);

    expect(memberKeys(dappId)).toEqual(legitimate);
    expect([...(getVerifiedMembers(dappId)?.keys() ?? [])].sort()).toEqual(legitimate);
    expect(storedKeys(dappId)).toEqual(legitimate);
  }, 20_000);

  it('accepts a member an owner added while this device was offline', async () => {
    const { dappId, doc, founder } = await seedDapp();
    await session(dappId);
    expect(storedKeys(dappId)).toEqual([founder.publicKey]);
    endSession(dappId);

    // The owner adds a device elsewhere; the entry arrives over the mesh while this one is shut.
    const phone = await createDevice('Phone');
    await writeSignedMember(doc, { publicKey: phone.publicKey, name: phone.name, role: 'editor' }, founder);

    await session(dappId);

    const expected = [founder.publicKey, phone.publicKey].sort();
    expect(memberKeys(dappId)).toEqual(expected);
    expect([...(getVerifiedMembers(dappId)?.keys() ?? [])].sort()).toEqual(expected);
    // …and the next session starts from the larger set.
    expect(storedKeys(dappId)).toEqual(expected);
  }, 20_000);

  it('accepts a removal that happened while this device was offline — the member does not come back', async () => {
    const { dappId, doc, founder } = await seedDapp();
    const phone = await createDevice('Phone');
    await session(dappId, async () => {
      await writeSignedMember(doc, { publicKey: phone.publicKey, name: phone.name, role: 'editor' }, founder);
    });
    expect(storedKeys(dappId)).toEqual([founder.publicKey, phone.publicKey].sort());
    endSession(dappId);

    await writeSignedMemberRemoval(doc, phone.publicKey, founder, founder.publicKey);

    await session(dappId);

    expect(memberKeys(dappId)).toEqual([founder.publicKey]);
    expect([...(getVerifiedMembers(dappId)?.keys() ?? [])].sort()).toEqual([founder.publicKey]);
    expect(storedKeys(dappId)).toEqual([founder.publicKey]);
    expect([...(readMemberBaseline(dappId)?.tombstones.keys() ?? [])]).toEqual([phone.publicKey]);
  }, 20_000);

  it('deletes nobody when no baseline was ever stored — the list as found, as before', async () => {
    const { dappId, doc, founder } = await seedDapp();
    const laptop = await createDevice('Laptop');
    await session(dappId, async () => {
      await writeSignedMember(doc, { publicKey: laptop.publicKey, name: laptop.name, role: 'editor' }, founder);
    });
    endSession(dappId);
    const attacker = await createDevice('Attacker');
    await forgeOwnEntry(doc, attacker);
    // The device forgot the dapp (a purge) — first sight again.
    clearMemberBaseline(dappId);

    await session(dappId);

    const everyone = [founder.publicKey, laptop.publicKey, attacker.publicKey].sort();
    expect(memberKeys(dappId)).toEqual(everyone);
    expect([...(getVerifiedMembers(dappId)?.keys() ?? [])].sort()).toEqual(everyone);
  }, 20_000);

  it('deletes nobody when the stored baseline is corrupt', async () => {
    const { dappId, doc, founder } = await seedDapp();
    const laptop = await createDevice('Laptop');
    await session(dappId, async () => {
      await writeSignedMember(doc, { publicKey: laptop.publicKey, name: laptop.name, role: 'editor' }, founder);
    });
    endSession(dappId);
    const attacker = await createDevice('Attacker');
    await forgeOwnEntry(doc, attacker);

    for (const damaged of ['{"version":1,"members":', '{"version":1,"members":{"a":{"nested":{"x":1}}},"memberTombstones":{}}', '{"version":99,"members":{},"memberTombstones":{}}']) {
      localStorage.setItem(`vibedapp:members:${dappId}`, damaged);
      expect(readMemberBaseline(dappId)).toBeNull();
      await session(dappId);
      const everyone = [founder.publicKey, laptop.publicKey, attacker.publicKey].sort();
      expect(memberKeys(dappId)).toEqual(everyone);
      expect([...(getVerifiedMembers(dappId)?.keys() ?? [])].sort()).toEqual(everyone);
      endSession(dappId);
    }
  }, 20_000);
});
