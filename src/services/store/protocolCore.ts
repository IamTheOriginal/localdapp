import * as Y from 'yjs';
import { bufferToHex, hexToBuffer } from '../../lib/hex.ts';
import type { MemberRole } from '../../types.ts';

/**
 * Pure record/member/tombstone protocol primitives.
 *
 * Everything here is doc-parametric and identity-parametric: it never resolves
 * documents (no getDappDoc / IndexedDB) and never reads a global identity —
 * callers pass the Y.Doc and the signing identity explicitly. This keeps the
 * module usable from Node (MCP server, twin runtime) and the browser alike,
 * with byte-identical wire formats on both sides.
 *
 * Canonicalization, signing, tombstone and member-mutation formats MUST stay
 * in sync with the P2P auth observer rules (see auth.ts). Changes here apply
 * to every peer simultaneously only after all clients update.
 */

export interface SigningIdentity {
  /** Raw 32-byte Ed25519 public key, hex-encoded. */
  publicKey: string;
  /**
   * Ed25519 private key: either PKCS#8 DER hex (Node twin, legacy browser
   * identities, tests) or a WebCrypto `CryptoKey` handle (browser identities
   * with non-extractable keys).
   */
  privateKey: string | CryptoKey;
}

// ───── Y.Map ⇄ plain object ─────

export function mapToObject(map: Y.Map<unknown>): Record<string, unknown> {
  const plain: Record<string, unknown> = {};
  map.forEach((value, key) => { plain[key] = value; });
  return plain;
}

export function yMapFromObject(data: Record<string, unknown>): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  Object.entries(data).forEach(([key, value]) => map.set(key, value));
  return map;
}

/** Overwrites a map in place so it holds exactly `data` (drops keys not in `data`). */
export function writeObjectToMap(map: Y.Map<unknown>, data: Record<string, unknown>): void {
  Array.from(map.keys()).forEach((key) => {
    if (!(key in data)) map.delete(key);
  });
  Object.entries(data).forEach(([key, value]) => map.set(key, value));
}

/** `config.meta.createdBy` — the one member who can never be removed. */
/** Name initDappDoc gave every founder entry before it used the device name; still the fallback for a nameless device. */
export const FOUNDER_PLACEHOLDER_NAME = 'Owner';

export function foundingOwnerOf(doc: Y.Doc): string | undefined {
  const meta = doc.getMap('config').get('meta') as Y.Map<unknown> | undefined;
  const createdBy = meta?.get('createdBy');
  return typeof createdBy === 'string' && createdBy ? createdBy : undefined;
}

/**
 * "Now", but never earlier than what it has to supersede. Precedence between signed
 * entries is wall-clock based (member entry vs. removal, record vs. tombstone); with a
 * plain `new Date()` a device whose clock runs BEHIND the previous writer's produced
 * entries every peer silently rejected — a removal or delete that undid itself.
 */
export function timestampAfter(...previous: unknown[]): string {
  let floor = 0;
  for (const value of previous) {
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(parsed)) floor = Math.max(floor, parsed + 1);
  }
  return new Date(Math.max(Date.now(), floor)).toISOString();
}

// ───── Canonical JSON ─────

function canonicalString(record: Record<string, unknown>): string {
  // Stable JSON stringification excluding signature meta-fields
  const data: Record<string, unknown> = { ...record };
  delete data._signature;
  delete data._signedBy;
  return stableStringify(data);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(obj[key])}`
  )).join(',')}}`;
}

// ───── Signing ─────

/** Sign record data with an explicit Ed25519 identity. */
export async function signWithIdentity(
  identity: SigningIdentity,
  record: Record<string, unknown>,
): Promise<{ _signedBy: string; _signature: string }> {
  const canonical = canonicalString(record);
  const data = new TextEncoder().encode(canonical);

  const privateKey = typeof identity.privateKey === 'string'
    ? await crypto.subtle.importKey(
      'pkcs8',
      hexToBuffer(identity.privateKey),
      { name: 'Ed25519' },
      false,
      ['sign'],
    )
    : identity.privateKey;

  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    data,
  );

  return {
    _signedBy: identity.publicKey,
    _signature: bufferToHex(signature),
  };
}

/** Verify that a record's _signature matches the supplied signer's Ed25519 public key. */
export async function verifySignature(
  record: Record<string, unknown>,
  signerPublicKey: string,
): Promise<boolean> {
  const sig = record._signature as string | undefined;
  if (!sig) return false;

  const canonical = canonicalString(record);
  const data = new TextEncoder().encode(canonical);

  try {
    const publicKey = await crypto.subtle.importKey(
      'raw',
      hexToBuffer(signerPublicKey),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );

    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      hexToBuffer(sig),
      data,
    );
  } catch {
    return false;
  }
}

// ───── Signed mutations ─────

