import * as Y from 'yjs';
import { getDappDoc } from './docs.ts';
import { getIdentity, getSigningIdentity } from '../identity.ts';
import {
  foundingOwnerOf,
  mapToObject,
  signedInviteView,
  signWithIdentity,
  stableStringify,
  verifySignature,
  writeObjectToMap,
  yMapFromObject,
} from './protocolCore.ts';
import { memberBaselineFingerprint, readMemberBaseline, saveMemberBaseline } from './memberBaseline.ts';
import { readDeviceLocal, writeDeviceLocal } from './deviceStore.ts';
import type { MemberRole } from '../../types.ts';
import { containerRecords, isCompactContainer, isFieldsContainer, plainRecordValue, type CompactContainer } from './recordContainers.ts';
import { bufferToHex } from '../../lib/hex.ts';
import { AUTO_ROTATE_ON_MEMBER_REMOVAL } from './rotationPolicy.ts';
import { dataHasRecord, isPrunableTombstone } from './historyCompaction.ts';

type RequiredRole = 'owner' | 'editor';

// ───── Role Lookup ─────

// The members map in the doc is only TENTATIVE: any member (even a viewer on a
// patched client) can write `role: 'owner'` into its own entry, and the auth
// observer needs a debounce window plus a scan before it reverts that. Every
// decision that grants something must therefore read the VERIFIED members — the
// set this device's observer accepted (owner-signed adds on top of the session
// baseline). Reading the live map let a viewer, inside that window, get a forged
// rekey applied on a victim's device, pass the mesh whitelist as "owner", have
// records accepted, or become a keeper operator.
const verifiedMemberSources = new Map<string, () => Map<string, Record<string, unknown>> | null>();

const quarantinedMembers = new Map<string, Set<string>>();

/**
 * Member entries the document holds that this device can neither verify nor disprove: their
 * signature is fine, but the key that signed them is one this device never verified (usually
 * because that key joined, and re-signed this entry, while this device was offline — entries
 * are last-writer-wins, so the original owner signature is gone). They get no role and no
 * mesh access here and their records are left untouched; an owner this device DOES verify
 * re-signing the entry (any rename or role change) resolves it.
 */
export function getQuarantinedMembers(dappId: string): ReadonlySet<string> {
  return quarantinedMembers.get(dappId) ?? new Set();
}

/** The members this device's auth observer accepted; null until a baseline exists (no observer yet, doc still empty). */
export function getVerifiedMembers(dappId: string): ReadonlyMap<string, Record<string, unknown>> | null {
  return verifiedMemberSources.get(dappId)?.() ?? null;
}

const verifiedMemberListeners = new Map<string, Set<() => void>>();

/**
 * Fires when the verified member set (keys or roles) changed. The member mesh listens:
 * a device approved a moment ago may have dialed BEFORE its entry was verified and been
 * refused — the mesh forgets such refusals and invites a reconnect at this point.
 */
