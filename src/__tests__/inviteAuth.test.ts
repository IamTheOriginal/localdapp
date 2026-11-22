import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';

/**
 * Invites are owner-only state. Before they were signed, ANY member — even a
 * viewer on a patched client — could write a 1-step invite into the doc; every
 * owner device (and the keeper) then opened that lobby and signed whoever showed
 * up in as editor. These tests play that member against the real auth observer.
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
  getDappCredentials: () => ({ roomId: 'room', roomPassword: 'pw', epoch: 0 }),
  getInviteDoc: () => null,
  generateRoomPassword: () => 'lobby-password',
  inviteDocs: new Map(),
  inviteProviders: new Map(),
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

const { setupAuthObserver, getVerifiedInvites, onVerifiedInvitesChange } = await import('../services/store/auth.ts');
const { createInvite, deleteInvite } = await import('../services/store/invites.ts');
const { leaveDappMembership } = await import('../services/store/members.ts');
const { signWithIdentity, writeSignedMember, yMapFromObject } = await import('../services/store/protocolCore.ts');
const { getDappDoc } = await import('../services/store/docs.ts');

async function createTestIdentity(): Promise<TestIdentity> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  return {
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', pair.publicKey)),
    signPrivateHex: bufferToHex(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  };
}

const signingOf = (identity: TestIdentity) => ({ publicKey: identity.publicKey, privateKey: identity.signPrivateHex });
const settle = () => new Promise((resolve) => setTimeout(resolve, 160));

let owner: TestIdentity;
let viewer: TestIdentity;
let dappId: string;
let doc: Y.Doc;

beforeEach(async () => {
  docs.clear();
  owner = await createTestIdentity();
  viewer = await createTestIdentity();
  currentIdentity = owner;
  dappId = `invites-${crypto.randomUUID()}`;
  doc = getDappDoc(dappId);
  const meta = new Y.Map<unknown>();
  meta.set('createdBy', owner.publicKey);
  doc.getMap('config').set('meta', meta);
  doc.getMap('members').set(owner.publicKey, yMapFromObject({ publicKey: owner.publicKey, name: 'Owner', role: 'owner' }));
  await writeSignedMember(doc, { publicKey: viewer.publicKey, name: 'Eve', role: 'viewer' }, signingOf(owner));
  setupAuthObserver(dappId, { scanDebounceMs: 10 });
  doc.getMap('appData').set('ping', '1');
  await settle();
});

describe('invite authorization', () => {
  it('verifies an owner-signed invite and announces it', async () => {
    const changes = vi.fn();
    onVerifiedInvitesChange(dappId, changes);
    await createInvite(dappId, 1, { autoApprove: true, autoRole: 'viewer' });
    await settle();
    const verified = [...(getVerifiedInvites(dappId) ?? new Map<string, Record<string, unknown>>()).values()];
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({ uses: 1, autoApprove: 'true', autoRole: 'viewer', _signedBy: owner.publicKey });
    expect(verified[0].usesLeft).toBeUndefined(); // bookkeeping is not part of the verified invite
    expect(changes).toHaveBeenCalled();
  });

  it('deletes an invite a member planted — unsigned, or signed with its own (non-owner) key', async () => {
    const planted = { id: 'planted', lobbyId: 'dapp-lobby-evil', lobbyPassword: 'pw', uses: 999, createdAt: new Date().toISOString(), autoApprove: 'true', autoRole: 'editor' };
    doc.getMap('invites').set('planted', yMapFromObject({ ...planted, usesLeft: 999 }));
    const selfSigned = { ...planted, id: 'self-signed' };
    doc.getMap('invites').set('self-signed', yMapFromObject({ ...selfSigned, ...(await signWithIdentity(signingOf(viewer), selfSigned)), usesLeft: 999 }));
    await settle();
    expect(doc.getMap('invites').size).toBe(0);
    expect(getVerifiedInvites(dappId)?.size).toBe(0);
  });

  it('restores an owner invite that a member rewrote into a 1-step invite, but lets the use counter move', async () => {
    await createInvite(dappId, 3);
    await settle();
    const [inviteId] = [...doc.getMap('invites').keys()];
    const entry = doc.getMap('invites').get(inviteId) as Y.Map<unknown>;

    entry.set('autoApprove', 'true'); // what a member would flip to get admitted without a person
    entry.set('autoRole', 'editor');
    entry.set('usesLeft', 2); // legitimate bookkeeping
    await settle();

    expect(entry.get('autoApprove')).toBeUndefined();
    expect(entry.get('usesLeft')).toBe(2);
    expect(getVerifiedInvites(dappId)?.get(inviteId)?.autoApprove).toBeUndefined();
  });

  it('keeps a closed invite closed: the tombstone comes back, the replayed entry goes', async () => {
    await createInvite(dappId, 5, { autoApprove: true });
    await settle();
    const [inviteId] = [...doc.getMap('invites').keys()];
    const signedEntry = (doc.getMap('invites').get(inviteId) as Y.Map<unknown>).toJSON() as Record<string, unknown>;
    await deleteInvite(dappId, inviteId);
    await settle();
    expect(getVerifiedInvites(dappId)?.size).toBe(0);

    doc.transact(() => {
      doc.getMap('inviteTombstones').delete(inviteId);
      doc.getMap('invites').set(inviteId, yMapFromObject(signedEntry));
    });
    await settle();
    await settle();
    expect(doc.getMap('inviteTombstones').has(inviteId)).toBe(true);
    expect(doc.getMap('invites').has(inviteId)).toBe(false);
  });

  it('puts back an owner invite that a member deleted without a tombstone', async () => {
    await createInvite(dappId, 1);
    await settle();
    const [inviteId] = [...doc.getMap('invites').keys()];
    doc.getMap('invites').delete(inviteId);
    await settle();
    expect(doc.getMap('invites').has(inviteId)).toBe(true);
    expect((doc.getMap('invites').get(inviteId) as Y.Map<unknown>).get('usesLeft')).toBe(1);
  });

  it('closes the open invites when a member leaves — it knows their lobby secrets', async () => {
    await createInvite(dappId, 999999, { autoApprove: true });
    await settle();
    expect(getVerifiedInvites(dappId)?.size).toBe(1);

    currentIdentity = viewer;
    await leaveDappMembership(dappId, doc);
    currentIdentity = owner; // this (owner) device observes the departure
    await settle();
    await settle();

    expect(doc.getMap('invites').size).toBe(0);
    expect(doc.getMap('inviteTombstones').size).toBe(1);
  });
});