export interface MemberWriteInput {
  publicKey: string;
  name: string;
  role: MemberRole;
  /**
   * Member's RSA-OAEP public key (JWK string). Needed to re-encrypt room
   * credentials to this member during credential rotation; members without
   * one cannot be re-keyed and lose access on rotation.
   */
  encPublicKey?: string;
  /**
   * The invite this member was admitted through. Part of the owner-signed entry,
   * so the number of admissions per invite cannot be forged — it is what caps an
   * invite's uses (the `usesLeft` counter in the invite is only bookkeeping).
   */
  viaInvite?: string;
}

/**
 * Write an owner-signed member entry (with memberUpdatedAt) into
 * `members` and clear any tombstone for that key — the exact format
 * `isAuthorizedMemberMutation` accepts on honest peers.
 */
export async function writeSignedMember(
  doc: Y.Doc,
  input: MemberWriteInput,
  identity: SigningIdentity,
): Promise<void> {
  const members = doc.getMap('members');
  const capabilities = {
    canEditConfig: input.role === 'owner' ? 'true' : 'false',
    canInvite: input.role === 'owner' ? 'true' : 'false',
  };
  // A rename or role change must not forget the member's encryption key: it is
  // what credential grants (rejoin, rotation) are encrypted to.
  const stored = members.get(input.publicKey) as Y.Map<unknown> | undefined;
  const tombstone = doc.getMap('memberTombstones').get(input.publicKey) as Y.Map<unknown> | undefined;
  const memberUpdatedAt = timestampAfter(stored?.get('memberUpdatedAt'), tombstone?.get('removedAt'));
  const storedKey = stored?.get('encPublicKey');
  const encPublicKey = input.encPublicKey || (typeof storedKey === 'string' ? storedKey : '');
  // Same for the invite a member came through — a role change must not free that invite's use.
  const storedInvite = stored?.get('viaInvite');
  const viaInvite = input.viaInvite || (typeof storedInvite === 'string' ? storedInvite : '');
  const payload: Record<string, unknown> = {
    publicKey: input.publicKey,
    name: input.name,
    role: input.role,
    memberUpdatedAt,
    ...capabilities,
    ...(encPublicKey ? { encPublicKey } : {}),
    ...(viaInvite ? { viaInvite } : {}),
  };
  const signature = await signWithIdentity(identity, payload);
  members.set(input.publicKey, yMapFromObject({ ...payload, ...signature }));
  doc.getMap('memberTombstones').delete(input.publicKey);
}

/**
 * Write a signed `memberTombstones` entry and drop the member in the same
 * transaction. Refuses to remove the founding owner when `foundingOwner`
 * is provided.
 */
export async function writeSignedMemberRemoval(
  doc: Y.Doc,
  publicKey: string,
  identity: SigningIdentity,
  foundingOwner?: string,
): Promise<void> {
  if (foundingOwner && publicKey === foundingOwner) {
    throw new Error('auth: The founding owner cannot be removed');
  }

  const members = doc.getMap('members');
  const tombstones = doc.getMap('memberTombstones');
  // What the member WAS travels with the tombstone: once the entry is deleted
  // nothing else in the doc says this key was allowed to write, and every
  // record it ever signed would look like "unknown signer" to a device that
  // verifies them later (reload, fresh join). `formerEntry` is the member's
  // own owner-signed entry, so the role can be proven even when the tombstone
  // is self-signed (a departure); auth.ts checks both against the entry it
  // knew before accepting the removal.
  const entry = members.get(publicKey) as Y.Map<unknown> | undefined;
  const formerEntry = entry ? mapToObject(entry) : null;
  const payload: Record<string, unknown> = {
    publicKey,
    removed: true,
    removedAt: timestampAfter(formerEntry?.memberUpdatedAt),
    ...(formerEntry && typeof formerEntry.role === 'string' ? { formerRole: formerEntry.role } : {}),
    ...(formerEntry ? { formerEntry: stableStringify(formerEntry) } : {}),
  };
  const signature = await signWithIdentity(identity, payload);
  // One transaction: a peer must never see the tombstone without the deletion (or the reverse).
  doc.transact(() => {
    tombstones.set(publicKey, yMapFromObject({ ...payload, ...signature }));
    members.delete(publicKey);
  });
}

// ───── Invites ─────
//
// An invite names a lobby every member device opens and — when it is a 1-step
// invite — tells owner devices (and the keeper) to admit whoever shows up there.
// That makes it owner-only state: it is owner-SIGNED, and auth.ts only lets
// verified invites through. Unsigned, any member (even a viewer on a patched
// client) could plant a 1-step invite and have an owner device sign a fresh key
// in as editor.
//
// Signed: everything that defines the invite. Not signed: `usesLeft`, a counter
// owners decrement for display. The real cap is `uses` against the number of
// verified members whose (owner-signed) entry names this invite (`viaInvite`).
// A deleted or used-up invite gets a signed tombstone, so nobody can put the
// still validly signed entry back.

