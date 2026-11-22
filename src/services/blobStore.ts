import type { BlobDescriptor } from '../types.ts';
import { bufferToHex } from '../lib/hex.ts';

/**
 * Content-addressed local blob store (docs/plans/2026-08-24-blob-store.md,
 * Phase 1). Chunks are stored by SHA-256 in IndexedDB (the headless runtime
 * injects a filesystem backend through `BlobChunkBackend`); blob-level
 * metadata (descriptor, pin flag, LRU timestamps) lives in the same small
 * IndexedDB database so GC and usage accounting work identically everywhere.
 *
 * Invariants enforced here:
 * - every chunk is verified against its hash before storage (network path);
 * - assembled blobs are verified against the full-content hash before use;
 * - GC evicts only unpinned, complete, least-recently-used blobs;
 * - locally-ingested blobs are pinned by default so a user's own uploads are
 *   never evicted from under them.
 */

export const BLOB_CHUNK_SIZE = 256 * 1024;
export const MAX_BLOB_BYTES = 256 * 1024 * 1024;
export const BLOBS_DB = 'dapp-builder-blobs';
const META_STORE = 'blobs';
const CHUNK_STORE = 'chunks';
/** Directory earlier builds used for chunks in OPFS; drained into IndexedDB once, then removed. */
const LEGACY_OPFS_DIR = 'blob-chunks';

export interface BlobMeta extends BlobDescriptor {
  pinned: boolean;
  complete: boolean;
  lastAccess: number;
}

export interface BlobStoreUsage {
  blobCount: number;
  completeBytes: number;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return bufferToHex(digest);
}

/** The transferable descriptor of a stored blob — strips FileRecord metadata before it hits the wire or the meta store. */
export function blobDescriptorOf(record: BlobDescriptor): BlobDescriptor {
  return { sha256: record.sha256, size: record.size, chunkSize: record.chunkSize, chunkHashes: record.chunkHashes };
}

function idbRequest<T>(
  database: Promise<IDBDatabase>,
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return database.then((db) => new Promise<T>((resolve, reject) => {
    const request = run(db.transaction(storeName, mode).objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`blob store: ${storeName} request failed`));
  }));
}

// ───── Chunk backends ─────

export interface BlobChunkBackend {
  put(hash: string, bytes: Uint8Array): Promise<void>;
  get(hash: string): Promise<Uint8Array | null>;
  has(hash: string): Promise<boolean>;
  delete(hash: string): Promise<void>;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function assertHash(hash: string): void {
  if (!HASH_PATTERN.test(hash)) throw new Error('blob store: invalid chunk hash');
}

class IdbChunkBackend implements BlobChunkBackend {
  private readonly db: () => Promise<IDBDatabase>;

  constructor(db: () => Promise<IDBDatabase>) {
    this.db = db;
  }

  private request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return idbRequest(this.db(), CHUNK_STORE, mode, run);
  }

  async put(hash: string, bytes: Uint8Array): Promise<void> {
    assertHash(hash);
    const copy = bytes.slice().buffer;
    await this.request('readwrite', (store) => store.put(copy, hash));
  }

  async get(hash: string): Promise<Uint8Array | null> {
    assertHash(hash);
    const value = await this.request<unknown>('readonly', (store) => store.get(hash));
    return value instanceof ArrayBuffer ? new Uint8Array(value) : null;
  }

  async has(hash: string): Promise<boolean> {
    assertHash(hash);
    const count = await this.request<number>('readonly', (store) => store.count(hash));
    return count > 0;
  }

  async delete(hash: string): Promise<void> {
    assertHash(hash);
    await this.request('readwrite', (store) => store.delete(hash));
  }
}

// ───── Store ─────

export class BlobStore {
  private database: Promise<IDBDatabase> | null = null;
  private readonly backend: BlobChunkBackend;
  /** Resolves once any chunks left in the legacy OPFS directory have been moved into the backend. */
  private readonly ready: Promise<void>;
  private readonly dbName: string;

