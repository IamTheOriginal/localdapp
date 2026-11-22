import * as Y from 'yjs';
import {
  getDappDoc,
  generateRoomPassword,
  getDappCredentials,
  updateDappCredentials,
  reconnectDappProviders,
} from './docs.ts';
import { getRole, requireRole } from './auth.ts';
import { getIdentity, getSigningIdentity, encryptMessage, decryptMessage } from '../identity.ts';
import { mapToObject, verifySignature, writeSignedRekeyEntry } from './protocolCore.ts';

// ───── Room credential rotation ─────
//
// Removing a member cannot revoke read access in a shared-room model — a
// removed member who cached the room password can keep listening. Rotation
// closes that hole going forward: the owner generates fresh room credentials
// (epoch + 1), encrypts them per remaining member to that member's RSA-OAEP
// key, and writes owner-signed `rekeys` entries into the doc while still
// connected to the old room. Honest peers verify the signature + strictly
// increasing epoch, decrypt their entry, and move to the new room. The removed
// member sees only ciphertexts it cannot decrypt.
//
// Known limits (documented in docs/security/THREAT_MODEL.md):
// - Members offline during rotation find the old room empty afterwards and
//   must be re-invited; the rekey entry travels with the doc, but nobody is
//   left in the old room to sync it to them.
// - Members without a stored encPublicKey (pre-rotation adds) cannot be
//   re-keyed and also need a re-invite; rotation reports them in `skipped`.

export interface RotationResult {
  epoch: number;
  /** Members an encrypted rekey entry was written for. */
  rekeyed: string[];
  /** Members with no stored encryption key — they cannot follow the rotation and need a re-invite. */
  skipped: string[];
}

/** Rotations are rare manual events; no honest dapp skips this many epochs at once. */
const MAX_EPOCH_JUMP = 64;

/** Delay before dropping the old-room provider so queued rekey updates flush to connected peers. */
const RECONNECT_GRACE_MS = 2000;

/**
 * Rotate a dapp's room credentials (owner only). Writes per-member encrypted
 * rekey entries into the doc, updates the local catalog, and reconnects this
 * device's providers to the new room after a short flush grace period.
 */
export async function rotateDappCredentials(
  dappId: string,
  options: { exclude?: string[]; doc?: Y.Doc; reconnectDelayMs?: number } = {},
): Promise<RotationResult> {
  requireRole(dappId, 'owner');
  const identity = getIdentity();
  if (!identity) throw new Error('auth: No identity to sign with');

  const doc = options.doc ?? getDappDoc(dappId);
  const { roomId: currentRoomId, epoch: currentEpoch } = getDappCredentials(dappId);
  if (!currentRoomId) throw new Error('rotation: dapp has no room credentials yet');

  const exclude = new Set(options.exclude ?? []);
  const epoch = currentEpoch + 1;
  const roomId = `dapp-${crypto.randomUUID()}`;
  const roomPassword = generateRoomPassword();
  const rotatedAt = new Date().toISOString();
  const signing = await getSigningIdentity();

  const targets: Array<{ publicKey: string; encPublicKey: string }> = [];
  const skipped: string[] = [];
  doc.getMap('members').forEach((raw, publicKey) => {
    if (publicKey === identity.publicKey || exclude.has(publicKey)) return;
    const encPublicKey = (raw as Y.Map<unknown>).get('encPublicKey') as string | undefined;
    if (encPublicKey) targets.push({ publicKey, encPublicKey });
    else skipped.push(publicKey);
  });

  const rekeyed: string[] = [];
  for (const target of targets) {
    const payload = await encryptMessage(target.encPublicKey, `${roomId}:${roomPassword}:${epoch}`);
    await writeSignedRekeyEntry(doc, { epoch, forKey: target.publicKey, payload, rotatedAt }, signing);
    rekeyed.push(target.publicKey);
  }

  updateDappCredentials(dappId, roomId, roomPassword, epoch);
  const delay = options.reconnectDelayMs ?? RECONNECT_GRACE_MS;
  if (delay > 0) setTimeout(() => reconnectDappProviders(dappId), delay);
  else reconnectDappProviders(dappId);

  return { epoch, rekeyed, skipped };
}

