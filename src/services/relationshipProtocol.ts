import type {
  CanonicalJson, HybridEncryptedEnvelope, PairingRequest, PairingResponse,
  RelationshipControlCapability, RelationshipIdentity, RelationshipInvite,
} from '../types.ts';
import { createRelationshipIdentity } from './relationshipIdentity.ts';
import { canonicalizeJson } from './relationshipStream.ts';
import { PAIR_INVITE_URI_PREFIX } from './inviteLinks.ts';
import { bufferToHex } from '../lib/hex.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
// The one pairing invite format: a 32-byte random seed plus expiry, packed
// base64url behind the shared pair-invite prefix. Everything else (lobby
// room, password, invite/pair ids) is HKDF-derived from the seed; the
// inviter's signed identity is announced inside the code-gated lobby and
// verified against the derivation.
const PAIR_INVITE_PREFIX: string = PAIR_INVITE_URI_PREFIX;
const COMPACT_SEED_BYTES = 32;
const COMPACT_HKDF_SALT = 'dapp-builder-relationship-invite-v2';

/**
 * Names carried in pairing payloads are self-asserted, attacker-chosen text:
 * cap them at the protocol boundary and render them as plain text only. The
 * safety number remains the identity check.
 */
const MAX_PEER_DISPLAY_NAME_LENGTH = 64;

function normalizePeerDisplayName(value: string | undefined): string {
  const trimmed = (value ?? '').trim().slice(0, MAX_PEER_DISPLAY_NAME_LENGTH).trim();
  return trimmed || 'Unknown';
}

function isValidPeerDisplayName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_PEER_DISPLAY_NAME_LENGTH;
}

function hexToBytes(value: string, bytes?: number): Uint8Array<ArrayBuffer> {
  if (!/^[a-f0-9]+$/.test(value) || value.length % 2 !== 0 || (bytes !== undefined && value.length !== bytes * 2)) {
    throw new Error('relationship protocol: Invalid hexadecimal value');
  }
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return result;
}

function toBase64Url(value: Uint8Array): string {
  let binary = '';
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('relationship protocol: Invalid base64url value');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function digest(value: Uint8Array<ArrayBuffer>): Promise<string> {
  return bufferToHex(await crypto.subtle.digest('SHA-256', value));
}

/** Signs canonical JSON with an Ed25519 key (pkcs8 hex, or a CryptoKey in the browser). */
export async function signRelationshipControl(value: CanonicalJson, privateKey: string | CryptoKey): Promise<string> {
  const key = typeof privateKey === 'string'
    ? await crypto.subtle.importKey('pkcs8', hexToBytes(privateKey), { name: 'Ed25519' }, false, ['sign'])
    : privateKey;
  return bufferToHex(await crypto.subtle.sign('Ed25519', key, encoder.encode(canonicalizeJson(value))));
}

export async function verifyRelationshipControl(value: CanonicalJson, signature: string, publicKey: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(publicKey, 32), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, hexToBytes(signature, 64), encoder.encode(canonicalizeJson(value)));
  } catch {
    return false;
  }
}

export async function hashRelationshipControl(value: CanonicalJson): Promise<string> {
  return digest(encoder.encode(canonicalizeJson(value)));
}

/** The signed object minus its signature — what a signature was computed over. */
export function withoutSignature<T extends { signature: string }>(value: T): CanonicalJson {
  const copy = { ...value } as Record<string, unknown>;
  delete copy.signature;
  return copy as CanonicalJson;
}

function parseRsaJwk(value: string, needsPrivate: boolean): JsonWebKey {
  try {
    const jwk = JSON.parse(value) as JsonWebKey;
    if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e || (needsPrivate && !jwk.d)) throw new Error();
    return jwk;
  } catch {
    throw new Error('relationship protocol: Invalid RSA key');
  }
}