  constructor(options: { backend?: BlobChunkBackend; dbName?: string } = {}) {
    this.dbName = options.dbName ?? BLOBS_DB;
    this.backend = options.backend ?? new IdbChunkBackend(() => this.db());
    this.ready = options.backend ? Promise.resolve() : importLegacyOpfsChunks(this.backend).catch(() => undefined);
  }

  private async chunks(): Promise<BlobChunkBackend> {
    await this.ready;
    return this.backend;
  }

  private db(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise((resolve, reject) => {
        const request = indexedDB.open(this.dbName, 1);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: 'sha256' });
          if (!database.objectStoreNames.contains(CHUNK_STORE)) database.createObjectStore(CHUNK_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('blob store: failed to open database'));
      });
    }
    return this.database;
  }

  /** Close the underlying database connection (tests, teardown). */
  async close(): Promise<void> {
    if (!this.database) return;
    const database = await this.database.catch(() => null);
    database?.close();
    this.database = null;
  }

  private metaRequest<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return idbRequest(this.db(), META_STORE, mode, run);
  }

  private getMeta(sha256: string): Promise<BlobMeta | null> {
    return this.metaRequest<unknown>('readonly', (store) => store.get(sha256))
      .then((value) => (value && typeof value === 'object' ? value as BlobMeta : null));
  }

  private putMeta(meta: BlobMeta): Promise<void> {
    return this.metaRequest('readwrite', (store) => store.put(meta)).then(() => undefined);
  }

  async listBlobs(): Promise<BlobMeta[]> {
    const rows = await this.metaRequest<unknown[]>('readonly', (store) => store.getAll());
    return rows.filter((row): row is BlobMeta => !!row && typeof row === 'object');
  }

  // ── Ingestion ──

  /**
   * Chunk, hash, and store local content. Reads Blob sources chunk-by-chunk so
   * large files are never fully buffered. The blob is pinned by default: a
   * user's own uploads must survive GC until they explicitly unpin.
   */
  async putBlob(data: Uint8Array | Blob, options: { pin?: boolean } = {}): Promise<BlobDescriptor> {
    const size = data instanceof Blob ? data.size : data.byteLength;
    if (size <= 0) throw new Error('blob store: cannot store an empty blob');
    if (size > MAX_BLOB_BYTES) throw new Error(`blob store: blob exceeds the ${MAX_BLOB_BYTES} byte limit`);

    const chunkHashes: string[] = [];
    const chunkCount = Math.ceil(size / BLOB_CHUNK_SIZE);
    for (let index = 0; index < chunkCount; index++) {
      const start = index * BLOB_CHUNK_SIZE;
      const end = Math.min(size, start + BLOB_CHUNK_SIZE);
      const chunk = data instanceof Blob
        ? new Uint8Array(await data.slice(start, end).arrayBuffer())
        : data.subarray(start, end);
      const hash = await sha256Hex(chunk);
      chunkHashes.push(hash);
      await (await this.chunks()).put(hash, chunk);
    }

    // WebCrypto has no streaming digest; hash the whole content. Bounded by
    // MAX_BLOB_BYTES, matching what getBlob assembles anyway.
    const sha256 = await sha256Hex(data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data);

    const existing = await this.getMeta(sha256);
    await this.putMeta({
      sha256,
      size,
      chunkSize: BLOB_CHUNK_SIZE,
      chunkHashes,
      pinned: options.pin ?? existing?.pinned ?? true,
      complete: true,
      lastAccess: Date.now(),
    });
    return { sha256, size, chunkSize: BLOB_CHUNK_SIZE, chunkHashes };
  }

  // ── Network-facing chunk API ──

  /** Register a remote blob we intend to fetch; idempotent. */
  async registerRemoteBlob(descriptor: BlobDescriptor): Promise<void> {
    validateDescriptor(descriptor);
    const existing = await this.getMeta(descriptor.sha256);
    if (existing) return;
    await this.putMeta({ ...descriptor, pinned: false, complete: false, lastAccess: Date.now() });
  }

  /** Store a chunk after verifying its content hash. Returns false on mismatch. */
  async putChunkVerified(hash: string, bytes: Uint8Array): Promise<boolean> {
    assertHash(hash);
    if (bytes.byteLength === 0 || bytes.byteLength > BLOB_CHUNK_SIZE) return false;
    if (await sha256Hex(bytes) !== hash) return false;
    await (await this.chunks()).put(hash, bytes);
    return true;
  }

  async getChunk(hash: string): Promise<Uint8Array | null> {
    return (await this.chunks()).get(hash);
  }

  async missingChunks(descriptor: BlobDescriptor): Promise<number[]> {
    const backend = await this.chunks();
    const missing: number[] = [];
    for (let index = 0; index < descriptor.chunkHashes.length; index++) {
      if (!(await backend.has(descriptor.chunkHashes[index]))) missing.push(index);
    }
    return missing;
  }

  /** Mark a registered blob complete once every chunk is present and the full content verifies. */
  async finalizeBlob(descriptor: BlobDescriptor): Promise<boolean> {
    validateDescriptor(descriptor);
    const assembled = await this.assemble(descriptor);
    if (!assembled) return false;
    if (await sha256Hex(assembled) !== descriptor.sha256) return false;
    const existing = await this.getMeta(descriptor.sha256);
    await this.putMeta({
      ...descriptor,
      pinned: existing?.pinned ?? false,
      complete: true,
      lastAccess: Date.now(),
    });
    return true;
  }

  // ── Retrieval ──

  async hasBlob(sha256: string): Promise<boolean> {
    const meta = await this.getMeta(sha256);
    return meta?.complete === true;
  }

  /** Assemble and verify a complete blob; null when chunks are missing or verification fails. */
  async getBlob(sha256: string): Promise<Uint8Array | null> {
    const meta = await this.getMeta(sha256);
    if (!meta || !meta.complete) return null;
    const assembled = await this.assemble(meta);
    if (!assembled) return null;
    if (await sha256Hex(assembled) !== sha256) return null;
    await this.putMeta({ ...meta, lastAccess: Date.now() });
    return assembled;
  }

  private async assemble(descriptor: BlobDescriptor): Promise<Uint8Array | null> {
    const backend = await this.chunks();
    const full = new Uint8Array(descriptor.size);
    let offset = 0;
    for (const hash of descriptor.chunkHashes) {
      const chunk = await backend.get(hash);
      if (!chunk || offset + chunk.byteLength > descriptor.size) return null;
      full.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return offset === descriptor.size ? full : null;
  }

  // ── Pinning, deletion, GC ──

  async setPinned(sha256: string, pinned: boolean): Promise<void> {
    const meta = await this.getMeta(sha256);
    if (!meta) return;
    await this.putMeta({ ...meta, pinned });
  }

  /** Delete a blob and every chunk not referenced by another stored blob. */
  async deleteBlob(sha256: string): Promise<void> {
    const meta = await this.getMeta(sha256);
    if (!meta) return;
    const others = (await this.listBlobs()).filter((row) => row.sha256 !== sha256);
    const referenced = new Set(others.flatMap((row) => row.chunkHashes));
    const backend = await this.chunks();
    for (const hash of meta.chunkHashes) {
      if (!referenced.has(hash)) await backend.delete(hash);
    }
    await this.metaRequest('readwrite', (store) => store.delete(sha256));
  }

  async usage(): Promise<BlobStoreUsage> {
    const blobs = await this.listBlobs();
    return {
      blobCount: blobs.length,
      completeBytes: blobs.filter((row) => row.complete).reduce((sum, row) => sum + row.size, 0),
    };
  }

  /**
   * Evict unpinned blobs whose last access is older than maxAgeMs. Incomplete
   * blobs (partial fetch leftovers) are evicted by the same rule — their
   * chunks are otherwise never reclaimed when a fetch was abandoned.
   */
  async gcByAge(maxAgeMs: number, now = Date.now()): Promise<string[]> {
    const cutoff = now - maxAgeMs;
    const stale = (await this.listBlobs())
      .filter((row) => !row.pinned && row.lastAccess < cutoff);
    const evicted: string[] = [];
    for (const row of stale) {
      await this.deleteBlob(row.sha256);
      evicted.push(row.sha256);
    }
    return evicted;
  }

  /** Evict unpinned complete blobs, least recently used first, until usage is at or below maxBytes. */
  async gc(maxBytes: number): Promise<string[]> {
    const blobs = await this.listBlobs();
    let total = blobs.filter((row) => row.complete).reduce((sum, row) => sum + row.size, 0);
    if (total <= maxBytes) return [];
    const evictable = blobs
      .filter((row) => row.complete && !row.pinned)
      .sort((a, b) => a.lastAccess - b.lastAccess);
    const evicted: string[] = [];
    for (const row of evictable) {
      if (total <= maxBytes) break;
      await this.deleteBlob(row.sha256);
      total -= row.size;
      evicted.push(row.sha256);
    }
    return evicted;
  }
}

