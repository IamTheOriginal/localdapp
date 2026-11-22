import type { RecordData } from '../types.ts';
import { getEntityRecords, addRecord, updateRecord, deleteRecord } from './store/data.ts';
import { getDappDoc } from './store/docs.ts';
import { collectionIdProblem } from './codeAppManifest.ts';
import * as Y from 'yjs';

/**
 * The `$store` bridge between Code App iframes and the Yjs store: resolves
 * collection names against the dapp schema and executes CRUD requests coming
 * over the postMessage RPC in `codeAppRuntime.ts`.
 */

export function resolveStoreCollectionId(dappId: string, nameOrId: unknown): string {
  const resolved = resolveCollectionName(dappId, nameOrId);
  // The auth observer and `$db` key records as `entityId:recordId` and split on
  // the first `:` — a collection id with a `:` is misread there (deletes get
  // reverted, rows land under the wrong entity), so it is never used, whether
  // it is new, left over in the doc or declared by an old schema. A display
  // name with a `:` still resolves when it maps to a clean entity id.
  const problem = collectionIdProblem(resolved);
  if (problem) throw new Error(`$store collection "${resolved}" ${problem}`);
  return resolved;
}

function resolveCollectionName(dappId: string, nameOrId: unknown): string {
  if (typeof nameOrId !== 'string') throw new Error('$store collection must be a string');
  const collectionId = nameOrId.trim();
  if (!collectionId || collectionId.length > 128) {
    throw new Error('$store collection must be 1–128 characters');
  }
  if ([...collectionId].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  })) {
    throw new Error('$store collection cannot contain control characters');
  }

  const doc = getDappDoc(dappId);
  const config = doc.getMap('config');
  const schema = config.get('schema') as Y.Map<unknown> | undefined;
  const entities = schema?.get('entities') as Y.Map<unknown> | undefined;

  // Declared schema entity ids resolve as-is.
  if (entities?.has(collectionId)) return collectionId;

  // Once an app-owned collection exists, keep resolving to it even if a schema
  // entity with the same display name is added later.
  if (doc.getMap('data').has(collectionId)) return collectionId;

  // Schema entities also resolve by display name for existing apps.
  let foundId: string | null = null;
  entities?.forEach((value: unknown, key: string) => {
    const entity = value as Y.Map<unknown>;
    if (entity.get('name') === collectionId) foundId = key;
  });

  // Unknown valid identifiers are app-owned, schema-less collections.
  return foundId ?? collectionId;
}

/** Executes one `$store` RPC request from a Code App and returns the result. */
/** One record may carry this much JSON — the same order of magnitude as a `$data` value. */
export const MAX_STORE_RECORD_BYTES = 256_000;

/**
 * What a Code App hands to `$store.create` / `$store.update` arrives by structured
 * clone: it can be a string, an array, a Map, a typed array or a 200 MB blob of
 * text. Whatever is written becomes a SIGNED record that every member and the
 * keeper replicate and keep forever — so it has to be a plain JSON object of
 * bounded size (files belong in `$files`, never in a record).
 */
function recordFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('$store: record data must be a plain object');
  }
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    encoded = undefined;
  }
  if (encoded === undefined) throw new Error('$store: record data must be JSON serializable');
  if (encoded.length > MAX_STORE_RECORD_BYTES) throw new Error('$store: a record is limited to 256 KB — put files into $files');
  return JSON.parse(encoded) as Record<string, unknown>;
}

function requireRecordId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128) throw new Error('$store: record id must be a string of 1–128 characters');
  return value;
}

export async function handleStoreOperation(dappId: string, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'query': {
      const [entityId, filter] = args;
      const resolvedId = resolveStoreCollectionId(dappId, entityId);
      const records = getEntityRecords(dappId, resolvedId) || [];
      if (!filter) return records;
      return records.filter((r: RecordData) => {
        return Object.entries(filter).every(([k, v]) => r[k] === v);
      });
    }
    case 'get': {
      const [entityId, recordId] = args;
      const resolvedId = resolveStoreCollectionId(dappId, entityId);
      const records = getEntityRecords(dappId, resolvedId) || [];
      return records.find((r: RecordData) => r.id === recordId) || null;
    }
    case 'create': {
      const [entityId, rawData] = args;
      const data = recordFields(rawData ?? {});
      const resolvedId = resolveStoreCollectionId(dappId, entityId);
      const newId = crypto.randomUUID();
      await addRecord(dappId, resolvedId, { ...data, id: newId });
      return { ...data, id: newId };
    }
    case 'update': {
      const [entityId, recordId, rawData] = args;
      const data = recordFields(rawData);
      const resolvedId = resolveStoreCollectionId(dappId, entityId);
      await updateRecord(dappId, resolvedId, requireRecordId(recordId), data);
      return { id: recordId, ...data };
    }
    case 'delete': {
      const [entityId, recordId] = args;
      const resolvedId = resolveStoreCollectionId(dappId, entityId);
      await deleteRecord(dappId, resolvedId, requireRecordId(recordId));
      return { success: true };
    }
    default:
      throw new Error(`Unknown $store operation: ${method}`);
  }
}
