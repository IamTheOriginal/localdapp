import { describe, expect, it } from 'vitest';
import { createRelationshipIdentity } from '../services/relationshipIdentity.ts';
import {
  createPairingRequest, createPairingResponse, createRelationshipInvite, deriveRelationshipSafetyNumber,
  hybridDecrypt, hybridEncrypt, parseInviteUri, verifyAndDecryptPairingResponse,
  verifyCompactInviteAnnounce, verifyPairingRequest,
} from '../services/relationshipProtocol.ts';
import type { CanonicalJson, RelationshipControlCapability } from '../types.ts';

const control: RelationshipControlCapability = {
  protocol: 'relationship-control-capability', schemaVersion: 1, capabilityId: 'control-1', pairContextId: '',
  roomId: 'private-room', roomPassword: 'high-entropy-secret', createdAt: '2026-08-12T00:00:00.000Z',
};

describe('relationship pairing protocol', () => {
  it('issues short seed codes whose lobby derives from the seed and whose announce is code-bound', async () => {
    const now = new Date('2026-08-12T00:00:00.000Z');
    const first = await createRelationshipInvite({ now, lifetimeMs: 60_000 });
    const second = await createRelationshipInvite({ now, lifetimeMs: 60_000 });
    expect(first.uri).not.toBe(second.uri);
    expect(first.identity.publicKey).not.toBe(second.identity.publicKey);
    expect(first.uri.startsWith('dapp://invite/pair/')).toBe(true);
    expect(first.uri.length).toBeLessThan(120);

    const context = await parseInviteUri(first.uri, new Date('2026-08-12T00:00:30.000Z'));
    expect(context.inviteId).toBe(first.invite.inviteId);
    expect(context.lobbyRoomId).toBe(first.invite.lobbyRoomId);
    expect(context.lobbyRoomPassword).toBe(first.invite.lobbyRoomPassword);
    expect(context.pairContextId).toBe(first.invite.pairContextId);

    // The signed announce fetched from the lobby verifies against the derived context.
    await expect(verifyCompactInviteAnnounce(first.invite, context, now)).resolves.toEqual(first.invite);
    // A different (even self-consistently signed) invite cannot squat the code.
    await expect(verifyCompactInviteAnnounce(second.invite, context, now)).rejects.toThrow(/does not match/);
    // Tampering with the announced identity breaks the signature.
    await expect(verifyCompactInviteAnnounce({ ...first.invite, publicKey: second.invite.publicKey }, context, now))
      .rejects.toThrow(/signature/);
    // Expired codes fail before any lobby is touched.
    await expect(parseInviteUri(first.uri, new Date('2026-08-12T00:02:00.000Z'))).rejects.toThrow(/not currently valid/);
    // Anything that is not the one invite format is rejected outright.
    await expect(parseInviteUri('dapp-builder://relationship-pair/v2?code=abc', now)).rejects.toThrow(/Invalid invite URI/);
    await expect(parseInviteUri('dapp://invite/pair/not-base64!!!', now)).rejects.toThrow();
  });

  it('carries self-asserted display names, signed and length-capped', async () => {
    const now = new Date('2026-08-12T00:00:00.000Z');
    const named = await createRelationshipInvite({ now, lifetimeMs: 60_000, displayName: '  Alice  ' });
    expect(named.invite.displayName).toBe('Alice');
    // Overlong names are capped at creation; missing names get a fallback.
    const long = await createRelationshipInvite({ now, lifetimeMs: 60_000, displayName: 'x'.repeat(500) });
    expect(long.invite.displayName.length).toBeLessThanOrEqual(64);
    const unnamed = await createRelationshipInvite({ now, lifetimeMs: 60_000 });
    expect(unnamed.invite.displayName).toBe('Unknown');
    // The announce rejects a tampered or hostile-length name (signature + validation).
    const context = await parseInviteUri(named.uri, now);
    await expect(verifyCompactInviteAnnounce({ ...named.invite, displayName: 'Mallory' }, context, now)).rejects.toThrow(/signature/);
    await expect(verifyCompactInviteAnnounce({ ...named.invite, displayName: 'y'.repeat(65) }, context, now)).rejects.toThrow();
    // Requests carry the requester's name the same way.
    const requester = await createRelationshipIdentity();
    const request = await createPairingRequest(named.invite, requester, now, 'Bob');
    expect(request.displayName).toBe('Bob');
    expect(await verifyPairingRequest(request, named.invite)).toBe(true);
    expect(await verifyPairingRequest({ ...request, displayName: 'Eve' }, named.invite)).toBe(false);
  });

  it('hybrid-encrypts arbitrary payloads and authenticates AAD and ciphertext', async () => {
    const recipient = await createRelationshipIdentity();
    const payload: CanonicalJson = { secret: 'x'.repeat(1024) };
    const envelope = await hybridEncrypt(payload, recipient.encPublicKey, { requestId: 'one' });
    await expect(hybridDecrypt(envelope, recipient.encPrivateKey, { requestId: 'one' })).resolves.toEqual(payload);
    await expect(hybridDecrypt(envelope, recipient.encPrivateKey, { requestId: 'two' })).rejects.toThrow(/AAD/);
    const corrupt = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -1) + (envelope.ciphertext.endsWith('A') ? 'B' : 'A') };
    await expect(hybridDecrypt(corrupt, recipient.encPrivateKey, { requestId: 'one' })).rejects.toThrow();
  });

  it('signs and binds request/response and decrypts only for the requester', async () => {
    const { identity: inviter, invite } = await createRelationshipInvite();
    const requester = await createRelationshipIdentity();
    const stranger = await createRelationshipIdentity();
    const request = await createPairingRequest(invite, requester);
    expect(await verifyPairingRequest(request, invite)).toBe(true);
    expect(await verifyPairingRequest({ ...request, inviteId: 'other' }, invite)).toBe(false);
    const boundControl = { ...control, pairContextId: invite.pairContextId };
    const response = await createPairingResponse(invite, inviter, request, boundControl);
    await expect(verifyAndDecryptPairingResponse(response, request, requester)).resolves.toEqual(boundControl);
    await expect(verifyAndDecryptPairingResponse(response, request, stranger)).rejects.toThrow(/Invalid pairing response/);
    await expect(verifyAndDecryptPairingResponse({ ...response, requestHash: '0'.repeat(64) }, request, requester)).rejects.toThrow(/Invalid/);
  });

  it('derives a symmetric, stable 30-digit safety number', async () => {
    const one = await createRelationshipIdentity();
    const two = await createRelationshipIdentity();
    const forward = await deriveRelationshipSafetyNumber(one.publicKey, two.publicKey, 'pair-context');
    expect(await deriveRelationshipSafetyNumber(two.publicKey, one.publicKey, 'pair-context')).toBe(forward);
    expect(await deriveRelationshipSafetyNumber(two.publicKey, one.publicKey, 'other-context')).not.toBe(forward);
    expect(forward).toMatch(/^\d{5}( \d{5}){5}$/);
  });
});
