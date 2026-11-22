import { getVerifiedRecordsSnapshot, onVerifiedRecordsChange, type VerifiedRecordsChange } from './auth.ts';
import { parseCodeAppManifest } from '../codeAppManifest.ts';
import { getCodeAppFile } from './source.ts';

/**
 * `$db` read model (docs/plans/2026-08-24-read-model.md): an in-memory index
 * over the auth observer's VERIFIED record set, giving Code Apps sorted,
 * paginated reads without shipping whole collections across the bridge.
 *
 * Consistency contract: only observer-accepted records are visible; reads
 * may trail `$store` by one scan debounce. Nothing here persists or syncs,
 * and apps have no write surface — `$store` stays the write path.
 */

/** Earlier builds persisted the projection in IndexedDB under this prefix; those databases are deleted on sight. */
export const LEGACY_PROJECTION_DB_PREFIX = 'dapp-projection-';
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_MATCHES = 8;
const INVALIDATION_DEBOUNCE_MS = 250;

interface DbIndexDeclaration {
  collection: string;
  field: string;
}

interface DbMatch {
  field: string;
  op: 'eq' | 'contains' | 'gte' | 'lte';
  value: unknown;
}

interface DbQueryOptions {
  index?: string;
  range?: { eq?: unknown; gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown };
  direction?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
  match?: DbMatch[];
}

interface DbQueryResult {
  rows: Array<Record<string, unknown>>;
  cursor: string | null;
}

type Row = Record<string, unknown>;
type IndexKey = string | number;

interface Entry {
  key: IndexKey;
  id: string;
  row: Row;
}

function isIndexKey(value: unknown): value is IndexKey {
  return typeof value === 'string' || typeof value === 'number';
}

/** IndexedDB key order for the key types records can carry: numbers sort before strings. */
function compareKeys(left: IndexKey, right: IndexKey): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'number') return -1;
  if (typeof right === 'number') return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEntries(left: { key: IndexKey; id: string }, right: { key: IndexKey; id: string }): number {
  return compareKeys(left.key, right.key) || compareKeys(left.id, right.id);
}

/** First index in a sorted array whose entry satisfies a monotone predicate (array length when none does). */
function bisect(entries: Entry[], predicate: (entry: Entry) => boolean): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (predicate(entries[middle])) high = middle;
    else low = middle + 1;
  }
  return low;
}

function matchesRow(record: Row, matches: DbMatch[]): boolean {
  for (const match of matches) {
    const value = record[match.field];
    switch (match.op) {
      case 'eq':
        if (value !== match.value) return false;
        break;
      case 'contains':
        if (typeof value !== 'string' || typeof match.value !== 'string'
          || !value.toLowerCase().includes(match.value.toLowerCase())) return false;
        break;
      case 'gte':
        if (typeof value !== 'number' || typeof match.value !== 'number' || value < match.value) return false;
        break;
      case 'lte':
        if (typeof value !== 'number' || typeof match.value !== 'number' || value > match.value) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

function encodeCursor(entry: Entry): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify([entry.key, entry.id]))));
}

function decodeCursor(token: string): { key: IndexKey; id: string } | null {
  try {
    const [key, id] = JSON.parse(decodeURIComponent(escape(atob(token)))) as [unknown, unknown];
    return isIndexKey(key) && typeof id === 'string' ? { key, id } : null;
  } catch {
    return null;
  }
}

function splitVerifiedKey(key: string): { entityId: string; id: string } {
  const [entityId, ...idParts] = key.split(':');
  return { entityId, id: idParts.join(':') };
}

export class ReadModel {
  private readonly dappId: string;
  private readonly declarations: DbIndexDeclaration[];
  private readonly collections = new Map<string, Map<string, Row>>();
  /** Sorted views per `${collection}\0${index}`, rebuilt lazily after a change. */
  private readonly sorted = new Map<string, Entry[]>();
  private reconciled = false;
  private disposers: Array<() => void> = [];
  private readonly collectionListeners = new Map<string, Set<() => void>>();
  private readonly invalidationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(dappId: string, declarations: DbIndexDeclaration[]) {
    this.dappId = dappId;
    this.declarations = declarations;

    const snapshot = getVerifiedRecordsSnapshot(dappId);
    if (snapshot) this.reconcile(snapshot);
    this.disposers.push(onVerifiedRecordsChange(dappId, (change) => { this.apply(change); }));
  }

  private collection(name: string): Map<string, Row> {
    let rows = this.collections.get(name);
    if (!rows) {
      rows = new Map();
      this.collections.set(name, rows);
    }
    return rows;
  }