export function validateDescriptor(descriptor: BlobDescriptor): void {
  if (!HASH_PATTERN.test(descriptor.sha256)) throw new Error('blob store: invalid blob hash');
  if (!Number.isInteger(descriptor.size) || descriptor.size <= 0 || descriptor.size > MAX_BLOB_BYTES) {
    throw new Error('blob store: invalid blob size');
  }
  if (descriptor.chunkSize !== BLOB_CHUNK_SIZE) throw new Error('blob store: unsupported chunk size');
  const expectedChunks = Math.ceil(descriptor.size / descriptor.chunkSize);
  if (!Array.isArray(descriptor.chunkHashes)
    || descriptor.chunkHashes.length !== expectedChunks
    || descriptor.chunkHashes.some((hash) => !HASH_PATTERN.test(hash))) {
    throw new Error('blob store: invalid chunk hash list');
  }
}

let sharedStore: BlobStore | null = null;
let sharedStoreBackend: BlobChunkBackend | null = null;

/**
 * Inject the chunk backend the shared store will use — the headless Node
 * runtime provides a filesystem backend here at boot (browsers keep the
 * IndexedDB default). Must run before the first `getBlobStore()` call.
 */
export function configureSharedBlobStoreBackend(backend: BlobChunkBackend): void {
  if (sharedStore) throw new Error('blob store: shared store already created — configure the backend at boot');
  sharedStoreBackend = backend;
}