export async function hybridEncrypt(payload: CanonicalJson, recipientPublicKey: string, aad: CanonicalJson): Promise<HybridEncryptedEnvelope> {
  const aadBytes = encoder.encode(canonicalizeJson(aad));
  const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadBytes, tagLength: 128 }, aes, encoder.encode(canonicalizeJson(payload)),
  );
  const rsa = await crypto.subtle.importKey('jwk', parseRsaJwk(recipientPublicKey, false), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const wrappedKey = await crypto.subtle.encrypt('RSA-OAEP', rsa, await crypto.subtle.exportKey('raw', aes));
  return {
    schemaVersion: 1, keyAlgorithm: 'RSA-OAEP-256', contentAlgorithm: 'A256GCM',
    wrappedKey: toBase64Url(new Uint8Array(wrappedKey)), iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)), aadHash: await digest(aadBytes),
  };
}

export async function hybridDecrypt<T>(envelope: HybridEncryptedEnvelope, recipientPrivateKey: string, aad: CanonicalJson): Promise<T> {
  if (envelope.schemaVersion !== 1 || envelope.keyAlgorithm !== 'RSA-OAEP-256' || envelope.contentAlgorithm !== 'A256GCM') {
    throw new Error('relationship protocol: Unsupported encrypted envelope');
  }
  const aadBytes = encoder.encode(canonicalizeJson(aad));
  if (await digest(aadBytes) !== envelope.aadHash) throw new Error('relationship protocol: AAD does not match');
  const rsa = await crypto.subtle.importKey('jwk', parseRsaJwk(recipientPrivateKey, true), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const rawKey = await crypto.subtle.decrypt('RSA-OAEP', rsa, fromBase64Url(envelope.wrappedKey));
  const aes = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(envelope.iv), additionalData: aadBytes, tagLength: 128 }, aes, fromBase64Url(envelope.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

/**
 * Everything a joiner can derive from a compact invite code alone: the lobby
 * room and its password, plus the ids that bind the announce to this code.
 * The inviter's identity is NOT in the code — it arrives as a signed announce
 * inside the (code-gated) lobby and is verified against this context.
 */
export interface CompactInviteContext {
  inviteId: string;
  pairContextId: string;
  lobbyRoomId: string;
  lobbyRoomPassword: string;
  expiresAt: string;
}

async function hkdfHex(seed: Uint8Array<ArrayBuffer>, label: string, bytes: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(COMPACT_HKDF_SALT), info: encoder.encode(label) },
    key, bytes * 8,
  );
  return bufferToHex(bits);
}