const SIGNED_INVITE_FIELDS = ['id', 'lobbyId', 'lobbyPassword', 'uses', 'createdAt', 'autoApprove', 'autoRole'] as const;

export interface InviteWriteInput {
  id: string;
  lobbyId: string;
  lobbyPassword: string;
  /** How many devices may be admitted through this invite. */
  uses: number;
  createdAt: string;
  autoApprove?: 'true';
  autoRole?: 'editor' | 'viewer';
}

/** The signed part of an invite entry (signature fields included when present) — what verification runs over. */
export function signedInviteView(entry: Record<string, unknown>): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const field of SIGNED_INVITE_FIELDS) {
    if (entry[field] !== undefined) view[field] = entry[field];
  }
  if (entry._signedBy !== undefined) view._signedBy = entry._signedBy;
  if (entry._signature !== undefined) view._signature = entry._signature;
  return view;
}

export async function writeSignedInvite(doc: Y.Doc, input: InviteWriteInput, identity: SigningIdentity): Promise<void> {
  const payload = signedInviteView({ ...input });
  const signature = await signWithIdentity(identity, payload);
  doc.getMap('invites').set(input.id, yMapFromObject({ ...payload, ...signature, usesLeft: input.uses }));
}

/** Close an invite for good: a signed tombstone plus the deletion, in one transaction. */
export async function writeSignedInviteTombstone(doc: Y.Doc, inviteId: string, identity: SigningIdentity): Promise<void> {
  const payload: Record<string, unknown> = { inviteId, deletedAt: new Date().toISOString() };
  const signature = await signWithIdentity(identity, payload);
  doc.transact(() => {
    doc.getMap('inviteTombstones').set(inviteId, yMapFromObject({ ...payload, ...signature }));
    doc.getMap('invites').delete(inviteId);
  });
}

// ───── Credential rotation (rekey) entries ─────

interface RekeyEntryInput {
  /** Rotation epoch — strictly increasing per dapp, starting at 1. */
  epoch: number;
  /** Public key of the member this entry is addressed to. */
  forKey: string;
  /** RSA-OAEP ciphertext (hex) of `newRoomId:newRoomPassword:epoch`, encrypted to `forKey`'s encPublicKey. */
  payload: string;
  rotatedAt: string;
}

export function rekeyEntryKey(epoch: number, forKey: string): string {
  return `${epoch}:${forKey}`;
}

/**
 * Write an owner-signed rekey entry into the `rekeys` map. Peers apply an
 * entry only after verifying the signer is a current owner and the epoch is
 * strictly greater than their local room epoch — a forged or replayed entry
 * is inert on honest peers.
 */
export async function writeSignedRekeyEntry(
  doc: Y.Doc,
  input: RekeyEntryInput,
  identity: SigningIdentity,
): Promise<void> {
  const payload: Record<string, unknown> = {
    epoch: input.epoch,
    forKey: input.forKey,
    payload: input.payload,
    rotatedAt: input.rotatedAt,
  };
  const signature = await signWithIdentity(identity, payload);
  doc.getMap('rekeys').set(rekeyEntryKey(input.epoch, input.forKey), yMapFromObject({ ...payload, ...signature }));
}

/**
 * Write a signed `recordTombstones` entry and remove the row in the same
 * transaction — the deletion format honest peers accept. Returns false when
 * the record does not exist (no write is performed).
 */
export async function writeSignedRecordTombstone(
  doc: Y.Doc,
  entityId: string,
  recordId: string,
  identity: SigningIdentity,
): Promise<boolean> {
  const data = doc.getMap('data');
  const container = data.get(entityId);
  if (!container) return false;

  const writeTombstone = async (remove: () => void, record: unknown): Promise<void> => {
    const stamps = record instanceof Y.Map ? mapToObject(record) : (record ?? {}) as Record<string, unknown>;
    const payload: Record<string, unknown> = {
      entityId,
      recordId,
      deletedAt: timestampAfter(stamps.updatedAt, stamps.createdAt),
    };
    const signature = await signWithIdentity(identity, payload);
    doc.transact(() => {
      doc.getMap('recordTombstones').set(`${entityId}:${recordId}`, yMapFromObject({ ...payload, ...signature }));
      remove();
    });
  };

  // Compact collections key records by id in a Y.Map (see recordContainers.ts).
  if (container instanceof Y.Map) {
    if (!container.has(recordId)) return false;
    await writeTombstone(() => container.delete(recordId), container.get(recordId));
    return true;
  }

  const records = container as Y.Array<Y.Map<unknown>>;
  for (let i = 0; i < records.length; i++) {
    const record = records.get(i);
    if (record.get('id') === recordId) {
      await writeTombstone(() => records.delete(i, 1), record);
      return true;
    }
  }
  return false;
}