/**
 * Apply the newest applicable rekey entry addressed to this device, if any:
 * verify the signer is a current owner, the Ed25519 signature holds, and the
 * epoch strictly exceeds the local room epoch; then decrypt, update the local
 * catalog, and reconnect providers. Returns true when credentials moved.
 */
export async function applyPendingRekey(dappId: string, doc: Y.Doc = getDappDoc(dappId)): Promise<boolean> {
  const identity = getIdentity();
  if (!identity) return false;
  const { epoch: currentEpoch } = getDappCredentials(dappId);

  let best: { epoch: number; entry: Record<string, unknown> } | null = null;
  doc.getMap('rekeys').forEach((raw) => {
    const entry = mapToObject(raw as Y.Map<unknown>);
    if (entry.forKey !== identity.publicKey) return;
    const epoch = Number(entry.epoch);
    if (!Number.isInteger(epoch) || epoch <= currentEpoch) return;
    if (!best || epoch > best.epoch) best = { epoch, entry };
  });
  if (!best) return false;
  const { epoch, entry } = best as { epoch: number; entry: Record<string, unknown> };

  // An epoch can only move forward, so an absurd jump would lock this device out of
  // every later, genuine rotation — refuse it no matter who signed it.
  if (epoch - currentEpoch > MAX_EPOCH_JUMP) return false;

  const signedBy = entry._signedBy as string | undefined;
  if (!signedBy) return false;
  // VERIFIED owner (auth.ts::getRole): this runs the moment the entry arrives, before
  // the auth observer had a chance to revert a forged `role: 'owner'` in the doc.
  if (getRole(dappId, signedBy) !== 'owner') return false;
  if (!(await verifySignature(entry, signedBy))) return false;

  let decrypted: string;
  try {
    decrypted = await decryptMessage(String(entry.payload));
  } catch {
    return false;
  }
  const [roomId, roomPassword, epochStr] = decrypted.split(':');
  // The plaintext epoch must match the signed entry epoch — rejects an entry
  // whose signed envelope was spliced onto a ciphertext from another rotation.
  if (!roomId || !roomPassword || Number(epochStr) !== epoch) return false;

  if (!updateDappCredentials(dappId, roomId, roomPassword, epoch)) return false;
  reconnectDappProviders(dappId);
  return true;
}

const rekeyObserversInitialized = new Set<string>();
const rekeyObserverTeardowns = new Map<string, () => void>();

/** Counterpart of `teardownAuthObserver`: a document recreated later gets a fresh rekey observer. */
export function teardownRekeyObserver(dappId: string): void {
  rekeyObserverTeardowns.get(dappId)?.();
  rekeyObserverTeardowns.delete(dappId);
  rekeyObserversInitialized.delete(dappId);
}

/** Watch the dapp's `rekeys` map and follow verified credential rotations addressed to this device. */
export function setupRekeyObserver(dappId: string): void {
  if (rekeyObserversInitialized.has(dappId)) return;
  rekeyObserversInitialized.add(dappId);

  const doc = getDappDoc(dappId);
  let applying = false;
  let queued = false;
  const check = () => {
    if (applying) {
      queued = true;
      return;
    }
    applying = true;
    applyPendingRekey(dappId, doc)
      .catch((error) => console.error('rotation: failed to apply rekey entry', error))
      .finally(() => {
        applying = false;
        if (queued) {
          queued = false;
          check();
        }
      });
  };
  const rekeys = doc.getMap('rekeys');
  rekeys.observe(check);
  rekeyObserverTeardowns.set(dappId, () => { rekeys.unobserve(check); });
  check();
}