export function onVerifiedMembersChange(dappId: string, listener: () => void): () => void {
  let listeners = verifiedMemberListeners.get(dappId);
  if (!listeners) {
    listeners = new Set();
    verifiedMemberListeners.set(dappId, listeners);
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function memberSetFingerprint(members: Map<string, Record<string, unknown>> | null): string {
  if (!members) return '';
  return [...members].map(([key, entry]) => `${key}:${typeof entry.role === 'string' ? entry.role : ''}`).sort().join('|');
}

/** One verified member entry; `undefined` while no verified set exists yet (callers then fall back to the doc). */
export function getVerifiedMember(dappId: string, publicKey: string): Record<string, unknown> | null | undefined {
  const verified = getVerifiedMembers(dappId);
  return verified ? verified.get(publicKey) ?? null : undefined;
}

function asMemberRole(role: unknown): MemberRole | null {
  return role === 'owner' || role === 'editor' || role === 'viewer' ? role : null;
}

/**
 * The role of a public key in a dapp: from the verified members once the auth
 * observer has a baseline, from the doc before that (a dapp that was just
 * created or is still loading — nothing was accepted from a peer yet).
 */
export function getRole(dappId: string, publicKey: string): MemberRole | null {
  const verified = getVerifiedMember(dappId, publicKey);
  if (verified !== undefined) return asMemberRole(verified?.role);
  const member = getDappDoc(dappId).getMap('members').get(publicKey) as Y.Map<unknown> | undefined;
  return asMemberRole(member?.get('role'));
}

/**
 * Assert the current device identity has at least `requiredRole` in the dapp.
 * Throws if the user is not a member or their role is insufficient.
 * This is the LOCAL enforcement gate — prevents UI bypasses and honest mistakes.
 */
export function requireRole(dappId: string, requiredRole: RequiredRole): void {
  const identity = getIdentity();
  if (!identity) throw new Error('auth: No identity — cannot write');
  const role = getRole(dappId, identity.publicKey);
  if (!role) throw new Error('auth: Not a member of this dapp');
  if (requiredRole === 'owner' && role !== 'owner') {
    throw new Error('auth: Only owners can perform this action');
  }
  if (requiredRole === 'editor' && role === 'viewer') {
    throw new Error('auth: Viewers cannot write data');
  }
}

// ───── Record Signing (Ed25519) ─────
//
// Canonicalization and crypto primitives live in protocolCore.ts so the MCP
// server and twin runtime share byte-identical formats; this wrapper binds
// them to the browser device identity. Verification is protocolCore's
// verifySignature directly — it needs no identity.

/** Sign record data with the current device's Ed25519 private key. */
export async function signRecord(
  record: Record<string, unknown>,
): Promise<{ _signedBy: string; _signature: string }> {
  const identity = getIdentity();
  if (!identity) throw new Error('auth: No identity to sign with');

  return signWithIdentity(await getSigningIdentity(), record);
}

// ───── P2P Auth Observer ─────
//
// After every Yjs update (local or synced from a peer), this observer scans
// all data records and reverts any that are:
//   (a) unsigned,
//   (b) signed by an unknown public key,
//   (c) signed by a viewer, or
//   (d) signed by a known public key whose Ed25519 signature doesn't verify.
//
// This provides P2P enforcement: every honest peer independently validates
// every mutation it receives and rejects invalid ones.

const observersInitialized = new Set<string>();
const observerTeardowns = new Map<string, () => void>();
const observerBusyChecks = new Map<string, () => boolean>();

/**
 * Resolves once no auth observer has a scan scheduled or running. Enforcement is
 * asynchronous (debounced scan, WebCrypto), so "the observer accepted / reverted X" can
 * only be asserted after this — a fixed sleep either races the scan under load or, for
 * "nothing was reverted" checks, passes without the scan having run at all.
 */
export async function whenAuthObserversIdle(timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    // One macrotask first: a write made just before this call has scheduled its scan by then.
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    if (![...observerBusyChecks.values()].some((busy) => busy())) return;
    if (Date.now() - started > timeoutMs) throw new Error('auth observer did not become idle in time');
  }
}

/**
 * Forget a dapp's observer when its document is destroyed (deleted or left).
 * Without it the singleton guard above kept a document recreated later in the
 * same session — a rejoin — without any validation at all.
 */
export function teardownAuthObserver(dappId: string): void {
  observerTeardowns.get(dappId)?.();
  observerTeardowns.delete(dappId);
  observerBusyChecks.delete(dappId);
  observersInitialized.delete(`dapp-${dappId}`);
  verifiedSnapshotSources.delete(dappId);
  verifiedMemberSources.delete(dappId);
  formerMemberSources.delete(dappId);
  verifiedInviteSources.delete(dappId);
  quarantinedMembers.delete(dappId);
}

// ───── Verified-records feed (read-model projection, docs/plans/2026-08-24-read-model.md) ─────
//
// The read model must only ever see records this observer accepted. Each scan
// emits its accepted upserts and verified deletions; the projector can also
// pull a copy of the full verified set (available once the first scan of the
// session completed) to reconcile a projection persisted by an earlier session.

export interface VerifiedRecordsChange {
  upserts: Array<{ entityId: string; record: Record<string, unknown> }>;
  /** `${entityId}:${recordId}` keys removed from the verified set. */
  deletes: string[];
}

const verifiedChangeListeners = new Map<string, Set<(change: VerifiedRecordsChange) => void>>();
const verifiedSnapshotSources = new Map<string, () => Map<string, Record<string, unknown>> | null>();

export function onVerifiedRecordsChange(dappId: string, listener: (change: VerifiedRecordsChange) => void): () => void {
  let listeners = verifiedChangeListeners.get(dappId);
  if (!listeners) {
    listeners = new Set();
    verifiedChangeListeners.set(dappId, listeners);
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Copy of the verified record set, or null until this session's first scan completed. */
export function getVerifiedRecordsSnapshot(dappId: string): Map<string, Record<string, unknown>> | null {
  return verifiedSnapshotSources.get(dappId)?.() ?? null;
}

function emitVerifiedChange(dappId: string, change: VerifiedRecordsChange): void {
  if (change.upserts.length === 0 && change.deletes.length === 0) return;
  verifiedChangeListeners.get(dappId)?.forEach((listener) => {
    try {
      listener(change);
    } catch (error) {
      console.error('verified-records listener failed', error);
    }
  });
}

export function setupAuthObserver(dappId: string, options: { scanDebounceMs?: number } = {}): void {
  const key = `dapp-${dappId}`;
  if (observersInitialized.has(key)) return;
  observersInitialized.add(key);

  const doc = getDappDoc(dappId);
  const members = doc.getMap('members');
  // Where a session's member baseline comes from:
  //
  // 1. The members THIS device verified in an earlier session (memberBaseline.ts). The loaded
  //    document is then judged against them by the normal rules — an entry that is not in the
  //    baseline has to be owner-signed like any other change, so forged state that reached the
  //    local database before the first scan no longer passes as history (review item 1.9).
  // 2. First sight of the dapp on this device (nothing stored, and every failure of the store
  //    reads as nothing stored): the list as found, trust on first use — the same footing as
  //    the founder pin below, and the same footing every session had before.
  //
  // What it is NOT, in either case, is a list rebuilt from the founder: entries are
  // last-writer-wins, so once two owners have edited each other's entry (a rename, a role
  // change) each carries only its latest signer, the two vouch for each other, the original
  // "the founder added A" link is gone from the document, and a rebuild deletes both of them
  // and everyone they added. It did exactly that to a real dapp on 2026-09-18
  // (`memberCrossSigned.test.ts`). Nothing here may ever delete a member for lack of a chain.
  const storedBaseline = readMemberBaseline(dappId);
  let validMembers: Map<string, Record<string, unknown>> | null = storedBaseline?.members
    ?? (members.size > 0 ? snapshotMap(dappId, 'members') : null);
  let validMemberTombstones = storedBaseline?.tombstones ?? snapshotMap(dappId, 'memberTombstones');
  let validRecords = snapshotRecords(dappId);
  let validRecordTombstones = snapshotMap(dappId, 'recordTombstones');
  // key → SHA-256 of the canonical snapshot of records whose signatures THIS
  // session verified; lets rescans skip unchanged records without ever
  // trusting the load baseline, without retaining full snapshot strings.
  const verifiedRecords = new Map<string, string>();
  let validRoleAssignments = snapshotMap(dappId, 'roleAssignments');
  let validFiles = snapshotMap(dappId, 'files');
  let validFileTombstones = snapshotMap(dappId, 'fileTombstones');
  let pendingCheck: ReturnType<typeof setTimeout> | null = null;
  let isScanning = false;
  let needsRescan = false;
  let firstRecordScanDone = false;
  verifiedSnapshotSources.set(dappId, () => (firstRecordScanDone ? new Map(validRecords) : null));
  verifiedMemberSources.set(dappId, () => validMembers);
  formerMemberSources.set(dappId, () => (validMembers ? { members: validMembers, tombstones: validMemberTombstones } : null));
  // Invites start EMPTY, not from a load baseline: an invite grants admission, so every
  // one is verified from scratch each session (unlike members, nothing depends on them).
  let validInvites = new Map<string, Record<string, unknown>>();
  let validInviteTombstones = new Map<string, Record<string, unknown>>();
  let inviteScanDone = false;
  verifiedInviteSources.set(dappId, () => (inviteScanDone ? validInvites : null));

  // Trailing debounce: during bulk writes (imports, photo matching) every
  // update used to trigger its own full-document scan — quadratic work that
  // starves the tab and its WebRTC connections. Batching to one scan per
  // window keeps enforcement equivalent (reverts were always asynchronous)
  // at a fraction of the cost.
  const SCAN_DEBOUNCE_MS = options.scanDebounceMs ?? 300;

  let disposed = false;

  // Persisting the verified set is coalesced into at most one write per scan window: member
  // changes arrive in bursts (an owner adds a device and renames it), and the scan itself runs
  // every SCAN_DEBOUNCE_MS while records are being written in bulk. A failed write is logged
  // and forgotten — it costs the next session nothing but starting from the document again.
  let persistedFingerprint = storedBaseline
    ? memberBaselineFingerprint(storedBaseline.members, storedBaseline.tombstones)
    : null;
  let pendingPersist: ReturnType<typeof setTimeout> | null = null;
  const schedulePersist = () => {
    if (pendingPersist || disposed) return;
    pendingPersist = setTimeout(() => {
      pendingPersist = null;
      if (disposed || !validMembers) return;
      const fingerprint = memberBaselineFingerprint(validMembers, validMemberTombstones);
      if (fingerprint === persistedFingerprint) return;
      persistedFingerprint = saveMemberBaseline(dappId, validMembers, validMemberTombstones) ? fingerprint : null;
    }, SCAN_DEBOUNCE_MS);
  };

  const scheduleScan = () => {
    if (pendingCheck || disposed) return;
    pendingCheck = setTimeout(() => void (async () => {
      pendingCheck = null;
      if (disposed) return;
      if (isScanning) {
        needsRescan = true;
        return;
      }

      isScanning = true;
      try {
        do {
          needsRescan = false;
          // Baseline-capture scans (validMembers === null) must not count
          // their tombstones as fresh departures — only tombstones accepted
          // after a baseline exists can trigger the departure rotation.
          const hadBaseline = validMembers !== null;
          enforceFounderPin(dappId);
          const tombstoneKeysBefore = new Set(validMemberTombstones.keys());
          const membersBefore = memberSetFingerprint(validMembers);
          const memberScan = await scanAndRevertUnauthorizedMembers(dappId, validMembers, validMemberTombstones);
          validMembers = memberScan.members;
          validMemberTombstones = memberScan.tombstones;
          if (memberScan.quarantined.size > 0 || quarantinedMembers.has(dappId)) {
            const before = quarantinedMembers.get(dappId);
            quarantinedMembers.set(dappId, memberScan.quarantined);
            if (memberScan.quarantined.size > 0 && before?.size !== memberScan.quarantined.size) {
              console.warn(`auth: ${memberScan.quarantined.size} member entr${memberScan.quarantined.size === 1 ? 'y' : 'ies'} of dapp ${dappId} cannot be verified on this device — `
                + 'they were signed by a key this device never verified. They are left untouched and count as non-members here until an owner re-confirms them.');
            }
          }
          if (memberSetFingerprint(validMembers) !== membersBefore) {
            verifiedMemberListeners.get(dappId)?.forEach((listener) => {
              try { listener(); } catch (error) { console.error('verified-members listener failed', error); }
            });
          }
          if (validMembers && memberBaselineFingerprint(validMembers, validMemberTombstones) !== persistedFingerprint) {
            schedulePersist();
          }
          if (hadBaseline) {
            let sawDeparture = false;
            validMemberTombstones.forEach((tombstone, key) => {
              if (tombstoneKeysBefore.has(key)) return;
              if (tombstone._signedBy === tombstone.publicKey) sawDeparture = true;
            });
            if (sawDeparture) void rotateAfterVerifiedDeparture(dappId);
          }
          if (validMembers) {
            const formerWriter = createFormerWriterLookup(validMembers, validMemberTombstones);
            const recordScan = await scanAndRevertUnauthorized(dappId, validRecords, validRecordTombstones, verifiedRecords, formerWriter, validMembers, memberScan.quarantined);
            validRecords = recordScan.records;
            validRecordTombstones = recordScan.tombstones;
            firstRecordScanDone = true;
            emitVerifiedChange(dappId, recordScan.changes);
            if (recordScan.mutated) needsRescan = true;
            validRoleAssignments = await scanAndRevertUnauthorizedRoleAssignments(dappId, validRoleAssignments, validMembers);
            const fileScan = await scanAndRevertUnauthorizedFiles(dappId, validFiles, validFileTombstones, validMembers, formerWriter);
            validFiles = fileScan.files;
            validFileTombstones = fileScan.tombstones;
            emitFileRemovals(dappId, fileScan.removed);
            const inviteScan = await scanAndRevertUnauthorizedInvites(dappId, validInvites, validInviteTombstones, validMembers);
            validInvites = inviteScan.invites;
            validInviteTombstones = inviteScan.tombstones;
            const firstInviteScan = !inviteScanDone;
            inviteScanDone = true;
            if (inviteScan.changed || firstInviteScan) emitVerifiedInvitesChange(dappId);
            // A member that was removed (or left) knows the lobby secrets of every invite that
            // existed then — owner devices close those invites.
            if (hadBaseline) {
              let latestRemoval = 0;
              validMemberTombstones.forEach((tombstone, key) => {
                if (tombstoneKeysBefore.has(key)) return;
                const removedAt = Date.parse(timestampText(tombstone.removedAt));
                if (Number.isFinite(removedAt)) latestRemoval = Math.max(latestRemoval, removedAt);
              });
              if (latestRemoval > 0) void closeInvitesAfterRemoval(dappId, latestRemoval);
            }
          }
        } while (needsRescan);
      } finally {
        isScanning = false;
        if (needsRescan) scheduleScan();
      }
    })(), SCAN_DEBOUNCE_MS);
  };

  const onDocUpdate = (_update: Uint8Array, origin: unknown) => {
    // Skip our own revert transactions
    if (origin === 'auth-revert') return;
    // Don't scan/revert until the members map has synced.
    // Without this guard, records can arrive via WebRTC before their signer's
    // public key is in the members map, causing the observer to (wrongly)
    // revert them as "unknown signer". When members later arrive, the records
    // get restored — which the user sees as entries flickering in/out.
    if (members.size === 0) return;
    if (isScanning) {
      needsRescan = true;
      return;
    }
    scheduleScan();
  };
  doc.on('update', onDocUpdate);
  // The pending baseline write counts as busy: a test that waits for the observer and then
  // starts a "next session" must see what this one verified, not what it had not written yet.
  observerBusyChecks.set(dappId, () => pendingCheck !== null || isScanning || pendingPersist !== null);
  observerTeardowns.set(dappId, () => {
    disposed = true;
    if (pendingCheck) clearTimeout(pendingCheck);
    pendingCheck = null;
    if (pendingPersist) clearTimeout(pendingPersist);
    pendingPersist = null;
    doc.off('update', onDocUpdate);
  });
}

// ───── Invites ─────
//
// See protocolCore.ts ("Invites") for why invites are owner-signed. An invite is
// verified when: its key is its id, its signed part carries a valid signature of
// a VERIFIED owner, and no valid tombstone closes it. Everything else is deleted
// (or restored to the verified version), exactly like members and records —
// which also removes invites written by builds that did not sign them yet.

const verifiedInviteSources = new Map<string, () => Map<string, Record<string, unknown>> | null>();
const verifiedInviteListeners = new Map<string, Set<() => void>>();

/** The verified invites of a dapp; null until this session's first invite scan completed. */
export function getVerifiedInvites(dappId: string): ReadonlyMap<string, Record<string, unknown>> | null {
  return verifiedInviteSources.get(dappId)?.() ?? null;
}

/** One verified invite (its signed fields); null when it is not verified, undefined while no scan has run yet. */
export function getVerifiedInvite(dappId: string, inviteId: string): Record<string, unknown> | null | undefined {
  const verified = getVerifiedInvites(dappId);
  return verified ? verified.get(inviteId) ?? null : undefined;
}

export function onVerifiedInvitesChange(dappId: string, listener: () => void): () => void {
  let listeners = verifiedInviteListeners.get(dappId);
  if (!listeners) {
    listeners = new Set();
    verifiedInviteListeners.set(dappId, listeners);
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function emitVerifiedInvitesChange(dappId: string): void {
  verifiedInviteListeners.get(dappId)?.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('verified-invites listener failed', error);
    }
  });
}

async function closeInvitesAfterRemoval(dappId: string, removedAt: number): Promise<void> {
  const identity = getIdentity();
  if (!identity || getRole(dappId, identity.publicKey) !== 'owner') return;
  try {
    const { closeInvites } = await import('./invites.ts');
    await closeInvites(dappId, { createdBefore: removedAt });
  } catch (error) {
    console.warn('invites: closing the invites a removed member knew failed — delete them by hand', error);
  }
}

async function isAuthorizedInvite(
  inviteId: string,
  invite: Record<string, unknown>,
  validMembers: Map<string, Record<string, unknown>>,
  validTombstones: Map<string, Record<string, unknown>>,
): Promise<boolean> {
  if (invite.id !== inviteId) return false;
  if (typeof invite.lobbyId !== 'string' || !invite.lobbyId || typeof invite.lobbyPassword !== 'string' || !invite.lobbyPassword) return false;
  if (typeof invite.uses !== 'number' || !Number.isInteger(invite.uses) || invite.uses < 1) return false;
  if (!Number.isFinite(Date.parse(timestampText(invite.createdAt)))) return false;
  if (invite.autoApprove !== undefined && invite.autoApprove !== 'true') return false;
  if (invite.autoRole !== undefined && invite.autoRole !== 'editor' && invite.autoRole !== 'viewer') return false;
  if (validTombstones.has(inviteId)) return false; // closed for good — a signed entry cannot be put back
  const signedBy = invite._signedBy;
  if (typeof signedBy !== 'string' || validMembers.get(signedBy)?.role !== 'owner') return false;
  return verifySignature(invite, signedBy);
}

async function isAuthorizedInviteTombstone(
  inviteId: string,
  tombstone: Record<string, unknown>,
  validMembers: Map<string, Record<string, unknown>>,
): Promise<boolean> {
  if (tombstone.inviteId !== inviteId) return false;
  if (!Number.isFinite(Date.parse(timestampText(tombstone.deletedAt)))) return false;
  const signedBy = tombstone._signedBy;
  if (typeof signedBy !== 'string' || validMembers.get(signedBy)?.role !== 'owner') return false;
  return verifySignature(tombstone, signedBy);
}

async function scanAndRevertUnauthorizedInvites(
  dappId: string,
  validInvites: Map<string, Record<string, unknown>>,
  validTombstones: Map<string, Record<string, unknown>>,
  validMembers: Map<string, Record<string, unknown>>,
): Promise<{ invites: Map<string, Record<string, unknown>>; tombstones: Map<string, Record<string, unknown>>; changed: boolean }> {
  const doc = getDappDoc(dappId);
  const invites = doc.getMap('invites');
  const tombstones = doc.getMap('inviteTombstones');
  const before = stableStringify([...validInvites.keys()].sort());

  const tombstonesToRestore: Array<{ key: string; snapshot: Record<string, unknown> }> = [];
  const tombstonesToDelete: string[] = [];
  const checks: Promise<void>[] = [];
  tombstones.forEach((raw, key) => {
    const tombstone = mapToObject(raw as Y.Map<unknown>);
    const previous = validTombstones.get(key);
    if (previous && stableStringify(tombstone) === stableStringify(previous)) return;
    checks.push(isAuthorizedInviteTombstone(key, tombstone, validMembers).then((authorized) => {
      if (authorized) validTombstones.set(key, tombstone);
      else if (previous) tombstonesToRestore.push({ key, snapshot: previous });
      else tombstonesToDelete.push(key);
    }));
  });
  await Promise.all(checks);
  checks.length = 0;
  validTombstones.forEach((snapshot, key) => {
    if (!tombstones.has(key)) tombstonesToRestore.push({ key, snapshot });
  });

  const toRestore: Array<{ key: string; snapshot: Record<string, unknown> }> = [];
  const toDelete: string[] = [];
  invites.forEach((raw, key) => {
    // Only the signed part is compared and kept — `usesLeft` is free to change.
    const invite = signedInviteView(mapToObject(raw as Y.Map<unknown>));
    const previous = validInvites.get(key);
    if (previous && !validTombstones.has(key) && stableStringify(invite) === stableStringify(previous)) return;
    checks.push(isAuthorizedInvite(key, invite, validMembers, validTombstones).then((authorized) => {
      if (authorized) validInvites.set(key, invite);
      else if (previous && !validTombstones.has(key)) toRestore.push({ key, snapshot: previous });
      else {
        validInvites.delete(key);
        toDelete.push(key);
      }
    }));
  });
  await Promise.all(checks);

  validInvites.forEach((snapshot, key) => {
    if (invites.has(key)) return;
    if (validTombstones.has(key)) validInvites.delete(key);
    else toRestore.push({ key, snapshot }); // deleted without a tombstone — not how an owner closes an invite
  });

  if (toRestore.length > 0 || toDelete.length > 0 || tombstonesToRestore.length > 0 || tombstonesToDelete.length > 0) {
    doc.transact(() => {
      for (const key of toDelete) invites.delete(key);
      for (const key of tombstonesToDelete) tombstones.delete(key);
      for (const { key, snapshot } of tombstonesToRestore) restoreMapEntry(tombstones, key, snapshot);
      for (const { key, snapshot } of toRestore) {
        const current = invites.get(key) as Y.Map<unknown> | undefined;
        const usesLeft = current?.get('usesLeft');
        restoreMapEntry(invites, key, { ...snapshot, usesLeft: typeof usesLeft === 'number' ? usesLeft : snapshot.uses });
      }
    }, 'auth-revert');
  }

  return { invites: validInvites, tombstones: validTombstones, changed: stableStringify([...validInvites.keys()].sort()) !== before };
}

// ───── Former writers ─────
//
// A record, file or deletion stays valid after its author was removed or left —
// otherwise every device that verifies it later (each reload, each fresh join)
// would delete that person's data for everyone. The proof is the member
// tombstone: it says until when the key was a member (`removedAt`) and what it
// was (`formerRole` on an owner-signed removal; the member's own owner-signed
// entry, `formerEntry`, on a self-signed departure). Tombstones written before
// 2026-09-17 carry no proof; their author's data is only kept by the
// in-session verification cache, as before.
//
// Known limit: timestamps are writer-supplied, so a removed editor can still
// get backdated writes accepted through a peer that has not learned of the
// removal yet. That window is the documented removal lag; the alternative was
// losing the data of every removed member.

interface FormerWriter {
  /** Writes and deletions stamped after this moment are not covered. */
  removedAt: number;
  /** The (proven) role the key held when it was removed or left. */
  role: string;
}

type FormerWriterLookup = (publicKey: string) => Promise<FormerWriter | null>;

function isWriterRole(role: unknown): boolean {
  return role === 'owner' || role === 'editor';
}

/** Memoized per scan: one tombstone check per signer, however many records it signed. */
function createFormerWriterLookup(
  validMembers: Map<string, Record<string, unknown>>,
  validMemberTombstones: Map<string, Record<string, unknown>>,
): FormerWriterLookup {
  const cache = new Map<string, Promise<FormerWriter | null>>();
  const resolve = async (publicKey: string): Promise<FormerWriter | null> => {
    const tombstone = validMemberTombstones.get(publicKey);
    if (!tombstone) return null;
    const removedAt = Date.parse(timestampText(tombstone.removedAt));
    if (!Number.isFinite(removedAt)) return null;

    if (tombstone._signedBy !== publicKey) {
      // Removed by an owner (the tombstone is only in the valid set because an
      // owner signed it), so the role it states is the owner's word.
      return isWriterRole(tombstone.formerRole) ? { removedAt, role: tombstone.formerRole as string } : null;
    }

    // Self-signed departure: the role is only worth what the embedded entry proves.
    if (typeof tombstone.formerEntry !== 'string') return null;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(tombstone.formerEntry);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      entry = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
    if (entry.publicKey !== publicKey || !isWriterRole(entry.role)) return null;
    const entrySigner = entry._signedBy;
    if (typeof entrySigner !== 'string' || validMembers.get(entrySigner)?.role !== 'owner') return null;
    return (await verifySignature(entry, entrySigner)) ? { removedAt, role: entry.role as string } : null;
  };
  return (publicKey) => {
    let pending = cache.get(publicKey);
    if (!pending) {
      pending = resolve(publicKey).catch(() => null);
      cache.set(publicKey, pending);
    }
    return pending;
  };
}

const formerMemberSources = new Map<string, () => { members: Map<string, Record<string, unknown>>; tombstones: Map<string, Record<string, unknown>> } | null>();

/**
 * Until when `publicKey` provably was an OWNER of the dapp (it was removed or left since);
 * null when it never was, or still is a member. What an owner signed while it was one —
 * the Code App source seal — stays valid after it is gone.
 */
export async function formerOwnerUntil(dappId: string, publicKey: string): Promise<number | null> {
  const source = formerMemberSources.get(dappId)?.();
  if (!source) return null;
  const former = await createFormerWriterLookup(source.members, source.tombstones)(publicKey);
  return former?.role === 'owner' ? former.removedAt : null;
}

/** Whether a former writer's proof covers something stamped `at` (a missing or unparsable stamp is never covered). */
function coveredByFormerWriter(former: FormerWriter | null, at: number): boolean {
  return former !== null && Number.isFinite(at) && at <= former.removedAt;
}

function snapshotMap(dappId: string, mapName: string): Map<string, Record<string, unknown>> {
  const snapshots = new Map<string, Record<string, unknown>>();
  getDappDoc(dappId).getMap(mapName).forEach((value, key) => snapshots.set(key, mapToObject(value as Y.Map<unknown>)));
  return snapshots;
}

/** Restores a verified snapshot into a keyed map entry (recreating the entry when it was deleted). */
function restoreMapEntry(map: Y.Map<unknown>, key: string, snapshot: Record<string, unknown>): void {
  const entry = map.get(key) as Y.Map<unknown> | undefined;
  if (entry) writeObjectToMap(entry, snapshot);
  else map.set(key, yMapFromObject(snapshot));
}

/**
 * Was `signerKey` an owner when it stamped something at `at`?
 *
 * Judged ONLY from signed, replicated evidence — the verified member entry, or the verified
 * tombstone's proof of what the key was (`createFormerWriterLookup`). Asking "is the signer an
 * owner right now", as this did before, made the verdict depend on what a device had already
 * received: a peer that had not seen an owner's removal yet kept the members that owner had
 * added while every other peer deleted them, and the two restored and deleted the same entry
 * against each other ~3 times a second for as long as the dapp was open (review item 1.6).
 * With the signed timestamps both sides reach the same answer in whatever order the entry and
 * the removal arrive.
 *
 * Residual, same class as records (see the threat model): timestamps are writer-supplied, so a
 * removed owner can backdate an entry to just before its removal and have it accepted. The
 * alternative — refusing everything a since-removed owner ever signed — would throw out every
 * member they legitimately added.
 */
function createOwnerAuthorityLookup(
  validMembers: Map<string, Record<string, unknown>>,
  validTombstones: Map<string, Record<string, unknown>>,
  founderKey?: string,
): (signerKey: string, at: number) => Promise<boolean> {
  const formerWriter = createFormerWriterLookup(validMembers, validTombstones);
  return async (signerKey, at) => {
    // The founder cannot be removed or demoted; its entry is the root every chain starts from,
    // so a `role` somebody managed to write into it must not cut every other member off.
    if (founderKey && signerKey === founderKey) return true;
    const current = validMembers.get(signerKey);
    if (current) return current.role === 'owner';
    const former = await formerWriter(signerKey);
    return former?.role === 'owner' && coveredByFormerWriter(former, at);
  };
}

/** A member entry the doc holds and the verified set does not (yet) agree with. */
interface MemberCandidate {
  publicKey: string;
  entry: Record<string, unknown>;
  /** The verified entry this one would replace; absent for a newly added member. */
  previous: Record<string, unknown> | undefined;
  stamp: number;
  signedBy: string;
  /** Shape and signature check — done once, before the resolution below runs. */
  wellFormed: boolean;
}

interface TombstoneCandidate {
  publicKey: string;
  tombstone: Record<string, unknown>;
  previous: Record<string, unknown> | undefined;
  removedAt: number;
  signedBy: string;
  wellFormed: boolean;
}

async function checkMemberShape(candidate: MemberCandidate): Promise<void> {
  candidate.wellFormed = candidate.entry.publicKey === candidate.publicKey
    && Number.isFinite(candidate.stamp)
    && Boolean(candidate.signedBy)
    && await verifySignature(candidate.entry, candidate.signedBy).catch(() => false);
}

async function checkTombstoneShape(dappId: string, candidate: TombstoneCandidate): Promise<void> {
  candidate.wellFormed = candidate.tombstone.publicKey === candidate.publicKey
    && candidate.publicKey !== getFounder(dappId)
    && Number.isFinite(candidate.removedAt)
    && Boolean(candidate.signedBy)
    && await verifySignature(candidate.tombstone, candidate.signedBy).catch(() => false);
}

async function isAuthorizedMemberMutation(
  candidate: MemberCandidate,
  validMembers: Map<string, Record<string, unknown>>,
  validTombstones: Map<string, Record<string, unknown>>,
  wasOwnerAt: (signerKey: string, at: number) => Promise<boolean>,
): Promise<boolean> {
  if (!candidate.wellFormed) return false;
  const previousUpdatedAt = Date.parse(timestampText(validMembers.get(candidate.publicKey)?.memberUpdatedAt));
  if (Number.isFinite(previousUpdatedAt) && candidate.stamp <= previousUpdatedAt) return false;

  const tombstone = validTombstones.get(candidate.publicKey);
  if (tombstone) {
    const removedAt = Date.parse(timestampText(tombstone.removedAt));
    if (Number.isFinite(removedAt) && removedAt >= candidate.stamp) return false;
  }
  return wasOwnerAt(candidate.signedBy, candidate.stamp);
}

async function isAuthorizedMemberRemoval(
  candidate: TombstoneCandidate,
  validMembers: Map<string, Record<string, unknown>>,
  wasOwnerAt: (signerKey: string, at: number) => Promise<boolean>,
): Promise<boolean> {
  if (!candidate.wellFormed) return false;
  const { publicKey, tombstone, removedAt } = candidate;

  const currentMember = validMembers.get(publicKey);
  const memberUpdatedAt = Date.parse(timestampText(currentMember?.memberUpdatedAt));
  if (Number.isFinite(memberUpdatedAt) && memberUpdatedAt > removedAt) return false;
  // The tombstone's proof of the former role later decides whether this key's
  // records stay valid (formerWriterLookup). While we still know the entry, it
  // must be exactly that entry — a demoted viewer must not leave with an old
  // "editor" entry and thereby legitimize backdated records.
  if (currentMember) {
    if (tombstone.formerRole !== undefined && tombstone.formerRole !== currentMember.role) return false;
    if (tombstone.formerEntry !== undefined && tombstone.formerEntry !== stableStringify(currentMember)) return false;
  }

  // A member may always remove THEMSELVES ("leave dapp"), never others. Anyone else must have
  // been an owner when they stamped the removal — judged like every other signature here, so
  // an owner that was itself removed afterwards does not make its earlier removals invalid
  // again on the peers that learn of the two in the other order.
  if (candidate.signedBy === publicKey) return true;
  return wasOwnerAt(candidate.signedBy, removedAt);
}

// ───── Founder pin ─────
//
// `config.meta.createdBy` names the one member nobody can remove — but the config map
// is writable by every member, so a co-owner (or viewer) could name ITSELF founder:
// its removal of the real founder would pass everywhere and it would be unremovable.
// Each device therefore pins the first founder it saw for a dapp (device-local,
// trust on first use — for a joiner that is what the approving owner served) and
// puts the pinned value back when the field changes.

const FOUNDER_PIN_PREFIX = 'vibedapp:founder:';
const pinnedFounders = new Map<string, string>();

function readFounderPin(dappId: string): string | undefined {
  const cached = pinnedFounders.get(dappId);
  if (cached) return cached;
  // Device-local storage, not localStorage directly: on the keeper localStorage is a volatile
  // polyfill, so the pin was re-taken from the document at every boot (deviceStore.ts).
  const stored = readDeviceLocal(FOUNDER_PIN_PREFIX + dappId);
  if (stored && /^[0-9a-f]{64}$/i.test(stored)) {
    pinnedFounders.set(dappId, stored);
    return stored;
  }
  return undefined;
}

/** The founder this device pinned for the dapp; before a pin exists, what the doc says. */
export function getFounder(dappId: string, doc: Y.Doc = getDappDoc(dappId)): string | undefined {
  return readFounderPin(dappId) ?? foundingOwnerOf(doc);
}

function enforceFounderPin(dappId: string): void {
  const doc = getDappDoc(dappId);
  const claimed = foundingOwnerOf(doc);
  const pinned = readFounderPin(dappId);
  if (!pinned) {
    if (!claimed) return;
    pinnedFounders.set(dappId, claimed);
    writeDeviceLocal(FOUNDER_PIN_PREFIX + dappId, claimed); // no storage: the pin lives for this session
    return;
  }
  if (claimed === pinned) return;
  const meta = doc.getMap('config').get('meta');
  if (!(meta instanceof Y.Map)) return; // nothing to restore into; removal checks use the pin regardless
  console.warn(`auth: the founder of dapp ${dappId} was rewritten — restoring the pinned founder`);
  doc.transact(() => { meta.set('createdBy', pinned); }, 'auth-revert');
}

// ───── Voluntary departures ("leave dapp") ─────
//
// When a member writes a self-signed removal tombstone and departs, their
// cached room credentials keep granting read access until the room rotates.
// The founding owner's device (unique, can never be removed — a deterministic
// single rotator) closes that hole by rotating credentials when it observes a
// newly accepted self-removal. Residual risks match owner-initiated removal:
// if the founding owner never comes online no rotation happens, and the same
// identity active on two devices can race itself (strictly-increasing epochs
// keep peers on the winner's room).

async function rotateAfterVerifiedDeparture(dappId: string): Promise<void> {
  if (!AUTO_ROTATE_ON_MEMBER_REMOVAL) return; // switched off for now — see rotationPolicy.ts
  const identity = getIdentity();
  if (!identity) return;
  const doc = getDappDoc(dappId);
  if (getFounder(dappId, doc) !== identity.publicKey) return;
  if (getRole(dappId, identity.publicKey) !== 'owner') return;
  try {
    const { rotateDappCredentials } = await import('./rotation.ts');
    await rotateDappCredentials(dappId, { doc });
  } catch (error) {
    console.warn('rotation: credential rotation after a member left failed — the departed member may retain read access', error);
  }
}

async function scanAndRevertUnauthorizedMembers(
  dappId: string,
  knownMembers: Map<string, Record<string, unknown>> | null,
  knownTombstones: Map<string, Record<string, unknown>>,
): Promise<{
  members: Map<string, Record<string, unknown>> | null;
  tombstones: Map<string, Record<string, unknown>>;
  /** Member keys the document holds that this device can neither verify nor disprove (see below). */
  quarantined: Set<string>;
}> {
  const doc = getDappDoc(dappId);
  const members = doc.getMap('members');
  // No baseline yet means no stored one either (setupAuthObserver) — the first sight of this
  // dapp on this device. Persistence/provider sync can populate members after the observer
  // was installed, so the first non-empty member set becomes the baseline, trust on first use;
  // later mutations must be authorized or are reverted to it.
  if (!knownMembers) {
    if (members.size === 0) return { members: null, tombstones: knownTombstones, quarantined: new Set() };
    // Tombstones present at baseline capture join the baseline alongside the members
    // themselves; they are historical state, not fresh departures (see the departure-rotation
    // trigger in setupAuthObserver).
    return { members: snapshotMap(dappId, 'members'), tombstones: snapshotMap(dappId, 'memberTombstones'), quarantined: new Set() };
  }
  const validMembers = knownMembers;
  const validTombstones = knownTombstones;

  const tombstones = doc.getMap('memberTombstones');
  const toRestore: Array<{ publicKey: string; snapshot: Record<string, unknown> }> = [];
  const toDelete: string[] = [];
  const tombstonesToRestore: Array<{ publicKey: string; snapshot: Record<string, unknown> }> = [];
  const tombstonesToDelete: string[] = [];

  const seen = new Set<string>();
  const checks: Promise<void>[] = [];

  // Everything the doc says that the verified set does not agree with yet.
  const memberCandidates: MemberCandidate[] = [];
  members.forEach((rawMember, publicKey) => {
    seen.add(publicKey);
    const current = mapToObject(rawMember as Y.Map<unknown>);
    const previous = validMembers.get(publicKey);
    if (previous && stableStringify(current) === stableStringify(previous)) return;
    memberCandidates.push({
      publicKey,
      entry: current,
      previous,
      stamp: Date.parse(timestampText(current.memberUpdatedAt)),
      signedBy: typeof current._signedBy === 'string' ? current._signedBy : '',
      wellFormed: false,
    });
  });

  const seenTombstones = new Set<string>();
  const tombstoneCandidates: TombstoneCandidate[] = [];
  tombstones.forEach((rawTombstone, publicKey) => {
    seenTombstones.add(publicKey);
    const tombstone = mapToObject(rawTombstone as Y.Map<unknown>);
    const previous = validTombstones.get(publicKey);
    if (previous && stableStringify(tombstone) === stableStringify(previous)) return;
    tombstoneCandidates.push({
      publicKey,
      tombstone,
      previous,
      removedAt: Date.parse(timestampText(tombstone.removedAt)),
      signedBy: typeof tombstone._signedBy === 'string' ? tombstone._signedBy : '',
      wellFormed: false,
    });
  });

  // Signatures and shapes first — they do not depend on anything else and cost the most.
  await Promise.all([
    ...memberCandidates.map((candidate) => checkMemberShape(candidate)),
    ...tombstoneCandidates.map((candidate) => checkTombstoneShape(dappId, candidate)),
  ]);

  // Then accept what is acceptable, over and over until a pass accepts nothing new. A batch can
  // carry a chain — an owner adds a second owner, who adds a member — and evaluating those in
  // map order (or whichever promise happened to resolve first) deleted the last link and left
  // the peers to restore and delete it against each other. A fixpoint is order-independent.
  const openMembers = new Set(memberCandidates);
  const openTombstones = new Set(tombstoneCandidates);
  for (let accepted = true; accepted;) {
    accepted = false;
    const wasOwnerAt = createOwnerAuthorityLookup(validMembers, validTombstones, getFounder(dappId));
    for (const candidate of [...openMembers]) {
      if (!await isAuthorizedMemberMutation(candidate, validMembers, validTombstones, wasOwnerAt)) continue;
      validMembers.set(candidate.publicKey, candidate.entry);
      openMembers.delete(candidate);
      accepted = true;
    }
    for (const candidate of [...openTombstones]) {
      if (!await isAuthorizedMemberRemoval(candidate, validMembers, wasOwnerAt)) continue;
      validTombstones.set(candidate.publicKey, candidate.tombstone);
      openTombstones.delete(candidate);
      accepted = true;
    }
  }

  // "I cannot prove this" is not "this is forged". An entry whose signature and shape are
  // fine but whose SIGNER this device has never verified — the usual reason being that the
  // signer joined while this device was offline and the entry was re-signed by it since
  // (entries are last-writer-wins, so the founder's original signature is gone) — is left
  // alone: not verified, so it gets no role, no mesh access and its records are ignored
  // (`quarantined` below), but not deleted either. Deleting it would destroy a real member on
  // this device and push that deletion to everyone else, which is exactly what the reverted
  // rebuild-from-the-founder did on 2026-09-18. Deletion stays for what IS provably wrong:
  // no signature, a signature that does not verify, a signer this device knows is not an
  // owner, a stamp that goes backwards, an entry the tombstone supersedes.
  const quarantined = new Set<string>();
  for (const candidate of openMembers) {
    const signerUnknown = candidate.wellFormed
      // A key that signed itself in proves nothing — only the founder's own entry is
      // legitimately self-signed, and the founder is in the verified set by then.
      && candidate.signedBy !== candidate.publicKey
      && !validMembers.has(candidate.signedBy)
      && !validTombstones.has(candidate.signedBy);
    if (signerUnknown) {
      if (!validMembers.has(candidate.publicKey)) quarantined.add(candidate.publicKey);
      continue;
    }
    if (candidate.previous) toRestore.push({ publicKey: candidate.publicKey, snapshot: candidate.previous });
    else toDelete.push(candidate.publicKey);
  }
  for (const candidate of openTombstones) {
    if (candidate.previous) tombstonesToRestore.push({ publicKey: candidate.publicKey, snapshot: candidate.previous });
    else tombstonesToDelete.push(candidate.publicKey);
  }

  validTombstones.forEach((snapshot, publicKey) => {
    if (!seenTombstones.has(publicKey)) tombstonesToRestore.push({ publicKey, snapshot });
  });

  const authorityNow = createOwnerAuthorityLookup(validMembers, validTombstones, getFounder(dappId));
  validMembers.forEach((snapshot, publicKey) => {
    if (seen.has(publicKey)) return;

    const tombstoneMap = tombstones.get(publicKey) as Y.Map<unknown> | undefined;
    if (tombstoneMap) {
      const tombstone = mapToObject(tombstoneMap);
      const candidate: TombstoneCandidate = {
        publicKey,
        tombstone,
        previous: validTombstones.get(publicKey),
        removedAt: Date.parse(timestampText(tombstone.removedAt)),
        signedBy: typeof tombstone._signedBy === 'string' ? tombstone._signedBy : '',
        wellFormed: false,
      };
      checks.push(checkTombstoneShape(dappId, candidate)
        .then(() => isAuthorizedMemberRemoval(candidate, validMembers, authorityNow))
        .then((authorized) => {
          if (authorized) validMembers.delete(publicKey);
          else toRestore.push({ publicKey, snapshot });
        }));
      return;
    }

    toRestore.push({ publicKey, snapshot });
  });

  await Promise.all(checks);

  // Finally, the entries this device accepted BEFORE it learned that the signer had been
  // removed. Their verdict changes the moment the tombstone arrives, and without re-checking
  // them this device went on restoring them against every peer that had the removal from the
  // start — the revert war of review item 1.6. Only keys with a verified tombstone are looked
  // at, so nothing that was simply never a member here is touched.
  const founderKey = getFounder(dappId);
  await Promise.all([...validMembers].map(async ([publicKey, entry]) => {
    if (publicKey === founderKey || !validTombstones.has(String(entry._signedBy))) return;
    const stamp = Date.parse(timestampText(entry.memberUpdatedAt));
    if (!Number.isFinite(stamp)) return; // legacy entry from the load baseline — nothing signed to judge
    if (await authorityNow(String(entry._signedBy), stamp)) return;
    validMembers.delete(publicKey);
    if (seen.has(publicKey)) toDelete.push(publicKey);
  }));

  if (toRestore.length === 0 && toDelete.length === 0 && tombstonesToRestore.length === 0 && tombstonesToDelete.length === 0) {
    return { members: validMembers, tombstones: validTombstones, quarantined };
  }

  doc.transact(() => {
    for (const publicKey of toDelete) {
      members.delete(publicKey);
    }

    for (const publicKey of tombstonesToDelete) {
      tombstones.delete(publicKey);
    }

    for (const { publicKey, snapshot } of toRestore) restoreMapEntry(members, publicKey, snapshot);
    for (const { publicKey, snapshot } of tombstonesToRestore) restoreMapEntry(tombstones, publicKey, snapshot);
  }, 'auth-revert');

  return { members: validMembers, tombstones: validTombstones, quarantined };
}

// ───── App Role Assignment Auth (Phase 2: manifest-declared roles) ─────
//
// A role assignment entry is never deleted, only overwritten with `roleId:
// null` — see roles.ts. That means, unlike members, there is no removal
// tombstone to authorize: any assignment change must be owner-signed with a
// strictly increasing `assignedAt`, exactly like a member profile mutation.

async function isAuthorizedRoleAssignment(
  publicKey: string,
  assignment: Record<string, unknown>,
  validMembers: Map<string, Record<string, unknown>>,
  validRoleAssignments: Map<string, Record<string, unknown>>,
): Promise<boolean> {
  if (assignment.publicKey !== publicKey) return false;
  const assignedAt = Date.parse(timestampText(assignment.assignedAt));
  if (!Number.isFinite(assignedAt)) return false;
  const previous = validRoleAssignments.get(publicKey);
  const previousAssignedAt = Date.parse(timestampText(previous?.assignedAt));
  if (Number.isFinite(previousAssignedAt) && assignedAt <= previousAssignedAt) return false;

  const signedBy = assignment._signedBy as string | undefined;
  if (!signedBy || signedBy !== assignment.assignedBy) return false;
  const signer = validMembers.get(signedBy);
  if (!signer || signer.role !== 'owner') return false;
  return verifySignature(assignment, signedBy);
}

async function scanAndRevertUnauthorizedRoleAssignments(
  dappId: string,
  validRoleAssignments: Map<string, Record<string, unknown>>,
  validMembers: Map<string, Record<string, unknown>>,
): Promise<Map<string, Record<string, unknown>>> {
  const doc = getDappDoc(dappId);
  const roleAssignments = doc.getMap('roleAssignments');

  const toRestore: Array<{ publicKey: string; snapshot: Record<string, unknown> }> = [];
  const toDelete: string[] = [];
  const seen = new Set<string>();
  const checks: Promise<void>[] = [];

  roleAssignments.forEach((rawAssignment, publicKey) => {
    seen.add(publicKey);
    const current = mapToObject(rawAssignment as Y.Map<unknown>);
    const previous = validRoleAssignments.get(publicKey);
    if (previous && stableStringify(current) === stableStringify(previous)) return;

    checks.push(isAuthorizedRoleAssignment(publicKey, current, validMembers, validRoleAssignments).then((authorized) => {
      if (authorized) validRoleAssignments.set(publicKey, current);
      else if (previous) toRestore.push({ publicKey, snapshot: previous });
      else toDelete.push(publicKey);
    }));
  });

  await Promise.all(checks);

  // No tombstone concept here: a baseline entry whose key vanished from the
  // live map was deleted outright, which is never an authorized operation.
  validRoleAssignments.forEach((snapshot, publicKey) => {
    if (!seen.has(publicKey)) toRestore.push({ publicKey, snapshot });
  });

  if (toRestore.length === 0 && toDelete.length === 0) return validRoleAssignments;

  doc.transact(() => {
    for (const publicKey of toDelete) roleAssignments.delete(publicKey);
    for (const { publicKey, snapshot } of toRestore) restoreMapEntry(roleAssignments, publicKey, snapshot);
  }, 'auth-revert');

  return validRoleAssignments;
}

function parseIsoTimestamp(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

// ───── Verified file removals (blob cleanup, review item 5.10) ─────
//
// A file record whose deletion this device verified names content nobody may need any
// more. Pin-all devices and keepers pinned it for the dapp; the listener
// (blobCleanup.ts) releases the local copy once no dapp on this device lists it.

type FileRemovalListener = (dappId: string, record: Record<string, unknown>) => void;
const fileRemovalListeners = new Set<FileRemovalListener>();

export function onVerifiedFileRemoved(listener: FileRemovalListener): () => void {
  fileRemovalListeners.add(listener);
  return () => { fileRemovalListeners.delete(listener); };
}

function emitFileRemovals(dappId: string, removed: Array<Record<string, unknown>>): void {
  for (const record of removed) {
    fileRemovalListeners.forEach((listener) => {
      try { listener(dappId, record); } catch (error) { console.error('file-removal listener failed', error); }
    });
  }
}

// ───── File index auth (blob store Phase 1) ─────
//
// `files` maps fileId → signed FileRecord; `fileTombstones` maps fileId →
// signed {fileId, deletedAt}. Records are immutable: an overwrite is accepted
// only as a re-add with a strictly newer createdAt (same precedence model as
// members). Owners and editors may add and delete; viewers may not.

async function isAuthorizedFileRecord(
  fileId: string,
  record: Record<string, unknown>,
  validMembers: Map<string, Record<string, unknown>>,
  validTombstones: Map<string, Record<string, unknown>>,
  previous: Record<string, unknown> | undefined,
  formerWriter: FormerWriterLookup,
): Promise<boolean> {
  if (record.id !== fileId) return false;
  const createdAt = parseIsoTimestamp(record.createdAt);
  if (!Number.isFinite(createdAt)) return false;

  const previousCreatedAt = parseIsoTimestamp(previous?.createdAt);
  if (Number.isFinite(previousCreatedAt) && createdAt <= previousCreatedAt) return false;

  const tombstone = validTombstones.get(fileId);
  if (tombstone) {
    const deletedAt = parseIsoTimestamp(tombstone.deletedAt);
    if (Number.isFinite(deletedAt) && deletedAt >= createdAt) return false;
  }

  const signedBy = record._signedBy as string | undefined;
  if (!signedBy) return false;
  const signer = validMembers.get(signedBy);
  if (signer ? !isWriterRole(signer.role) : !coveredByFormerWriter(await formerWriter(signedBy), createdAt)) return false;
  return verifySignature(record, signedBy);
}

async function isAuthorizedFileRemoval(
  fileId: string,
  tombstone: Record<string, unknown>,
  validMembers: Map<string, Record<string, unknown>>,
  deletedRecord: Record<string, unknown> | undefined,
  formerWriter: FormerWriterLookup,
): Promise<boolean> {
  if (tombstone.fileId !== fileId) return false;
  const deletedAt = parseIsoTimestamp(tombstone.deletedAt);
  if (!Number.isFinite(deletedAt)) return false;

  const createdAt = parseIsoTimestamp(deletedRecord?.createdAt);
  if (Number.isFinite(createdAt) && createdAt > deletedAt) return false;

  const signedBy = tombstone._signedBy as string | undefined;
  if (!signedBy) return false;
  const signer = validMembers.get(signedBy);
  if (signer ? !isWriterRole(signer.role) : !coveredByFormerWriter(await formerWriter(signedBy), deletedAt)) return false;
  return verifySignature(tombstone, signedBy);
}

async function scanAndRevertUnauthorizedFiles(
  dappId: string,
  validFiles: Map<string, Record<string, unknown>>,
  validTombstones: Map<string, Record<string, unknown>>,
  validMembers: Map<string, Record<string, unknown>>,
  formerWriter: FormerWriterLookup,
): Promise<{ files: Map<string, Record<string, unknown>>; tombstones: Map<string, Record<string, unknown>>; removed: Array<Record<string, unknown>> }> {
  const doc = getDappDoc(dappId);
  const files = doc.getMap('files');
  const removed: Array<Record<string, unknown>> = [];
  const tombstones = doc.getMap('fileTombstones');

  const toRestore: Array<{ fileId: string; snapshot: Record<string, unknown> }> = [];
  const toDelete: string[] = [];
  const tombstonesToRestore: Array<{ fileId: string; snapshot: Record<string, unknown> }> = [];
  const tombstonesToDelete: string[] = [];
  const checks: Promise<void>[] = [];

  const seenTombstones = new Set<string>();
  tombstones.forEach((rawTombstone, fileId) => {
    seenTombstones.add(fileId);
    const tombstone = mapToObject(rawTombstone as Y.Map<unknown>);
    const previous = validTombstones.get(fileId);
    if (previous && stableStringify(tombstone) === stableStringify(previous)) return;

    checks.push(isAuthorizedFileRemoval(fileId, tombstone, validMembers, validFiles.get(fileId), formerWriter).then((authorized) => {
      if (authorized) validTombstones.set(fileId, tombstone);
      else if (previous) tombstonesToRestore.push({ fileId, snapshot: previous });
      else tombstonesToDelete.push(fileId);
    }));
  });
  await Promise.all(checks);
  checks.length = 0;

  validTombstones.forEach((snapshot, fileId) => {
    if (seenTombstones.has(fileId)) return;
    // An owner compacted an expired tombstone away (historyCompaction.ts): let it go.
    if (isPrunableTombstone(snapshot.deletedAt, files.has(fileId))) {
      validTombstones.delete(fileId);
      return;
    }
    tombstonesToRestore.push({ fileId, snapshot });
  });

  const seen = new Set<string>();
  files.forEach((rawRecord, fileId) => {
    seen.add(fileId);
    const record = mapToObject(rawRecord as Y.Map<unknown>);
    const previous = validFiles.get(fileId);
    if (previous && stableStringify(record) === stableStringify(previous)) return;

    checks.push(isAuthorizedFileRecord(fileId, record, validMembers, validTombstones, previous, formerWriter).then((authorized) => {
      if (authorized) validFiles.set(fileId, record);
      else if (previous) toRestore.push({ fileId, snapshot: previous });
      else toDelete.push(fileId);
    }));
  });
  await Promise.all(checks);
  checks.length = 0;

  validFiles.forEach((snapshot, fileId) => {
    if (seen.has(fileId)) return;
    const tombstoneMap = tombstones.get(fileId) as Y.Map<unknown> | undefined;
    if (tombstoneMap) {
      const tombstone = mapToObject(tombstoneMap);
      checks.push(isAuthorizedFileRemoval(fileId, tombstone, validMembers, snapshot, formerWriter).then((authorized) => {
        if (authorized) {
          validFiles.delete(fileId);
          removed.push(snapshot);
        } else {
          toRestore.push({ fileId, snapshot });
        }
      }));
      return;
    }
    toRestore.push({ fileId, snapshot });
  });
  await Promise.all(checks);

  if (toRestore.length === 0 && toDelete.length === 0 && tombstonesToRestore.length === 0 && tombstonesToDelete.length === 0) {
    return { files: validFiles, tombstones: validTombstones, removed };
  }

  doc.transact(() => {
    for (const fileId of toDelete) files.delete(fileId);
    for (const fileId of tombstonesToDelete) tombstones.delete(fileId);
    for (const { fileId, snapshot } of toRestore) restoreMapEntry(files, fileId, snapshot);
    for (const { fileId, snapshot } of tombstonesToRestore) restoreMapEntry(tombstones, fileId, snapshot);
  }, 'auth-revert');

  return { files: validFiles, tombstones: validTombstones, removed };
}

/** Where a record lives inside its collection container (see recordContainers.ts). */
type RecordLocator = { kind: 'array'; index: number } | { kind: 'map'; id: string };

type RevertCandidate = {
  entityId: string;
  locator: RecordLocator;
  snapshot: string;
  /** `entity:id` of the row when it has one — see the baseline clean-up after the signature checks. */
  key?: string | null;
};

/**
 * Digest per stored compact record VALUE. Compact records are immutable plain
 * objects that Yjs hands out by reference, and every change (local or remote)
 * replaces the object — so the same object always has the same canonical form.
 * Without this, every scan re-stringified and re-hashed every record of the
 * dapp (10k records = 10k WebCrypto calls per keystroke batch); with it, a scan
 * only pays for the records that actually changed. Only the digest is kept —
 * never the canonical string (see the memory note at the digest comparison).
 */
const compactRecordDigests = new WeakMap<object, string>();

async function sha256Text(text: string): Promise<string> {
  return bufferToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

function lazySnapshot(record: Record<string, unknown>): () => string {
  let snapshot: string | undefined;
  return () => (snapshot ??= stableStringify(record));
}

function recordKey(entityId: string, recordId: unknown): string {
  return `${entityId}:${String(recordId)}`;
}

function snapshotRecords(dappId: string): Map<string, Record<string, unknown>> {
  const snapshots = new Map<string, Record<string, unknown>>();
  getDappDoc(dappId).getMap('data').forEach((containerRaw, entityId) => {
    for (const record of containerRecords(containerRaw)) {
      if (record.id !== undefined) snapshots.set(recordKey(entityId, record.id), record);
    }
  });
  return snapshots;
}

/** Restores a verified record into its collection, preserving the container's representation. */
function restoreRecord(data: Y.Map<unknown>, entityId: string, record: Record<string, unknown>): void {
  const container = data.get(entityId);
  if (isCompactContainer(container)) {
    container.set(String(record.id), { ...record });
    return;
  }
  if (isFieldsContainer(container)) {
    container.push([yMapFromObject(record)]);
    return;
  }
  // The collection itself is gone: recreate it in the only shape new collections get
  // (recordContainers.ts). A container racing this one is handled like any other
  // replaced container (recordContainerMerge.ts).
  const compact: CompactContainer = new Y.Map<Record<string, unknown>>();
  compact.set(String(record.id), { ...record });
  data.set(entityId, compact);
}

/**
 * `deletedRecord` is the verified record the tombstone removes, when this
 * session knows it. A tombstone whose record is unknown — every tombstone right
 * after a reload or a fresh join, because the record is long gone — is judged
 * on its own signature. (It used to be deleted, which stripped the replay
 * protection for deleted records on every reload and made peers that had seen
 * the deletion restore it again, in a loop.)
 */
async function isAuthorizedRecordDeletion(
  dappId: string,
  entityId: string,
  recordId: string,
  tombstone: Record<string, unknown>,
  deletedRecord: Record<string, unknown> | undefined,
  formerWriter: FormerWriterLookup,
): Promise<boolean> {
  if (tombstone.entityId !== entityId || String(tombstone.recordId) !== recordId) return false;
  const deletedAt = Date.parse(timestampText(tombstone.deletedAt));
  if (!Number.isFinite(deletedAt)) return false;
  if (deletedRecord) {
    const recordUpdatedAt = Date.parse(timestampText(deletedRecord.updatedAt || deletedRecord.createdAt));
    if (Number.isFinite(recordUpdatedAt) && deletedAt < recordUpdatedAt) return false;
  }
  const signedBy = tombstone._signedBy as string | undefined;
  if (!signedBy) return false;
  const role = getRole(dappId, signedBy);
  if (role ? !isWriterRole(role) : !coveredByFormerWriter(await formerWriter(signedBy), deletedAt)) return false;
  return verifySignature(tombstone, signedBy);
}

/**
 * `String(value || '')` for untrusted timestamp fields: primitives coerce
 * exactly as String() did; objects yield '' — Date.parse rejected their
 * '[object Object]' form as NaN anyway, so validation outcomes are identical.
 */
function timestampText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
}

function tombstoneDeletesRecord(
  tombstone: Record<string, unknown>,
  entityId: string,
  recordId: string,
  record: Record<string, unknown>,
): boolean {
  if (tombstone.entityId !== entityId || String(tombstone.recordId) !== recordId) return false;
  const deletedAt = Date.parse(timestampText(tombstone.deletedAt));
  if (!Number.isFinite(deletedAt)) return false;
  const recordUpdatedAt = Date.parse(timestampText(record.updatedAt || record.createdAt));
  return !Number.isFinite(recordUpdatedAt) || deletedAt >= recordUpdatedAt;
}

async function scanAndRevertUnauthorized(
  dappId: string,
  validRecords: Map<string, Record<string, unknown>>,
  validTombstones: Map<string, Record<string, unknown>>,
  verifiedRecords: Map<string, string>,
  formerWriter: FormerWriterLookup,
  validMembers: Map<string, Record<string, unknown>>,
  /** Signers this device can neither verify nor disprove — their rows are left untouched. */
  quarantined: Set<string>,
): Promise<{ records: Map<string, Record<string, unknown>>; tombstones: Map<string, Record<string, unknown>>; changes: VerifiedRecordsChange; mutated: boolean }> {
  const doc = getDappDoc(dappId);
  const data = doc.getMap('data');
  const tombstones = doc.getMap('recordTombstones');
  const verifiedDeletes: string[] = [];

  const toRevert: RevertCandidate[] = [];
  const signatureChecks: Promise<RevertCandidate | null>[] = [];
  const deletionChecks: Promise<void>[] = [];
  const seen = new Set<string>();
  const accepted: Array<{ key: string; record: Record<string, unknown>; digest: string }> = [];
  const tombstonesToRestore: Array<{ key: string; snapshot: Record<string, unknown> }> = [];
  const tombstonesToDelete: string[] = [];

  tombstones.forEach((rawTombstone, key) => {
    const tombstone = mapToObject(rawTombstone as Y.Map<unknown>);
    const previous = validTombstones.get(key);
    if (previous && stableStringify(tombstone) === stableStringify(previous)) return;

    const [entityId, ...recordIdParts] = key.split(':');
    const recordId = recordIdParts.join(':');
    const deletedRecord = validRecords.get(key);

    deletionChecks.push(isAuthorizedRecordDeletion(dappId, entityId, recordId, tombstone, deletedRecord, formerWriter).then((authorized) => {
      if (authorized) {
        validTombstones.set(key, tombstone);
        if (validRecords.delete(key)) verifiedDeletes.push(key);
      } else if (previous) {
        tombstonesToRestore.push({ key, snapshot: previous });
      } else {
        tombstonesToDelete.push(key);
      }
    }));
  });

  await Promise.all(deletionChecks);
  deletionChecks.length = 0;

  validTombstones.forEach((snapshot, key) => {
    const current = tombstones.get(key) as Y.Map<unknown> | undefined;
    if (current) return;
    // An owner compacted an expired tombstone away (historyCompaction.ts): let it go.
    const [entityId, ...recordIdParts] = key.split(':');
    if (isPrunableTombstone(snapshot.deletedAt, dataHasRecord(data, entityId, recordIdParts.join(':')))) {
      validTombstones.delete(key);
      return;
    }
    tombstonesToRestore.push({ key, snapshot });
  });

  interface ScanRow {
    entityId: string;
    locator: RecordLocator;
    plainRecord: Record<string, unknown>;
    /** Canonical form, computed on first use only — an unchanged compact record never needs it. */
    snapshot: () => string;
    /** The stored compact value (digest cache key); absent for legacy array records. */
    value?: object;
    key: string | null;
    signedBy?: string;
    signature?: string;
  }
  const rows: ScanRow[] = [];
  data.forEach((containerRaw, entityId) => {
    if (isFieldsContainer(containerRaw)) {
      for (let i = 0; i < containerRaw.length; i++) {
        const record = containerRaw.get(i);
        const plainRecord = mapToObject(record);
        const key = plainRecord.id !== undefined ? recordKey(entityId, plainRecord.id) : null;
        if (key) seen.add(key);
        rows.push({
          entityId,
          locator: { kind: 'array', index: i },
          plainRecord,
          snapshot: lazySnapshot(plainRecord),
          key,
          signedBy: record.get('_signedBy') as string | undefined,
          signature: record.get('_signature') as string | undefined,
        });
      }
      return;
    }
    if (isCompactContainer(containerRaw)) {
      containerRaw.forEach((valueRaw, id) => {
        const plainRecord = plainRecordValue(valueRaw);
        // A record stored under a key that is not its own id would let one
        // signed record shadow another — revert it outright.
        const plainId = plainRecord.id;
        if ((typeof plainId === 'string' || typeof plainId === 'number' ? String(plainId) : '') !== id) {
          toRevert.push({ entityId, locator: { kind: 'map', id }, snapshot: stableStringify(plainRecord) });
          return;
        }
        const key = recordKey(entityId, id);
        seen.add(key);
        rows.push({
          entityId,
          locator: { kind: 'map', id },
          plainRecord,
          snapshot: lazySnapshot(plainRecord),
          ...(valueRaw && typeof valueRaw === 'object' ? { value: valueRaw } : {}),
          key,
          signedBy: typeof plainRecord._signedBy === 'string' ? plainRecord._signedBy : undefined,
          signature: typeof plainRecord._signature === 'string' ? plainRecord._signature : undefined,
        });
      });
    }
  });
  // The verified-records skip compares content digests, not the canonical
  // strings themselves: retaining a full snapshot string per record kept a
  // second copy of the whole document in memory on large collections. SHA-256
  // (not a weak hash — a craftable collision would bypass signature
  // re-verification) over the same canonical form is retained instead.
  const rowDigests = await Promise.all(rows.map(async (row) => {
    const known = row.value ? compactRecordDigests.get(row.value) : undefined;
    if (known) return known;
    const digest = await sha256Text(row.snapshot());
    if (row.value) compactRecordDigests.set(row.value, digest);
    return digest;
  }));

  rows.forEach((row, rowIndex) => {
    const { entityId, locator, plainRecord, key, signedBy, signature } = row;
    const digest = rowDigests[rowIndex];

    if (key) {
      const [, ...recordIdParts] = key.split(':');
      const recordId = recordIdParts.join(':');
      const tombstone = validTombstones.get(key);
      if (tombstone && tombstoneDeletesRecord(tombstone, entityId, recordId, plainRecord)) {
        toRevert.push({ entityId, locator, snapshot: row.snapshot(), key });
        return;
      }
      // Byte-identical to a record this session already signature-verified →
      // nothing to re-check. The load-time baseline is deliberately NOT
      // trusted: only records a previous scan verified are skipped.
      if (verifiedRecords.get(key) === digest) return;
    }

    // Unsigned → revert
    if (!signedBy || !signature) {
      toRevert.push({ entityId, locator, snapshot: row.snapshot(), key });
      return;
    }

    // A member entry this device can neither verify nor disprove (see the member scan): its
    // rows stay exactly as they are. Reverting them would delete a real member's data over a
    // gap in this device's own knowledge, and every peer that has the member verified would
    // put it straight back.
    if (quarantined.has(signedBy)) return;

    // Unknown signer → revert, unless a member tombstone proves the key was a
    // writer when the record was stamped (its author was removed or left since).
    // Verified members only — a role a peer wrote into the doc a moment ago proves nothing yet.
    const member = validMembers.get(signedBy);
    if (!member) {
      const stampedAt = Date.parse(timestampText(plainRecord.updatedAt || plainRecord.createdAt));
      signatureChecks.push(
        formerWriter(signedBy).then(async (former) => {
          if (coveredByFormerWriter(former, stampedAt) && await verifySignature(plainRecord, signedBy)) {
            if (key) accepted.push({ key, record: plainRecord, digest });
            return null;
          }
          return { entityId, locator, snapshot: row.snapshot(), key };
        }),
      );
      return;
    }

    // Only owners and editors can write records. Viewers or malformed roles are rejected.
    if (!isWriterRole(member.role)) {
      toRevert.push({ entityId, locator, snapshot: row.snapshot(), key });
      return;
    }

    signatureChecks.push(
      verifySignature(plainRecord, signedBy).then((valid) => {
        if (valid) {
          if (key) accepted.push({ key, record: plainRecord, digest });
          return null;
        }
        return { entityId, locator, snapshot: row.snapshot(), key };
      })
    );
  });

  const invalidSignatures = (await Promise.all(signatureChecks)).filter(Boolean) as RevertCandidate[];
  toRevert.push(...invalidSignatures);

  // A reverted record must not come back from the restore baseline when the baseline copy IS
  // that record: one that was already invalid when this session loaded the doc (the load
  // baseline is unverified), or one that was fine until its author was demoted to viewer.
  // Otherwise the next scan "restores" it, the scan after removes it again — for ever, at
  // full speed. A baseline that differs is the verified version a forgery replaced; it stays
  // and is restored below.
  for (const candidate of toRevert) {
    if (!candidate.key) continue;
    const baseline = validRecords.get(candidate.key);
    if (!baseline || stableStringify(baseline) !== candidate.snapshot) continue;
    validRecords.delete(candidate.key);
    verifiedRecords.delete(candidate.key);
    verifiedDeletes.push(candidate.key);
  }

  const toRestore: Array<{ entityId: string; record: Record<string, unknown> }> = [];
  validRecords.forEach((record, key) => {
    if (seen.has(key)) return;
    const [entityId, ...recordIdParts] = key.split(':');
    const recordId = recordIdParts.join(':');
    const tombstoneMap = tombstones.get(key) as Y.Map<unknown> | undefined;
    if (tombstoneMap) {
      const tombstone = mapToObject(tombstoneMap);
      deletionChecks.push(isAuthorizedRecordDeletion(dappId, entityId, recordId, tombstone, record, formerWriter).then((authorized) => {
        if (authorized) {
          if (validRecords.delete(key)) verifiedDeletes.push(key);
          validTombstones.set(key, tombstone);
        } else {
          toRestore.push({ entityId, record });
        }
      }));
      return;
    }
    toRestore.push({ entityId, record });
  });

  await Promise.all(deletionChecks);
  accepted.forEach(({ key, record, digest }) => {
    validRecords.set(key, record);
    verifiedRecords.set(key, digest);
  });
  const changes: VerifiedRecordsChange = {
    upserts: accepted.map(({ key, record }) => {
      const [entityId] = key.split(':');
      return { entityId, record };
    }),
    deletes: verifiedDeletes,
  };

  if (toRevert.length === 0 && toRestore.length === 0 && tombstonesToRestore.length === 0 && tombstonesToDelete.length === 0) {
    return { records: validRecords, tombstones: validTombstones, changes, mutated: false };
  }

  // Revert array entries from end to start so indices stay valid; map entries
  // are key-addressed and order-independent.
  toRevert.sort((a, b) => {
    if (a.entityId !== b.entityId) return a.entityId < b.entityId ? -1 : 1;
    const left = a.locator.kind === 'array' ? a.locator.index : -1;
    const right = b.locator.kind === 'array' ? b.locator.index : -1;
    return right - left; // highest index first per entity
  });

  doc.transact(() => {
    for (const { entityId, locator, snapshot } of toRevert) {
      const container = data.get(entityId);
      if (locator.kind === 'array') {
        if (isFieldsContainer(container) && locator.index < container.length) {
          const current = container.get(locator.index);
          if (stableStringify(mapToObject(current)) === snapshot) {
            container.delete(locator.index, 1);
          }
        }
      } else if (isCompactContainer(container)) {
        const current = container.get(locator.id);
        if (current !== undefined && stableStringify(plainRecordValue(current)) === snapshot) {
          container.delete(locator.id);
        }
      }
    }

    for (const key of tombstonesToDelete) {
      tombstones.delete(key);
    }

    for (const { key, snapshot } of tombstonesToRestore) restoreMapEntry(tombstones, key, snapshot);

    for (const { entityId, record } of toRestore) {
      restoreRecord(data, entityId, record);
    }
  }, 'auth-revert');

  // The revert transaction is invisible to the observer (origin filter), so a
  // scan that mutated the doc reports it — the caller schedules one follow-up
  // pass, which restores records whose tampered copy was just removed.
  return { records: validRecords, tombstones: validTombstones, changes, mutated: true };
}