  /** Replace contents with the verified snapshot (orphans dropped). */
  private reconcile(snapshot: Map<string, Row>): void {
    const touched = new Set(this.collections.keys());
    this.collections.clear();
    snapshot.forEach((record, key) => {
      const { entityId, id } = splitVerifiedKey(key);
      this.collection(entityId).set(id, record);
      touched.add(entityId);
    });
    this.reconciled = true;
    this.changed(touched);
  }

  private apply(change: VerifiedRecordsChange): void {
    if (!this.reconciled) {
      const snapshot = getVerifiedRecordsSnapshot(this.dappId);
      if (snapshot) {
        this.reconcile(snapshot);
        return;
      }
    }
    const touched = new Set<string>();
    for (const { entityId, record } of change.upserts) {
      if (typeof record.id !== 'string' || !record.id) continue;
      this.collection(entityId).set(record.id, record);
      touched.add(entityId);
    }
    for (const key of change.deletes) {
      const { entityId, id } = splitVerifiedKey(key);
      this.collections.get(entityId)?.delete(id);
      touched.add(entityId);
    }
    this.changed(touched);
  }

  private changed(collections: Set<string>): void {
    for (const key of Array.from(this.sorted.keys())) {
      if (collections.has(key.slice(0, key.indexOf('\0')))) this.sorted.delete(key);
    }
    collections.forEach((collection) => this.invalidate(collection));
  }

  // ── Reads ──

  /** The collection sorted by the declared index field (rows lacking a sortable value are absent, as in an IndexedDB index) or by id. */
  private ordered(collection: string, index: string | undefined): Entry[] {
    if (index && !this.declarations.some((declaration) => declaration.collection === collection && declaration.field === index)) {
      throw new Error(`$db: index "${index}" is not declared for "${collection}" in the manifest`);
    }
    const cacheKey = `${collection}\0${index ?? ''}`;
    const cached = this.sorted.get(cacheKey);
    if (cached) return cached;
    const entries: Entry[] = [];
    this.collections.get(collection)?.forEach((row, id) => {
      const key = index ? row[index] : id;
      if (isIndexKey(key)) entries.push({ key, id, row });
    });
    entries.sort(compareEntries);
    this.sorted.set(cacheKey, entries);
    return entries;
  }

  /** `[start, end)` slice of the sorted entries inside the requested key range. */
  private rangeBounds(entries: Entry[], options: Pick<DbQueryOptions, 'range'>): [number, number] {
    const range = options.range ?? {};
    const lower = range.eq ?? range.gt ?? range.gte;
    const upper = range.eq ?? range.lt ?? range.lte;
    const lowerOpen = range.eq === undefined && range.gt !== undefined;
    const upperOpen = range.eq === undefined && range.lt !== undefined;
    const start = isIndexKey(lower)
      ? bisect(entries, (entry) => (lowerOpen ? compareKeys(entry.key, lower) > 0 : compareKeys(entry.key, lower) >= 0))
      : 0;
    const end = isIndexKey(upper)
      ? bisect(entries, (entry) => (upperOpen ? compareKeys(entry.key, upper) >= 0 : compareKeys(entry.key, upper) > 0))
      : entries.length;
    return [start, Math.max(start, end)];
  }

  query(collection: string, options: DbQueryOptions = {}): DbQueryResult {
    const limit = Math.min(MAX_LIMIT, Math.max(1, options.limit ?? DEFAULT_LIMIT));
    const matches = (options.match ?? []).slice(0, MAX_MATCHES);
    const descending = options.direction === 'desc';
    const entries = this.ordered(collection, options.index);
    let [start, end] = this.rangeBounds(entries, options);

    // Resume strictly after the last emitted row (duplicate keys are ordered by id).
    const resume = options.cursor ? decodeCursor(options.cursor) : null;
    if (resume) {
      if (descending) end = Math.min(end, bisect(entries, (entry) => compareEntries(entry, resume) >= 0));
      else start = Math.max(start, bisect(entries, (entry) => compareEntries(entry, resume) > 0));
    }

    const rows: Row[] = [];
    let nextCursor: string | null = null;
    const step = descending ? -1 : 1;
    for (let index = descending ? end - 1 : start; descending ? index >= start : index < end; index += step) {
      const entry = entries[index];
      if (!matchesRow(entry.row, matches)) continue;
      rows.push(entry.row);
      if (rows.length >= limit) {
        nextCursor = encodeCursor(entry);
        break;
      }
    }
    return { rows, cursor: nextCursor };
  }

  get(collection: string, id: string): Row | null {
    return this.collections.get(collection)?.get(id) ?? null;
  }