async function deriveCompactInviteContext(seed: Uint8Array<ArrayBuffer>, expiresAtMs: number): Promise<CompactInviteContext> {
  if (seed.length !== COMPACT_SEED_BYTES) throw new Error('relationship protocol: Invalid invite code');
  return {
    inviteId: await hkdfHex(seed, 'invite-id', 16),
    pairContextId: await hkdfHex(seed, 'pair-context', 16),
    lobbyRoomId: `relationship-lobby-v2-${await hkdfHex(seed, 'lobby-room', 16)}`,
    lobbyRoomPassword: await hkdfHex(seed, 'lobby-password', 32),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/** Parses the one pairing invite format into its derived lobby context. */
export async function parseInviteUri(uri: string, now = new Date()): Promise<CompactInviteContext> {
  const trimmed = uri.trim();
  if (!trimmed.startsWith(PAIR_INVITE_PREFIX)) throw new Error('relationship protocol: Invalid invite URI');
  const packed = fromBase64Url(trimmed.slice(PAIR_INVITE_PREFIX.length));
  if (packed.length !== COMPACT_SEED_BYTES + 8) throw new Error('relationship protocol: Malformed invite code');
  const seed = packed.slice(0, COMPACT_SEED_BYTES);
  const expiresAtMs = Number(new DataView(packed.buffer, packed.byteOffset + COMPACT_SEED_BYTES, 8).getBigUint64(0));
  if (!Number.isSafeInteger(expiresAtMs)) throw new Error('relationship protocol: Malformed invite code');
  if (now.getTime() > expiresAtMs) throw new Error('relationship protocol: Invite is not currently valid');
  return deriveCompactInviteContext(seed, expiresAtMs);
}

/**
 * Verifies the inviter's signed lobby announce against a derived compact
 * context. Binding every derived field to the code means a lobby squatter
 * cannot substitute credentials; the signature makes the announced identity
 * self-consistent, and the safety number stays the human MITM check — the same
 * trust the legacy URI offered by carrying the identity inline.
 */
export async function verifyCompactInviteAnnounce(candidate: unknown, context: CompactInviteContext, now = new Date()): Promise<RelationshipInvite> {
  const invite = candidate as RelationshipInvite | null;
  if (!invite || typeof invite !== 'object'
    || invite.protocol !== 'relationship-pairing-invite' || invite.schemaVersion !== 1
    || invite.inviteId !== context.inviteId || invite.pairContextId !== context.pairContextId
    || invite.lobbyRoomId !== context.lobbyRoomId || invite.lobbyRoomPassword !== context.lobbyRoomPassword
    || invite.expiresAt !== context.expiresAt || !invite.nonce || !isValidPeerDisplayName(invite.displayName)) {
    throw new Error('relationship protocol: Lobby announce does not match the invite code');
  }
  const created = Date.parse(invite.createdAt);
  const expires = Date.parse(invite.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created || now.getTime() > expires) {
    throw new Error('relationship protocol: Invite is not currently valid');
  }
  if (!await verifyRelationshipControl(withoutSignature(invite), invite.signature, invite.publicKey)) throw new Error('relationship protocol: Invalid invite signature');
  parseRsaJwk(invite.encPublicKey, false);
  return invite;
}

export async function createRelationshipInvite(options: { lifetimeMs?: number; now?: Date; identity?: RelationshipIdentity; displayName?: string } = {}): Promise<{ identity: RelationshipIdentity; invite: RelationshipInvite; uri: string }> {
  const identity = options.identity ?? await createRelationshipIdentity();
  const now = options.now ?? new Date();
  const lifetimeMs = options.lifetimeMs ?? 600_000;
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) throw new Error('relationship protocol: Invalid invite lifetime');
  const seed = crypto.getRandomValues(new Uint8Array(COMPACT_SEED_BYTES));
  const expiresAtMs = now.getTime() + lifetimeMs;
  const context = await deriveCompactInviteContext(seed, expiresAtMs);
  const base = {
    protocol: 'relationship-pairing-invite' as const, schemaVersion: 1 as const, inviteId: context.inviteId,
    pairContextId: context.pairContextId, lobbyRoomId: context.lobbyRoomId, lobbyRoomPassword: context.lobbyRoomPassword,
    publicKey: identity.publicKey, encPublicKey: identity.encPublicKey,
    displayName: normalizePeerDisplayName(options.displayName), createdAt: now.toISOString(),
    expiresAt: context.expiresAt, nonce: bufferToHex(crypto.getRandomValues(new Uint8Array(16)).buffer),
  };
  const invite = { ...base, signature: await signRelationshipControl(base, identity.privateKey) };
  const packed = new Uint8Array(COMPACT_SEED_BYTES + 8);
  packed.set(seed);
  new DataView(packed.buffer).setBigUint64(COMPACT_SEED_BYTES, BigInt(expiresAtMs));
  return { identity, invite, uri: PAIR_INVITE_PREFIX + toBase64Url(packed) };
}

export async function createPairingRequest(invite: RelationshipInvite, requester: RelationshipIdentity, now = new Date(), displayName?: string): Promise<PairingRequest> {
  if (!await verifyRelationshipControl(withoutSignature(invite), invite.signature, invite.publicKey)) throw new Error('relationship protocol: Invalid invite signature');
  const base = {
    protocol: 'relationship-pairing-request' as const, schemaVersion: 1 as const, requestId: crypto.randomUUID(), inviteId: invite.inviteId, pairContextId: invite.pairContextId,
    inviterPublicKey: invite.publicKey, requesterPublicKey: requester.publicKey, requesterEncPublicKey: requester.encPublicKey,
    displayName: normalizePeerDisplayName(displayName), createdAt: now.toISOString(), nonce: bufferToHex(crypto.getRandomValues(new Uint8Array(16)).buffer),
  };
  return { ...base, signature: await signRelationshipControl(base, requester.privateKey) };
}

export async function verifyPairingRequest(request: PairingRequest, invite: RelationshipInvite): Promise<boolean> {
  return request.protocol === 'relationship-pairing-request' && request.schemaVersion === 1 && request.inviteId === invite.inviteId
    && request.pairContextId === invite.pairContextId && isValidPeerDisplayName(request.displayName)
    && request.inviterPublicKey === invite.publicKey && await verifyRelationshipControl(withoutSignature(request), request.signature, request.requesterPublicKey);
}

function responseAad(value: Pick<PairingResponse, 'inviteId' | 'pairContextId' | 'requestId' | 'inviterPublicKey' | 'requesterPublicKey'>): CanonicalJson {
  return { protocol: 'relationship-pairing-control', schemaVersion: 1, inviteId: value.inviteId, pairContextId: value.pairContextId, requestId: value.requestId, inviterPublicKey: value.inviterPublicKey, requesterPublicKey: value.requesterPublicKey };
}

export async function hashPairingRequest(request: PairingRequest): Promise<string> {
  return digest(encoder.encode(canonicalizeJson(request as unknown as CanonicalJson)));
}

export async function createPairingResponse(invite: RelationshipInvite, inviter: RelationshipIdentity, request: PairingRequest, capability: RelationshipControlCapability, now = new Date()): Promise<PairingResponse> {
  if (inviter.publicKey !== invite.publicKey || !await verifyPairingRequest(request, invite)) throw new Error('relationship protocol: Request or inviter does not match invite');
  if (capability.pairContextId !== invite.pairContextId) throw new Error('relationship protocol: Control capability context does not match invite');
  const fields = { inviteId: invite.inviteId, pairContextId: invite.pairContextId, requestId: request.requestId, inviterPublicKey: inviter.publicKey, requesterPublicKey: request.requesterPublicKey };
  const base = {
    protocol: 'relationship-pairing-response' as const, schemaVersion: 1 as const, responseId: crypto.randomUUID(), ...fields,
    requestHash: await hashPairingRequest(request), inviterEncPublicKey: inviter.encPublicKey,
    encryptedControlCapability: await hybridEncrypt(capability as unknown as CanonicalJson, request.requesterEncPublicKey, responseAad(fields)), createdAt: now.toISOString(),
  };
  return { ...base, signature: await signRelationshipControl(base as unknown as CanonicalJson, inviter.privateKey) };
}

export async function verifyAndDecryptPairingResponse(response: PairingResponse, request: PairingRequest, requester: RelationshipIdentity): Promise<RelationshipControlCapability> {
  if (response.protocol !== 'relationship-pairing-response' || response.schemaVersion !== 1 || response.requestId !== request.requestId
    || response.inviteId !== request.inviteId || response.pairContextId !== request.pairContextId || response.inviterPublicKey !== request.inviterPublicKey
    || response.requesterPublicKey !== requester.publicKey || response.requestHash !== await hashPairingRequest(request)
    || !await verifyRelationshipControl(withoutSignature(response), response.signature, response.inviterPublicKey)) throw new Error('relationship protocol: Invalid pairing response');
  const capability = await hybridDecrypt<RelationshipControlCapability>(response.encryptedControlCapability, requester.encPrivateKey, responseAad(response));
  if (capability.protocol !== 'relationship-control-capability' || capability.schemaVersion !== 1 || capability.pairContextId !== request.pairContextId
    || !capability.capabilityId || !capability.roomId || !capability.roomPassword) {
    throw new Error('relationship protocol: Malformed control capability');
  }
  return capability;
}

export async function deriveRelationshipSafetyNumber(firstPublicKey: string, secondPublicKey: string, pairContextId = ''): Promise<string> {
  hexToBytes(firstPublicKey, 32);
  hexToBytes(secondPublicKey, 32);
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(['relationship-safety-v1', pairContextId, ...[firstPublicKey, secondPublicKey].sort()].join(':')));
  let decimal = '';
  for (const byte of new Uint8Array(hash).slice(0, 15)) decimal += byte.toString().padStart(3, '0');
  return (decimal.slice(0, 30).match(/.{1,5}/g) ?? []).join(' ');
}
