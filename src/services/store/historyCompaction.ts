import * as Y from 'yjs';
import { containerRecords, isCompactContainer } from './recordContainers.ts';

/**
 * Owner-side compaction of history that otherwise only grows (review item 5.10).
 *
 * - `recordTombstones` / `fileTombstones`: a tombstone is what stops a deleted
 *   record's still validly signed copy from being put back (a replay, or a peer
 *   that restores what it last verified). Once a deletion has had
 *   TOMBSTONE_RETENTION_MS to reach every device, the tombstone is dropped.
 *   The auth observer lets an expired tombstone go instead of restoring it
 *   (`isPrunableTombstone`), on every device, whoever removed it.
 *
 *   ACCEPTED TRADE-OFF (docs/security/THREAT_MODEL.md): a device that was
 *   offline for longer than the window and still holds the record comes back,
 *   receives the deletion without its tombstone, and its auth observer restores
 *   the record it last verified — the record is back for everyone. Likewise a
 *   member that kept the old signed record can re-insert it once its tombstone
 *   is gone. Neither needs more than what a writer can do anyway (write the
 *   record again); the window only bounds how long a deletion is enforced.
 *
 * - `rekeys`: credential-rotation entries below the current epoch − 1 are
 *   superseded — a device follows the NEWEST entry addressed to it
 *   (rotation.ts::applyPendingRekey), so older ones only take space. The
 *   previous epoch's entries stay for a member that is one rotation behind.
 *
 * - `memberTombstones` are NEVER pruned: a removed member's tombstone carries
 *   its former owner-signed entry (`formerEntry`), the only proof left that its
 *   key was a writer when it signed the records and files it left behind. Without
 *   it every device that verifies the document later (a reload, a fresh join)
 *   would revert all of them as "unknown signer" (auth.ts::createFormerWriterLookup).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a record or file deletion is enforced by its tombstone. */
export const TOMBSTONE_RETENTION_MS = 90 * DAY_MS;

/**
 * Observers accept the removal of a tombstone a little earlier than owners
 * prune it: a peer whose clock runs behind the pruner's must not put it back.
 */
const PRUNE_ACCEPT_AGE_MS = TOMBSTONE_RETENTION_MS - 7 * DAY_MS;

function ageOf(deletedAt: unknown, now: number): number {
  const at = typeof deletedAt === 'string' ? Date.parse(deletedAt) : Number.NaN;
  return Number.isFinite(at) ? now - at : Number.NaN;
}

/**
 * Whether the auth observer may let a verified tombstone that vanished from the
 * document go (instead of restoring it): old enough, and its record is not in
 * the document — a tombstone removed together with a replayed copy of its
 * record is still restored and the copy reverted.
 */
export function isPrunableTombstone(deletedAt: unknown, targetPresent: boolean, now: number = Date.now()): boolean {
  return !targetPresent && ageOf(deletedAt, now) >= PRUNE_ACCEPT_AGE_MS;
}

/** Whether `data` holds a record `recordId` in collection `entityId`, container-agnostic. */
export function dataHasRecord(data: Y.Map<unknown>, entityId: string, recordId: string): boolean {
  const container = data.get(entityId);
  if (container === undefined) return false;
  if (isCompactContainer(container)) return container.has(recordId);
  return containerRecords(container).some((record) => {
    const id = record.id;
    return (typeof id === 'string' || typeof id === 'number') && String(id) === recordId;
  });
}

function tombstoneField(raw: unknown, field: string): unknown {
  return raw instanceof Y.Map ? (raw as Y.Map<unknown>).get(field) : undefined;
}

export interface HistoryCompactionResult {
  recordTombstones: number;
  fileTombstones: number;
  rekeys: number;
}

/**
 * Drops expired record/file tombstones and superseded rekey entries in one
 * transaction. Doc-parametric; the caller decides who runs it (owner devices,
 * docs.ts) and passes this device's current room epoch.
 */
export function compactDappHistory(
  doc: Y.Doc,
  options: { currentEpoch: number; now?: number; retentionMs?: number },
): HistoryCompactionResult {
  const now = options.now ?? Date.now();
  const retentionMs = options.retentionMs ?? TOMBSTONE_RETENTION_MS;
  const data = doc.getMap('data');
  const files = doc.getMap('files');
  const recordTombstones = doc.getMap('recordTombstones');
  const fileTombstones = doc.getMap('fileTombstones');
  const rekeys = doc.getMap('rekeys');

  const expiredRecords: string[] = [];
  recordTombstones.forEach((raw, key) => {
    if (!(ageOf(tombstoneField(raw, 'deletedAt'), now) >= retentionMs)) return;
    const [entityId, ...rest] = key.split(':');
    if (dataHasRecord(data, entityId, rest.join(':'))) return;
    expiredRecords.push(key);
  });
  const expiredFiles: string[] = [];
  fileTombstones.forEach((raw, fileId) => {
    if (ageOf(tombstoneField(raw, 'deletedAt'), now) >= retentionMs && !files.has(fileId)) expiredFiles.push(fileId);
  });
  const supersededRekeys: string[] = [];
  const keepFromEpoch = options.currentEpoch - 1;
  rekeys.forEach((raw, key) => {
    const epoch = Number(tombstoneField(raw, 'epoch'));
    if (Number.isInteger(epoch) && epoch < keepFromEpoch) supersededRekeys.push(key);
  });

  if (expiredRecords.length + expiredFiles.length + supersededRekeys.length > 0) {
    doc.transact(() => {
      expiredRecords.forEach((key) => { recordTombstones.delete(key); });
      expiredFiles.forEach((fileId) => { fileTombstones.delete(fileId); });
      supersededRekeys.forEach((key) => { rekeys.delete(key); });
    }, 'history-compaction');
  }
  return { recordTombstones: expiredRecords.length, fileTombstones: expiredFiles.length, rekeys: supersededRekeys.length };
}
