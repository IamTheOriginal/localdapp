import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { expectSameBytes } from './helpers/bytes.ts';
import { BlobStore, BLOB_CHUNK_SIZE, BLOBS_DB, MAX_BLOB_BYTES, validateDescriptor } from '../services/blobStore.ts';
import { bufferToHex } from '../lib/hex.ts';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bufferToHex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

function makeBytes(size: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(size);
  let state = seed;
  for (let i = 0; i < size; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

let store: BlobStore;
let donorStore: BlobStore;
let testDbCounter = 0;

beforeEach(() => {
  // Fresh database names per test — closing and deleting shared databases
  // deadlocks under fake-indexeddb when other instances hold connections.
  testDbCounter++;
  store = new BlobStore({ dbName: `${BLOBS_DB}-test-${testDbCounter}` });
  donorStore = new BlobStore({ dbName: `${BLOBS_DB}-donor-${testDbCounter}` });
});

describe('BlobStore round-trip', () => {
  it('chunks, stores, and reassembles a multi-chunk blob with verification', async () => {
    const bytes = makeBytes(BLOB_CHUNK_SIZE * 2 + 1234);
    const descriptor = await store.putBlob(bytes);

    expect(descriptor.size).toBe(bytes.byteLength);
    expect(descriptor.chunkSize).toBe(BLOB_CHUNK_SIZE);
    expect(descriptor.chunkHashes).toHaveLength(3);
    expect(descriptor.sha256).toBe(await sha256Hex(bytes));
    expect(() => validateDescriptor(descriptor)).not.toThrow();

    expect(await store.hasBlob(descriptor.sha256)).toBe(true);
    const restored = await store.getBlob(descriptor.sha256);
    expect(restored).not.toBeNull();
    expectSameBytes(restored, bytes);
  });

  it('accepts Blob sources and deduplicates identical content', async () => {
    const bytes = makeBytes(BLOB_CHUNK_SIZE + 10);
    const first = await store.putBlob(new Blob([bytes as BufferSource]));
    const second = await store.putBlob(bytes);
    expect(second.sha256).toBe(first.sha256);
    expect((await store.listBlobs())).toHaveLength(1);
  });

  it('rejects empty and oversized blobs', async () => {
    await expect(store.putBlob(new Uint8Array(0))).rejects.toThrow(/empty/);
    const oversized = { size: MAX_BLOB_BYTES + 1, sha256: 'a'.repeat(64), chunkSize: BLOB_CHUNK_SIZE, chunkHashes: [] };
    expect(() => validateDescriptor(oversized)).toThrow();
  });
});

describe('network chunk path', () => {
  it('verifies chunks on ingest and finalizes only complete, hash-valid blobs', async () => {
    const bytes = makeBytes(BLOB_CHUNK_SIZE + 500);
    const donor = donorStore;
    const descriptor = await donor.putBlob(bytes);

    await store.registerRemoteBlob(descriptor);
    expect(await store.missingChunks(descriptor)).toEqual([0, 1]);
    expect(await store.hasBlob(descriptor.sha256)).toBe(false);

    // Corrupted chunk is refused.
    const garbage = makeBytes(100, 99);
    expect(await store.putChunkVerified(descriptor.chunkHashes[0], garbage)).toBe(false);

    for (const [index, hash] of descriptor.chunkHashes.entries()) {
      const chunk = bytes.subarray(index * BLOB_CHUNK_SIZE, Math.min(bytes.length, (index + 1) * BLOB_CHUNK_SIZE));
      expect(await store.putChunkVerified(hash, chunk)).toBe(true);
    }
    expect(await store.missingChunks(descriptor)).toEqual([]);
    expect(await store.finalizeBlob(descriptor)).toBe(true);
    expectSameBytes(await store.getBlob(descriptor.sha256), bytes);
  });

  it('refuses to finalize when chunks are missing', async () => {
    const bytes = makeBytes(BLOB_CHUNK_SIZE * 2);
    const donor = donorStore;
    const descriptor = await donor.putBlob(bytes);
    await store.registerRemoteBlob(descriptor);
    await store.putChunkVerified(descriptor.chunkHashes[0], bytes.subarray(0, BLOB_CHUNK_SIZE));
    expect(await store.finalizeBlob(descriptor)).toBe(false);
    expect(await store.hasBlob(descriptor.sha256)).toBe(false);
  });
});

describe('pinning, deletion, GC', () => {
  it('deleting a blob keeps chunks shared with another blob', async () => {
    const shared = makeBytes(BLOB_CHUNK_SIZE);
    const tail = makeBytes(50, 3);
    const combined = new Uint8Array(shared.length + tail.length);
    combined.set(shared, 0);
    combined.set(tail, shared.length);

    const a = await store.putBlob(shared);
    const b = await store.putBlob(combined);
    expect(b.chunkHashes[0]).toBe(a.chunkHashes[0]);

    await store.deleteBlob(a.sha256);
    expect(await store.hasBlob(a.sha256)).toBe(false);
    expectSameBytes(await store.getBlob(b.sha256), combined);
  });

  it('gc evicts unpinned LRU blobs only', async () => {
    const first = await store.putBlob(makeBytes(1000, 1), { pin: false });
    const second = await store.putBlob(makeBytes(1000, 2), { pin: false });
    const pinned = await store.putBlob(makeBytes(1000, 3));

    // Touch `first` so `second` becomes the LRU candidate.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.getBlob(first.sha256);

    const evicted = await store.gc(2100);
    expect(evicted).toEqual([second.sha256]);
    expect(await store.hasBlob(first.sha256)).toBe(true);
    expect(await store.hasBlob(pinned.sha256)).toBe(true);

    // Pinned blobs survive even an impossible target.
    await store.gc(0);
    expect(await store.hasBlob(pinned.sha256)).toBe(true);
    expect(await store.hasBlob(first.sha256)).toBe(false);
  });

  it('own uploads are pinned by default and unpinnable', async () => {
    const descriptor = await store.putBlob(makeBytes(100));
    const [meta] = await store.listBlobs();
    expect(meta.pinned).toBe(true);
    await store.setPinned(descriptor.sha256, false);
    const [after] = await store.listBlobs();
    expect(after.pinned).toBe(false);
  });
});
