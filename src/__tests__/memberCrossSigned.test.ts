import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';

/**
 * Guard against a design that looks right and deletes real members (tried and reverted on
 * 2026-09-18, review item 1.9): "rebuild the member list from the founder on every session and
 * drop what does not chain back to it".
 *
 * Member entries are last-writer-wins. Once two owners have edited each other's entry — a
 * rename, a role change — each entry carries only its LATEST signer: A is signed by B and B by
 * A. The original "the founder added A" signature is no longer in the document, so no walk from
 * the founder reaches either of them. Any check that runs at the start of a session has to
 * keep such members.
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
const { writeSignedMember, yMapFromObject } = await import('../services/store/protocolCore.ts');

async function createDevice(name: string) {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  return {
    name,
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: bufferToHex(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  };
}

describe('owners that have edited each other', () => {
  it('stay members when a new session starts, and so does everyone they added', async () => {
    const dappId = `cross-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);
    const founder = await createDevice('NAS Keeper');
    const laptop = await createDevice('Laptop');
    const phone = await createDevice('Phone');
    const tablet = await createDevice('Tablet');

    const meta = new Y.Map<unknown>();
    meta.set('createdBy', founder.publicKey);
    doc.getMap('config').set('meta', meta);
    doc.getMap('members').set(founder.publicKey, yMapFromObject({ publicKey: founder.publicKey, role: 'owner', name: founder.name }));

    setupAuthObserver(dappId, { scanDebounceMs: 0 });
    // The founder lets two owner devices in…
    await writeSignedMember(doc, { publicKey: laptop.publicKey, name: laptop.name, role: 'owner' }, founder);
    await writeSignedMember(doc, { publicKey: phone.publicKey, name: phone.name, role: 'owner' }, founder);
    await whenAuthObserversIdle();
    // …which later rename each other, and one of them adds a third device.
    await writeSignedMember(doc, { publicKey: phone.publicKey, name: 'Phone (work)', role: 'owner' }, laptop);
    await writeSignedMember(doc, { publicKey: laptop.publicKey, name: 'Laptop (home)', role: 'owner' }, phone);
    await writeSignedMember(doc, { publicKey: tablet.publicKey, name: tablet.name, role: 'editor' }, laptop);
    await whenAuthObserversIdle();
    const everyone = [founder, laptop, phone, tablet].map((device) => device.publicKey).sort();
    expect([...doc.getMap('members').keys()].sort()).toEqual(everyone);

    // A reload: the observer starts over on the document as it is.
    teardownAuthObserver(dappId);
    setupAuthObserver(dappId, { scanDebounceMs: 0 });
    doc.getMap('appData').set('nudge', '1');
    await whenAuthObserversIdle();

    expect([...doc.getMap('members').keys()].sort()).toEqual(everyone);
    expect([...(getVerifiedMembers(dappId)?.keys() ?? [])].sort()).toEqual(everyone);
  }, 20_000);
});
