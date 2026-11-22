import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';

/**
 * Two ways a removal used to be decided by the wrong party:
 *  - `config.meta.createdBy` (the unremovable founder) is writable by every member,
 *    so a co-owner could name itself founder and then remove the real one;
 *  - precedence is wall-clock based, so a device whose clock ran behind the last
 *    writer's produced removals / deletes that every peer silently undid.
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
vi.mock('../services/store/rotation.ts', () => ({ rotateDappCredentials: vi.fn() }));

interface TestIdentity { publicKey: string; signPrivateHex: string }
let currentIdentity: TestIdentity;

vi.mock('../services/identity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/identity.ts')>();
  return {
    ...actual,
    getIdentity: () => ({ displayName: 'test', publicKey: currentIdentity.publicKey, deviceId: 'd', encPublicKey: 'unused' }),
    getSigningIdentity: () => Promise.resolve({ publicKey: currentIdentity.publicKey, privateKey: currentIdentity.signPrivateHex }),
  };
});

const { setupAuthObserver, getFounder } = await import('../services/store/auth.ts');
const {
  foundingOwnerOf, signWithIdentity, timestampAfter, writeSignedMember, writeSignedMemberRemoval, writeSignedRecordTombstone, yMapFromObject,
} = await import('../services/store/protocolCore.ts');
const { getDappDoc } = await import('../services/store/docs.ts');

async function createTestIdentity(): Promise<TestIdentity> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  return {
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', pair.publicKey)),
    signPrivateHex: bufferToHex(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  };
}

const signingOf = (identity: TestIdentity) => ({ publicKey: identity.publicKey, privateKey: identity.signPrivateHex });
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
const minutesAhead = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

let founder: TestIdentity;
let coOwner: TestIdentity;
let dappId: string;
let doc: Y.Doc;

beforeEach(async () => {
  docs.clear();
  founder = await createTestIdentity();
  coOwner = await createTestIdentity();
  currentIdentity = founder;
  dappId = `pin-${crypto.randomUUID()}`;
  doc = getDappDoc(dappId);
  const meta = new Y.Map<unknown>();
  meta.set('createdBy', founder.publicKey);
  doc.getMap('config').set('meta', meta);
  doc.getMap('members').set(founder.publicKey, yMapFromObject({ publicKey: founder.publicKey, name: 'Founder', role: 'owner' }));
  doc.getMap('data').set('items', new Y.Map());
  await writeSignedMember(doc, { publicKey: coOwner.publicKey, name: 'Co-owner', role: 'owner' }, signingOf(founder));
  setupAuthObserver(dappId, { scanDebounceMs: 10 });
  doc.getMap('appData').set('ping', '1');
  await settle();
});

describe('founder pin', () => {
  it('puts the founder back when a co-owner names itself founder, and keeps refusing the founder\'s removal', async () => {
    expect(getFounder(dappId)).toBe(founder.publicKey);

    const meta = doc.getMap('config').get('meta') as Y.Map<unknown>;
    doc.transact(() => { meta.set('createdBy', coOwner.publicKey); });
    // With the doc now "saying" the co-owner founded the dapp, its removal of the real founder
    // is formally an owner removing a non-founder.
    await writeSignedMemberRemoval(doc, founder.publicKey, signingOf(coOwner));
    await settle();
    await settle();

    expect(foundingOwnerOf(doc)).toBe(founder.publicKey);
    expect(doc.getMap('members').has(founder.publicKey)).toBe(true);
    expect(doc.getMap('memberTombstones').has(founder.publicKey)).toBe(false);
  });

  it('still lets the founder remove that co-owner afterwards', async () => {
    const meta = doc.getMap('config').get('meta') as Y.Map<unknown>;
    doc.transact(() => { meta.set('createdBy', coOwner.publicKey); });
    await settle();
    await writeSignedMemberRemoval(doc, coOwner.publicKey, signingOf(founder), getFounder(dappId));
    await settle();
    expect(doc.getMap('members').has(coOwner.publicKey)).toBe(false);
  });
});

describe('timestamps that must supersede', () => {
  it('never stamps earlier than what it replaces', () => {
    const ahead = minutesAhead(5);
    expect(Date.parse(timestampAfter(ahead))).toBe(Date.parse(ahead) + 1);
    expect(Date.parse(timestampAfter(undefined, 'garbage', '2020-01-01T00:00:00.000Z'))).toBeGreaterThan(Date.now() - 1000);
  });

  it('removes a member whose entry was signed by a device with a fast clock', async () => {
    const editor = await createTestIdentity();
    const payload = {
      publicKey: editor.publicKey, name: 'Ed', role: 'editor', memberUpdatedAt: minutesAhead(3), canEditConfig: 'false', canInvite: 'false',
    };
    doc.getMap('members').set(editor.publicKey, yMapFromObject({ ...payload, ...(await signWithIdentity(signingOf(coOwner), payload)) }));
    await settle();
    expect(doc.getMap('members').has(editor.publicKey)).toBe(true);

    await writeSignedMemberRemoval(doc, editor.publicKey, signingOf(founder), founder.publicKey);
    await settle();
    await settle();
    expect(doc.getMap('members').has(editor.publicKey)).toBe(false); // used to come back: removedAt < memberUpdatedAt
    expect(doc.getMap('memberTombstones').has(editor.publicKey)).toBe(true);
  });

  it('deletes a record that was last written by a device with a fast clock', async () => {
    const stamp = minutesAhead(3);
    const payload = { id: 'r1', title: 'note', createdAt: stamp, updatedAt: stamp };
    const items = doc.getMap('data').get('items') as Y.Map<unknown>;
    items.set('r1', { ...payload, ...(await signWithIdentity(signingOf(coOwner), payload)) });
    await settle();
    expect(items.has('r1')).toBe(true);

    await writeSignedRecordTombstone(doc, 'items', 'r1', signingOf(founder));
    await settle();
    await settle();
    expect(items.has('r1')).toBe(false); // used to reappear: deletedAt < updatedAt
    expect(doc.getMap('recordTombstones').has('items:r1')).toBe(true);
  });
});
