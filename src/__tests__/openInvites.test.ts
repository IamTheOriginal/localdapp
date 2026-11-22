import { must } from './helpers/must.ts';
import * as Y from 'yjs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bufferToHex } from '../lib/hex.ts';

const state = vi.hoisted(() => ({
  dappDoc: null as Y.Doc | null,
  inviteDocs: new Map<string, Y.Doc>(),
  inviteProviders: new Map<string, unknown>(),
  role: 'owner',
  setMember: vi.fn(() => Promise.resolve()),
  signing: { publicKey: 'owner-key', privateKey: '' },
  encrypt: vi.fn((_key: string, message: string) => Promise.resolve(`enc:${message}`)),
}));

vi.mock('../services/store/docs.ts', () => ({
  getDappDoc: () => state.dappDoc,
  getDappCredentials: () => ({ roomId: 'room-2', roomPassword: 'pw-2', epoch: 2 }),
  getInviteDoc: (inviteId: string) => state.inviteDocs.get(inviteId) ?? null,
  generateRoomPassword: () => 'lobby-password',
  inviteDocs: state.inviteDocs,
  inviteProviders: state.inviteProviders,
}));
vi.mock('../services/store/auth.ts', () => ({
  requireRole: vi.fn(),
  getRole: () => state.role,
  // No auth observer runs here, so "not scanned yet": approvals fall back to the entry in the doc.
  getVerifiedInvite: () => undefined,
  getVerifiedMember: () => undefined,
}));
vi.mock('../services/identity.ts', () => ({
  getIdentity: () => ({ publicKey: 'owner-key', displayName: 'Owner', encPublicKey: 'owner-enc', deviceId: 'd1' }),
  getSigningIdentity: () => Promise.resolve(state.signing),
  encryptMessage: (key: string, message: string) => state.encrypt(key, message),
}));
vi.mock('../services/store/members.ts', () => ({
  setMember: state.setMember,
}));

import { createInvite, deleteInvite, closeInvites, approveLobbyDevice, autoApproveLobbyPeers } from '../services/store/invites.ts';
import { getAutomaticAdmissions } from '../services/store/automaticAdmissions.ts';
import { deriveConnectionCode } from '../services/connectionCode.ts';
import { signLobbyAnnounce } from '../services/store/lobbyAnnounce.ts';
import { verifyAccessGrantSignature } from '../services/store/accessGrant.ts';

interface Device { publicKey: string; privateKey: string }

async function device(): Promise<Device> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  return {
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: bufferToHex(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  };
}

/** The lobby state of a joining device that holds the key it announces. */
async function waiting(who: Device, displayName: string, encPublicKey: string): Promise<Record<string, unknown>> {
  const claim = { publicKey: who.publicKey, encPublicKey, isOwner: false };
  return { ...claim, displayName, announceSig: await signLobbyAnnounce(firstInvite().get('lobbyId') as string, claim, who) };
}

function invitesMap(): Y.Map<unknown> {
  return must(state.dappDoc).getMap('invites');
}

function firstInvite(): Y.Map<unknown> {
  const [entry] = [...invitesMap().values()];
  return entry as Y.Map<unknown>;
}

function fakeProvider(states: Array<Record<string, unknown>>): unknown {
  return { awareness: { getStates: () => new Map(states.map((peerState, index) => [index, peerState])) } };
}

