import { readDeviceLocal, removeDeviceLocal, writeDeviceLocal } from './deviceStore.ts';

/**
 * The VERIFIED member baseline, persisted per device and per dapp.
 *
 * Without it, every session starts from the member list as the local database
 * happens to hold it (`snapshotMap(dappId, 'members')`), so anything that
 * reached that database before the first scan — a patched build, a mesh push
 * that landed first — is adopted as gospel (review item 1.9). With it, a
 * session starts from the members THIS device verified last time and judges the
 * loaded document against them by the normal rules.
 *
 * Two properties are load-bearing:
 *
 * 1. Nothing is ever deleted on the strength of a rebuild. The baseline is the
 *    set this device accepted, not a chain re-derived from the founder — that
 *    was tried on 2026-09-18 and deleted three of four members of a real dapp
 *    (member entries are last-writer-wins, so cross-signing owners carry only
 *    each other's signature; `memberCrossSigned.test.ts`).
 * 2. Every failure mode falls back to trust-on-first-use, never to "delete what
 *    is unproven": a missing, unreadable, malformed or empty baseline reads as
 *    `null`, and a baseline that cannot be written is REMOVED rather than left
 *    stale — a stale baseline is the one shape that could drop members whose
 *    only remaining signature comes from an entry it does not contain.
 *
 * The stored value is plain JSON exactly as `mapToObject` produces it. It is
 * device-local and never synced (see deviceStore.ts for the keeper's file).
 */

const BASELINE_PREFIX = 'vibedapp:members:';
/** Generous for a member list (a few hundred bytes per entry) and far below any storage quota. */
const MAX_BASELINE_BYTES = 256 * 1024;
const BASELINE_VERSION = 1;

export interface MemberBaseline {
  members: Map<string, Record<string, unknown>>;
  tombstones: Map<string, Record<string, unknown>>;
}

interface StoredBaseline {
  version: number;
  members: Record<string, Record<string, unknown>>;
  memberTombstones: Record<string, Record<string, unknown>>;
}

/**
 * Member entries and tombstones are flat records of JSON primitives — that is what
 * is signed and what survives a JSON round trip unchanged. Anything else (a nested
 * object a peer managed to write) makes the whole baseline unusable rather than
 * restoring something that no longer matches what was signed.
 */
function isFlatRecordMap(value: unknown): value is Record<string, Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    return Object.values(entry as Record<string, unknown>).every(
      (field) => field === null || ['string', 'number', 'boolean'].includes(typeof field),
    );
  });
}

function toMap(source: Record<string, Record<string, unknown>>): Map<string, Record<string, unknown>> {
  return new Map(Object.entries(source).map(([key, entry]) => [key, { ...entry }]));
}

function fromMap(source: Map<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(source);
}

/**
 * The members this device verified in an earlier session, or null when there is none —
 * the first sight of a dapp on this device, the same trust-on-first-use footing as the
 * founder pin. Null is also the answer for anything unreadable or malformed, so a
 * damaged store can never cost a member.
 */
export function readMemberBaseline(dappId: string): MemberBaseline | null {
  const raw = readDeviceLocal(BASELINE_PREFIX + dappId);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`auth: the stored member baseline of dapp ${dappId} is not valid JSON — starting from the document`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const stored = parsed as Partial<StoredBaseline>;
  if (stored.version !== BASELINE_VERSION || !isFlatRecordMap(stored.members) || !isFlatRecordMap(stored.memberTombstones)) {
    console.warn(`auth: the stored member baseline of dapp ${dappId} is malformed — starting from the document`);
    return null;
  }
  const members = toMap(stored.members);
  // An empty member set would be a baseline that agrees with nothing; treat it as absent.
  if (members.size === 0) return null;
  return { members, tombstones: toMap(stored.memberTombstones) };
}

/**
 * Store the verified set. A write that does not fit or does not land removes the
 * stored baseline instead of leaving an older one behind (see the file comment).
 * Never throws: the scan that produced the set carries on either way.
 */
export function saveMemberBaseline(
  dappId: string,
  members: Map<string, Record<string, unknown>>,
  tombstones: Map<string, Record<string, unknown>>,
): boolean {
  // Refusing to persist an empty set keeps the previous one; a dapp whose every member
  // has a valid tombstone has no members left to protect anyway.
  if (members.size === 0) return false;
  const stored: StoredBaseline = { version: BASELINE_VERSION, members: fromMap(members), memberTombstones: fromMap(tombstones) };
  if (!isFlatRecordMap(stored.members) || !isFlatRecordMap(stored.memberTombstones)) {
    console.warn(`auth: not persisting the member baseline of dapp ${dappId} — an entry holds something that is not plain JSON`);
    clearMemberBaseline(dappId);
    return false;
  }
  const payload = JSON.stringify(stored);
  if (payload.length > MAX_BASELINE_BYTES) {
    console.warn(`auth: the member baseline of dapp ${dappId} is larger than ${MAX_BASELINE_BYTES} bytes — the next session starts from the document`);
    clearMemberBaseline(dappId);
    return false;
  }
  if (writeDeviceLocal(BASELINE_PREFIX + dappId, payload)) return true;
  console.warn(`auth: could not store the member baseline of dapp ${dappId} — the next session starts from the document`);
  clearMemberBaseline(dappId);
  return false;
}

/** Forget the baseline — the dapp was purged from this device (docs.ts::purgeDappLocalResources). */
export function clearMemberBaseline(dappId: string): void {
  removeDeviceLocal(BASELINE_PREFIX + dappId);
}

/** Primitive fields only — an entry that holds anything else is not persisted in the first place. */
function fieldText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

/**
 * Cheap change detector for the persist debounce: every accepted mutation bumps
 * `memberUpdatedAt` (a stamp that is not strictly newer is rejected), so this
 * changes whenever the verified set does — without canonicalizing every entry on
 * every scan.
 */
export function memberBaselineFingerprint(
  members: Map<string, Record<string, unknown>>,
  tombstones: Map<string, Record<string, unknown>>,
): string {
  const memberPart = [...members]
    .map(([key, entry]) => `${key}/${fieldText(entry.role)}/${fieldText(entry.memberUpdatedAt)}/${fieldText(entry._signedBy)}`)
    .sort()
    .join('|');
  const tombstonePart = [...tombstones]
    .map(([key, entry]) => `${key}/${fieldText(entry.removedAt)}/${fieldText(entry._signedBy)}`)
    .sort()
    .join('|');
  return `${memberPart}#${tombstonePart}`;
}
