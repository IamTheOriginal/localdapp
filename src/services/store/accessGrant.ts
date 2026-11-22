import { bufferToHex } from '../../lib/hex.ts';
import { signWithIdentity, verifySignature, type SigningIdentity } from './protocolCore.ts';

/**
 * The credential grant an approving owner writes into the invite lobby,
 * RSA-OAEP-encrypted to the joiner: `roomId:roomPassword:epoch:grantedBy`.
 *
 * `grantedBy` is the approving owner's device key. Several owner devices can
 * sit in one lobby, so the joiner cannot tell from the lobby who approved it —
 * the grant says so itself, and the joiner pins that key as its bootstrap
 * trust anchor. Older grants stop after the password or the epoch.
 *
 * Size budget: raw RSA-OAEP (2048-bit, SHA-256) carries at most 190 bytes.
 * `dapp-<uuid>` (41) + 64-hex password + 64-hex key + separators leaves room
 * for an 18-digit epoch — do not add fields without switching to hybrid encryption.
 */
export interface AccessGrant {
  roomId: string;
  roomPassword: string;
  /** Rotation epoch as a decimal string; absent on grants from pre-rotation owners. */
  epoch?: string;
  /** Approving owner's device public key; absent on grants from older builds. */
  grantedBy?: string;
}

const DEVICE_KEY_PATTERN = /^[a-f0-9]{64}$/;

export function formatAccessGrant(grant: { roomId: string; roomPassword: string; epoch: number; grantedBy?: string }): string {
  const base = `${grant.roomId}:${grant.roomPassword}:${grant.epoch}`;
  return grant.grantedBy ? `${base}:${grant.grantedBy}` : base;
}

/** Returns null when the payload carries no usable room credentials. Malformed optional segments are dropped, not fatal. */
export function parseAccessGrant(decrypted: string): AccessGrant | null {
  const [roomId, roomPassword, epoch, grantedBy] = decrypted.split(':');
  if (!roomId || !roomPassword) return null;
  const grant: AccessGrant = { roomId, roomPassword };
  if (epoch && /^\d+$/.test(epoch)) grant.epoch = epoch;
  if (grantedBy && DEVICE_KEY_PATTERN.test(grantedBy)) grant.grantedBy = grantedBy;
  return grant;
}

// ───── Grant signature ─────
//
// The ciphertext proves nothing about its author: everybody in the lobby knows the
// joiner's public RSA key and can encrypt `room:password:0:<any key>` to it. The
// approving owner therefore signs what it wrote — bound to the lobby, the joiner and
// the exact ciphertext, so a signature cannot be moved to another grant — and puts
// that next to the grant (`grantSignatures`, same key). It lives outside the RSA
// payload, which has no room left.

export interface AccessGrantBinding {
  lobbyId: string;
  joinerKey: string;
  /** The encrypted grant exactly as written into `grantedAccess`. */
  ciphertext: string;
}

async function grantSignaturePayload(binding: AccessGrantBinding): Promise<Record<string, unknown>> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(binding.ciphertext));
  return { purpose: 'lobby-grant-v1', lobbyId: binding.lobbyId, joinerKey: binding.joinerKey, ciphertextSha256: bufferToHex(digest) };
}

/** The value an approving owner stores in the lobby's `grantSignatures` map. */
export async function signAccessGrant(binding: AccessGrantBinding, identity: SigningIdentity): Promise<{ signedBy: string; signature: string }> {
  const signed = await signWithIdentity(identity, await grantSignaturePayload(binding));
  return { signedBy: signed._signedBy, signature: signed._signature };
}

/** The signer's device key when `entry` is a valid signature over this exact grant; null otherwise. */
export async function verifyAccessGrantSignature(entry: unknown, binding: AccessGrantBinding): Promise<string | null> {
  const candidate = (entry ?? {}) as { signedBy?: unknown; signature?: unknown };
  if (typeof candidate.signedBy !== 'string' || !DEVICE_KEY_PATTERN.test(candidate.signedBy)) return null;
  if (typeof candidate.signature !== 'string' || !/^[a-f0-9]{128}$/.test(candidate.signature)) return null;
  const valid = await verifySignature({ ...(await grantSignaturePayload(binding)), _signature: candidate.signature }, candidate.signedBy).catch(() => false);
  return valid ? candidate.signedBy : null;
}