describe('1-step (auto-approve) invites', () => {
  // Invites are owner-signed, so the owner needs a real key.
  let alice: Device;
  let bob: Device;
  let member: Device;

  beforeAll(async () => {
    const owner = await device();
    state.signing.publicKey = owner.publicKey;
    state.signing.privateKey = owner.privateKey;
    [alice, bob, member] = await Promise.all([device(), device(), device()]);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    state.dappDoc = new Y.Doc();
    state.inviteDocs.clear();
    state.inviteProviders.clear();
    state.role = 'owner';
  });

  it('createInvite stores autoApprove + autoRole and returns a lobby URI', async () => {
    const uri = await createInvite('dapp-1', 999999, { autoApprove: true, autoRole: 'viewer' });
    expect(uri).toMatch(/^dapp:\/\/invite\/app\/dapp-lobby-[0-9a-f-]+\/lobby-password$/);
    const invite = firstInvite();
    expect(invite.get('autoApprove')).toBe('true');
    expect(invite.get('autoRole')).toBe('viewer');
    expect(invite.get('usesLeft')).toBe(999999);
  });

  it('regular invites carry no autoApprove flag', async () => {
    await createInvite('dapp-1');
    expect(firstInvite().get('autoApprove')).toBeUndefined();
  });

  it('approveLobbyDevice signs the member in, grants epoch-tagged credentials, and burns a use', async () => {
    await createInvite('dapp-1', 5, { autoApprove: true });
    const invite = firstInvite();
    const inviteId = invite.get('id') as string;
    const inviteDoc = new Y.Doc();
    state.inviteDocs.set(inviteId, inviteDoc);
    state.inviteProviders.set(inviteId, fakeProvider([await waiting(alice, 'Alice', 'peer-enc')]));

    await approveLobbyDevice('dapp-1', {
      publicKey: alice.publicKey,
      displayName: 'Alice',
      encPublicKey: 'peer-enc',
      inviteId,
    }, 'viewer');

    expect(state.setMember).toHaveBeenCalledWith('dapp-1', {
      name: 'Alice',
      role: 'viewer',
      publicKey: alice.publicKey,
      encPublicKey: 'peer-enc',
      viaInvite: inviteId, // owner-signed into the entry: what caps the invite's uses
    });
    // The grant names the approving owner device so the joiner pins the right key…
    const ciphertext = inviteDoc.getMap('grantedAccess').get(alice.publicKey) as string;
    expect(ciphertext).toBe('enc:room-2:pw-2:2:owner-key');
    // …and is signed over this lobby, this joiner and this ciphertext — the joiner takes nothing else.
    const binding = { lobbyId: invite.get('lobbyId') as string, joinerKey: alice.publicKey, ciphertext };
    const signature = inviteDoc.getMap('grantSignatures').get(alice.publicKey);
    expect(await verifyAccessGrantSignature(signature, binding)).toBe(state.signing.publicKey);
    expect((signature as { automatic?: unknown }).automatic).toBeUndefined(); // a person approved this one
    expect(await verifyAccessGrantSignature(signature, { ...binding, joinerKey: bob.publicKey })).toBeNull();
    expect(await verifyAccessGrantSignature(signature, { ...binding, ciphertext: 'enc:evil-room:pw:0:attacker' })).toBeNull();
    expect(invite.get('usesLeft')).toBe(4);
  });

  it('approveLobbyDevice admits no device that did not prove the key it announced', async () => {
    await createInvite('dapp-1', 5);
    const inviteId = firstInvite().get('id') as string;
    const inviteDoc = new Y.Doc();
    state.inviteDocs.set(inviteId, inviteDoc);
    const genuine = await waiting(alice, 'Alice', 'alice-enc');
    // A link holder announces Alice's key next to ITS OWN encryption key: same connection code
    // on the owner's screen, but the credentials would be readable by the attacker.
    state.inviteProviders.set(inviteId, fakeProvider([
      { ...genuine, encPublicKey: 'attacker-enc' },
      { publicKey: alice.publicKey, encPublicKey: 'attacker-enc', displayName: 'Alice' },
    ]));

    await expect(approveLobbyDevice('dapp-1', { publicKey: alice.publicKey, displayName: 'Alice', encPublicKey: 'attacker-enc', inviteId }))
      .rejects.toThrow(/did not prove/);
    expect(state.setMember).not.toHaveBeenCalled();
    expect(inviteDoc.getMap('grantedAccess').size).toBe(0);
  });

  it('approveLobbyDevice lets an existing member back in: no new member entry, grant encrypted to its STORED key', async () => {
    await createInvite('dapp-1', 1);
    const inviteId = firstInvite().get('id') as string;
    const inviteDoc = new Y.Doc();
    state.inviteDocs.set(inviteId, inviteDoc);
    const stored = new Y.Map<unknown>();
    stored.set('role', 'owner');
    stored.set('encPublicKey', 'stored-enc');
    must(state.dappDoc).getMap('members').set(member.publicKey, stored);

    // Nobody proved that key in the lobby: no grant, no burned invite use.
    state.inviteProviders.set(inviteId, fakeProvider([{ publicKey: member.publicKey, displayName: 'Impostor', encPublicKey: 'attacker-enc' }]));
    await expect(approveLobbyDevice('dapp-1', { publicKey: member.publicKey, encPublicKey: 'attacker-enc', inviteId })).rejects.toThrow(/did not prove/);
    expect(state.encrypt).not.toHaveBeenCalled();

    // The real device is back. Whatever encryption key gets passed in is ignored for a member.
    state.inviteProviders.set(inviteId, fakeProvider([await waiting(member, 'NAS Keeper', 'some-announced-enc')]));
    await approveLobbyDevice('dapp-1', { publicKey: member.publicKey, displayName: 'NAS Keeper', encPublicKey: 'attacker-enc', inviteId }, 'viewer');

    expect(state.setMember).not.toHaveBeenCalled();
    expect(state.encrypt).toHaveBeenCalledTimes(1);
    expect(state.encrypt.mock.calls[0][0]).toBe('stored-enc');
    expect((must(state.dappDoc).getMap('members').get(member.publicKey) as Y.Map<unknown>).get('role')).toBe('owner');
    expect(inviteDoc.getMap('grantedAccess').get(member.publicKey)).toBe('enc:room-2:pw-2:2:owner-key');
  });

  it('approveLobbyDevice refuses to let back in a member without a stored encryption key', async () => {
    await createInvite('dapp-1', 1);
    const inviteId = firstInvite().get('id') as string;
    const inviteDoc = new Y.Doc();
    state.inviteDocs.set(inviteId, inviteDoc);
    must(state.dappDoc).getMap('members').set('legacy-key', new Y.Map());

    await expect(approveLobbyDevice('dapp-1', { publicKey: 'legacy-key', encPublicKey: 'announced-enc', inviteId }))
      .rejects.toThrow(/no stored encryption key/);
    expect(state.encrypt).not.toHaveBeenCalled();
    expect(inviteDoc.getMap('grantedAccess').size).toBe(0);
  });

  it('autoApproveLobbyPeers never lets a member back in automatically', async () => {
    await createInvite('dapp-1', 999999, { autoApprove: true });
    const inviteId = firstInvite().get('id') as string;
    const inviteDoc = new Y.Doc();
    state.inviteDocs.set(inviteId, inviteDoc);
    const stored = new Y.Map<unknown>();
    stored.set('role', 'editor');
    stored.set('encPublicKey', 'stored-enc');
    must(state.dappDoc).getMap('members').set(member.publicKey, stored);
    state.inviteProviders.set(inviteId, fakeProvider([await waiting(member, 'Laptop', 'announced-enc')]));

    await autoApproveLobbyPeers('dapp-1', inviteId);

    expect(state.setMember).not.toHaveBeenCalled();
    expect(inviteDoc.getMap('grantedAccess').size).toBe(0);
  });

  it('approveLobbyDevice refuses a peer without an encryption key before touching members', async () => {
    await createInvite('dapp-1', 1);
    const inviteId = firstInvite().get('id') as string;
    await expect(approveLobbyDevice('dapp-1', { publicKey: 'peer-key', inviteId })).rejects.toThrow(/encryption key/);
    expect(state.setMember).not.toHaveBeenCalled();
  });

  it('approveLobbyDevice admits nobody through an invite that does not exist, was closed, or is used up', async () => {
    const peer = { publicKey: 'peer-key', displayName: 'Alice', encPublicKey: 'peer-enc' };
    await expect(approveLobbyDevice('dapp-1', { ...peer, inviteId: 'never-created' })).rejects.toThrow(/not valid any more/);

    await createInvite('dapp-1', 1);
    const inviteId = firstInvite().get('id') as string;
    state.inviteDocs.set(inviteId, new Y.Doc());

    // Used up: the signed `uses` is 1 and one verified admission already names this invite.
    // Raising the unsigned `usesLeft` counter (what a member could do) changes nothing.
    const admitted = new Y.Map<unknown>();
    admitted.set('viaInvite', inviteId);
    must(state.dappDoc).getMap('members').set('earlier-joiner', admitted);
    firstInvite().set('usesLeft', 999);
    await expect(approveLobbyDevice('dapp-1', { ...peer, inviteId })).rejects.toThrow(/not valid any more/);
    must(state.dappDoc).getMap('members').delete('earlier-joiner');

    // Closed: deleting leaves a signed tombstone, and putting the (validly signed) entry back does not revive it.
    const signedEntry = firstInvite().toJSON() as Record<string, unknown>;
    await deleteInvite('dapp-1', inviteId);
    expect(must(state.dappDoc).getMap('inviteTombstones').has(inviteId)).toBe(true);
    const replayed = new Y.Map<unknown>();
    Object.entries(signedEntry).forEach(([key, value]) => replayed.set(key, value));
    invitesMap().set(inviteId, replayed);
    await expect(approveLobbyDevice('dapp-1', { ...peer, inviteId })).rejects.toThrow(/not valid any more/);
    expect(state.setMember).not.toHaveBeenCalled();
  });

  it('closeInvites closes every open invite with a tombstone, and only for owners', async () => {
    await createInvite('dapp-1', 1);
    await createInvite('dapp-1', 999999, { autoApprove: true });
    state.role = 'editor';
    expect(await closeInvites('dapp-1')).toBe(0);
    expect(invitesMap().size).toBe(2);
    state.role = 'owner';
    expect(await closeInvites('dapp-1')).toBe(2);
    expect(invitesMap().size).toBe(0);
    expect(must(state.dappDoc).getMap('inviteTombstones').size).toBe(2);
  });

  it('autoApproveLobbyPeers admits only eligible waiting devices, with the invite role', async () => {
    await createInvite('dapp-1', 999999, { autoApprove: true, autoRole: 'editor' });
    const invite = firstInvite();
    const inviteId = invite.get('id') as string;
    const inviteDoc = new Y.Doc();
    state.inviteDocs.set(inviteId, inviteDoc);
    const granted = await device();
    const unproven = await device();
    inviteDoc.getMap('grantedAccess').set(granted.publicKey, 'enc:old');
    must(state.dappDoc).getMap('members').set(member.publicKey, new Y.Map());
    state.inviteProviders.set(inviteId, fakeProvider([
      { publicKey: 'owner-key', displayName: 'Owner', encPublicKey: 'owner-enc', isOwner: true },
      await waiting(bob, 'Bob', 'bob-enc'),
      { publicKey: 'no-enc-peer', displayName: 'NoEnc' },
      await waiting(member, 'Old', 'old-enc'),
      await waiting(granted, 'Granted', 'granted-enc'),
      // Claims a key without proving it — never admitted, however open the invite is.
      { publicKey: unproven.publicKey, displayName: 'Mallory', encPublicKey: 'mallory-enc' },
    ]));

    await autoApproveLobbyPeers('dapp-1', inviteId);

    expect(state.setMember).toHaveBeenCalledTimes(1);
    expect(state.setMember).toHaveBeenCalledWith('dapp-1', {
      name: 'Bob',
      role: 'editor',
      publicKey: bob.publicKey,
      encPublicKey: 'bob-enc',
      viaInvite: inviteId,
    });
    expect(inviteDoc.getMap('grantedAccess').get(bob.publicKey)).toBe('enc:room-2:pw-2:2:owner-key');
    // Nobody saw Bob's code: the grant tells him so, and this device lists the admission with the code he sees.
    expect((inviteDoc.getMap('grantSignatures').get(bob.publicKey) as { automatic?: unknown }).automatic).toBe(true);
    const expectedCode = await deriveConnectionCode(bob.publicKey, 'owner-key', invite.get('lobbyId') as string);
    await vi.waitFor(() => {
      expect(getAutomaticAdmissions('dapp-1').map((row) => [row.publicKey, row.inviteId, row.code])).toEqual([[bob.publicKey, inviteId, expectedCode]]);
    });
  });

  it('autoApproveLobbyPeers is a no-op for regular invites and for non-owners', async () => {
    await createInvite('dapp-1', 999999);
    const inviteId = firstInvite().get('id') as string;
    state.inviteDocs.set(inviteId, new Y.Doc());
    state.inviteProviders.set(inviteId, fakeProvider([await waiting(bob, 'Bob', 'bob-enc')])); // a device that WOULD be admitted

    await autoApproveLobbyPeers('dapp-1', inviteId);
    expect(state.setMember).not.toHaveBeenCalled();

    firstInvite().set('autoApprove', 'true');
    state.role = 'editor';
    await autoApproveLobbyPeers('dapp-1', inviteId);
    expect(state.setMember).not.toHaveBeenCalled();
  });
});