export function getBlobStore(): BlobStore {
  if (!sharedStore) sharedStore = new BlobStore(sharedStoreBackend ? { backend: sharedStoreBackend } : {});
  return sharedStore;
}

async function legacyOpfsDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') return null;
  try {
    return await (await navigator.storage.getDirectory()).getDirectoryHandle(LEGACY_OPFS_DIR);
  } catch {
    return null; // never created, or OPFS unavailable in this context
  }
}

/** Move chunks an earlier build kept in OPFS into the backend, then drop the directory. */
async function importLegacyOpfsChunks(backend: BlobChunkBackend): Promise<void> {
  const directory = await legacyOpfsDirectory();
  if (!directory) return;
  const entries = directory as unknown as AsyncIterable<[string, FileSystemHandle]>;
  for await (const [name, handle] of entries) {
    if (handle.kind !== 'file' || !HASH_PATTERN.test(name) || await backend.has(name)) continue;
    const bytes = new Uint8Array(await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer());
    await backend.put(name, bytes);
  }
  await clearOpfsBlobStorage();
}

/** Remove the legacy OPFS chunk directory (after import, and on local-data reset). */
export async function clearOpfsBlobStorage(): Promise<void> {
  if (!(await legacyOpfsDirectory())) return;
  try {
    await (await navigator.storage.getDirectory()).removeEntry(LEGACY_OPFS_DIR, { recursive: true });
  } catch {
    // already gone
  }
}
