import * as Y from 'yjs';

/**
 * Two on-wire representations of a collection inside the dapp doc's `data`
 * map:
 *
 * - 'fields' (legacy): Y.Array of Y.Maps, one CRDT entry per field. No longer
 *   created; owner devices convert existing ones on open
 *   (`data.ts::migrateLegacyCollections`). Readers keep handling it until every
 *   dapp has been opened by an owner on this build — then this branch goes.
 * - 'compact': Y.Map keyed by record id, each value one immutable plain-JSON
 *   record — a fraction of the CRDT metadata for large collections. Replacing
 *   a key is whole-record last-writer-wins, which matches the signing model
 *   (every change re-signs the whole record; field-level merges would corrupt
 *   signatures anyway).
 */

export type FieldsContainer = Y.Array<Y.Map<unknown>>;
export type CompactContainer = Y.Map<Record<string, unknown>>;

export type RecordFormat = 'fields' | 'compact';

export function isCompactContainer(container: unknown): container is CompactContainer {
  return container instanceof Y.Map;
}

export function isFieldsContainer(container: unknown): container is FieldsContainer {
  return container instanceof Y.Array;
}

/** Coerces a compact-container value into a plain record object. */
export function plainRecordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Every record in a container as plain objects, container-agnostic. */
export function containerRecords(container: unknown): Array<Record<string, unknown>> {
  if (isFieldsContainer(container)) {
    const records: Array<Record<string, unknown>> = [];
    container.forEach((recordMap) => {
      const record: Record<string, unknown> = {};
      recordMap.forEach((value, key) => { record[key] = value; });
      records.push(record);
    });
    return records;
  }
  if (isCompactContainer(container)) {
    return [...container.values()].map(plainRecordValue);
  }
  return [];
}

