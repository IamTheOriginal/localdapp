import * as Y from 'yjs';
import { isCompactContainer, isFieldsContainer } from './recordContainers.ts';

/**
 * Collection containers are values of the dapp doc's `data` map, and a Y.Map
 * key is last-writer-wins. Two members that each write the FIRST record of a
 * collection while offline each create a container; when their updates meet,
 * one container wins on every peer and the other disappears together with
 * the records inside it (review item 5.9). The owner's legacy-to-compact
 * conversion (`data.ts::migrateLegacyCollections`) replaces a container the
 * same way, taking an editor's concurrent write with it.
 *
 * Nobody but the loser can repair that: the records in the losing container
 * exist only on the devices that saw it, and only their author can vouch for
 * them. So every device watches the `data` map, and when a container it held
 * is replaced by another one, it puts ITS OWN signed records from the old
 * container into the surviving one — unchanged, signature and all (the
 * container is not part of what gets signed), so the auth observer judges
 * them exactly as before. Records of other authors are left to their authors'
 * devices; a record that already exists in the survivor or that a tombstone
 * deletes is not brought back.
 *
 * The old container's content is still readable inside the observer: Yjs
 * calls observers before it garbage-collects what the transaction deleted.
 * Only what was deleted IN THIS transaction counts — a record that was
 * deleted earlier (a tombstone, an auth revert) stays deleted.
 */

export const CONTAINER_MERGE_ORIGIN = 'record-container-merge';

function lastValue(item: Y.Item): unknown {
  const content = item.content.getContent();
  return content[content.length - 1];
}

/** Live now, or deleted by the transaction that is being observed. */
function presentBefore(item: Y.Item, deleteSet: Y.Transaction['deleteSet']): boolean {
  return !item.deleted || Y.isDeleted(deleteSet, item.id);
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Y.AbstractType)
    ? value as Record<string, unknown>
    : null;
}

/** The records a replaced container held right before this transaction, container-agnostic. */
function recordsOfReplacedContainer(container: unknown, deleteSet: Y.Transaction['deleteSet']): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  if (isCompactContainer(container)) {
    container._map.forEach((item) => {
      if (!presentBefore(item, deleteSet)) return;
      const record = plainObject(lastValue(item));
      if (record) records.push(record);
    });
    return records;
  }
  if (isFieldsContainer(container)) {
    for (let item = container._start; item !== null; item = item.right) {
      if (!presentBefore(item, deleteSet) || !(item.content instanceof Y.ContentType)) continue;
      const recordMap = item.content.type;
      if (!(recordMap instanceof Y.Map)) continue;
      const record: Record<string, unknown> = {};
      recordMap._map.forEach((fieldItem, field) => {
        if (presentBefore(fieldItem, deleteSet)) record[field] = lastValue(fieldItem);
      });
      records.push(record);
    }
  }
  return records;
}

function recordIdOf(record: Record<string, unknown>): string | null {
  const id = record.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

function containerHasRecord(container: unknown, recordId: string): boolean {
  if (isCompactContainer(container)) return container.has(recordId);
  if (isFieldsContainer(container)) {
    return container.toArray().some((recordMap) => {
      const id: unknown = recordMap.get('id');
      return (typeof id === 'string' || typeof id === 'number') && String(id) === recordId;
    });
  }
  return false;
}

function stamp(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

/** Same precedence as the auth observer: a tombstone deletes every version stamped at or before it. */
function tombstoneDeletes(doc: Y.Doc, entityId: string, recordId: string, record: Record<string, unknown>): boolean {
  const tombstone = doc.getMap('recordTombstones').get(`${entityId}:${recordId}`);
  if (!(tombstone instanceof Y.Map)) return false;
  const deletedAt = stamp(tombstone.get('deletedAt'));
  if (!Number.isFinite(deletedAt)) return false;
  const writtenAt = stamp(record.updatedAt || record.createdAt);
  return !Number.isFinite(writtenAt) || deletedAt >= writtenAt;
}

function insertRecord(container: unknown, record: Record<string, unknown>, recordId: string): void {
  if (isCompactContainer(container)) {
    container.set(recordId, { ...record });
    return;
  }
  if (isFieldsContainer(container)) {
    const recordMap = new Y.Map<unknown>();
    Object.entries(record).forEach(([key, value]) => recordMap.set(key, value));
    container.push([recordMap]);
  }
}

/**
 * Starts watching `doc` for replaced collection containers; `ownKey` names the
 * signer whose records this device puts back (this device's public key, read
 * at event time — the identity may load after the document). Returns a
 * function that stops watching.
 */
export function watchReplacedRecordContainers(doc: Y.Doc, ownKey: () => string | null | undefined): () => void {
  const data = doc.getMap<unknown>('data');
  const onChange = (event: Y.YMapEvent<unknown>, transaction: Y.Transaction) => {
    const signer = ownKey();
    if (!signer) return;
    const recovered: Array<{ entityId: string; records: Array<Record<string, unknown>> }> = [];
    event.keys.forEach((change, entityId) => {
      if (change.action !== 'update') return;
      const oldContainer: unknown = change.oldValue;
      if (oldContainer === data.get(entityId)) return;
      const own = recordsOfReplacedContainer(oldContainer, transaction.deleteSet)
        .filter((record) => record._signedBy === signer);
      if (own.length > 0) recovered.push({ entityId, records: own });
    });
    if (recovered.length === 0) return;
    // A transaction started inside an observer runs right after this one's cleanup.
    doc.transact(() => {
      for (const { entityId, records } of recovered) {
        const container = data.get(entityId);
        if (!isCompactContainer(container) && !isFieldsContainer(container)) continue;
        for (const record of records) {
          const recordId = recordIdOf(record);
          if (recordId === null || containerHasRecord(container, recordId)) continue;
          if (tombstoneDeletes(doc, entityId, recordId, record)) continue;
          insertRecord(container, record, recordId);
        }
      }
    }, CONTAINER_MERGE_ORIGIN);
  };
  data.observe(onChange);
  return () => { data.unobserve(onChange); };
}