  count(collection: string, options: Pick<DbQueryOptions, 'index' | 'range'> = {}): number {
    const [start, end] = this.rangeBounds(this.ordered(collection, options.index), options);
    return end - start;
  }

  // ── Invalidation subscriptions ──

  subscribe(collection: string, listener: () => void): () => void {
    let listeners = this.collectionListeners.get(collection);
    if (!listeners) {
      listeners = new Set();
      this.collectionListeners.set(collection, listeners);
    }
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  private invalidate(collection: string): void {
    if (this.invalidationTimers.has(collection)) return;
    this.invalidationTimers.set(collection, setTimeout(() => {
      this.invalidationTimers.delete(collection);
      this.collectionListeners.get(collection)?.forEach((listener) => {
        try {
          listener();
        } catch (error) {
          console.error('read model: invalidation listener failed', error);
        }
      });
    }, INVALIDATION_DEBOUNCE_MS));
  }

  close(): void {
    this.disposers.splice(0).forEach((dispose) => dispose());
    this.invalidationTimers.forEach((timer) => clearTimeout(timer));
    this.invalidationTimers.clear();
    this.collections.clear();
    this.sorted.clear();
  }
}

const VALID_MATCH_OPS = new Set(['eq', 'contains', 'gte', 'lte']);

/** Whitelist-validate untrusted `$db` query options from the sandbox bridge. */
export function sanitizeQueryOptions(raw: unknown): DbQueryOptions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const candidate = raw as Record<string, unknown>;
  const options: DbQueryOptions = {};
  if (typeof candidate.index === 'string' && candidate.index.length <= 64) options.index = candidate.index;
  if (candidate.range && typeof candidate.range === 'object' && !Array.isArray(candidate.range)) {
    const range = candidate.range as Record<string, unknown>;
    const bounds: NonNullable<DbQueryOptions['range']> = {};
    for (const key of ['eq', 'gt', 'gte', 'lt', 'lte'] as const) {
      const value = range[key];
      if (typeof value === 'string' || typeof value === 'number') bounds[key] = value;
    }
    if (Object.keys(bounds).length > 0) options.range = bounds;
  }
  if (candidate.direction === 'desc') options.direction = 'desc';
  if (typeof candidate.limit === 'number' && Number.isFinite(candidate.limit)) options.limit = candidate.limit;
  if (typeof candidate.cursor === 'string' && candidate.cursor.length <= 2048) options.cursor = candidate.cursor;
  if (Array.isArray(candidate.match)) {
    const matches: DbMatch[] = [];
    for (const entry of candidate.match.slice(0, MAX_MATCHES)) {
      if (!entry || typeof entry !== 'object') continue;
      const { field, op, value } = entry as Record<string, unknown>;
      if (typeof field !== 'string' || field.length > 64) continue;
      if (typeof op !== 'string' || !VALID_MATCH_OPS.has(op)) continue;
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
      matches.push({ field, op: op as DbMatch['op'], value });
    }
    if (matches.length > 0) options.match = matches;
  }
  return options;
}

export function sanitizeCollectionName(raw: unknown): string {
  const collection = typeof raw === 'string' ? raw.trim() : '';
  if (!collection || collection.length > 64) throw new Error('$db: collection must be a 1-64 character string');
  return collection;
}

const models = new Map<string, ReadModel>();

function dbDeclarationsFromManifest(dappId: string): DbIndexDeclaration[] {
  const parsed = parseCodeAppManifest(getCodeAppFile(dappId, 'manifest.yaml'));
  return parsed.error ? [] : (parsed.manifest.db?.indexes ?? []);
}

/** Best-effort removal of the persisted projection an earlier build left behind. */
export function deleteLegacyProjectionDatabase(dappId: string): void {
  if (typeof indexedDB === 'undefined') return;
  try {
    indexedDB.deleteDatabase(`${LEGACY_PROJECTION_DB_PREFIX}${dappId}`);
  } catch {
    // nothing to clean up
  }
}

/** Get (or lazily create) the read model for a dapp using its current manifest declarations. */
export function getReadModel(dappId: string, declarations?: DbIndexDeclaration[]): ReadModel {
  let model = models.get(dappId);
  if (!model) {
    model = new ReadModel(dappId, declarations ?? dbDeclarationsFromManifest(dappId));
    models.set(dappId, model);
    deleteLegacyProjectionDatabase(dappId);
  }
  return model;
}

/** Drop a dapp's read model (dapp deletion). */
export function destroyReadModel(dappId: string): void {
  models.get(dappId)?.close();
  models.delete(dappId);
  deleteLegacyProjectionDatabase(dappId);
}
