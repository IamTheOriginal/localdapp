// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlobStore, BLOBS_DB } from '../services/blobStore.ts';

// Which content the dapps on this device still list (blobReferences.ts walks the catalog).
const referenced = vi.hoisted(() => new Set<string>());
vi.mock('../services/store/blobReferences.ts', () => ({
  isBlobStillReferenced: (_dappId: string, sha256: string) => Promise.resolve(referenced.has(sha256)),
}));

import {
  DEFAULT_BLOB_CLEANUP_POLICY,
  getBlobCleanupPolicy,
  releaseBlobIfUnreferenced,
  runBlobCleanup,
  setBlobCleanupPolicy,
  sweepUnreferencedBlobs,
} from '../services/blobCleanup.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeBytes(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let state = seed;
  for (let i = 0; i < size; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

let store: BlobStore;
let testDbCounter = 0;

beforeEach(() => {
  testDbCounter++;
  store = new BlobStore({ dbName: `${BLOBS_DB}-cleanup-${testDbCounter}` });
  localStorage.clear();
  referenced.clear();
});

async function ageBlob(sha256: string, days: number): Promise<void> {
  // Backdate lastAccess by rewriting the meta row the way the store reads it.
  const rows = await store.listBlobs();
  const row = rows.find((meta) => meta.sha256 === sha256);
  if (!row) throw new Error('blob not found');
  // setPinned round-trips the meta record; poke lastAccess through the same path.
  const meta = { ...row, lastAccess: Date.now() - days * DAY_MS };
  await (store as unknown as { putMeta(meta: unknown): Promise<void> }).putMeta(meta);
}

describe('gcByAge', () => {
  it('evicts stale unpinned blobs and keeps pinned and recent ones', async () => {
    const stale = await store.putBlob(makeBytes(1000, 1), { pin: false });
    const recent = await store.putBlob(makeBytes(1000, 2), { pin: false });
    const pinnedStale = await store.putBlob(makeBytes(1000, 3)); // pinned by default
    await ageBlob(stale.sha256, 10);
    await ageBlob(pinnedStale.sha256, 10);

    const evicted = await store.gcByAge(7 * DAY_MS);

    expect(evicted).toEqual([stale.sha256]);
    expect(await store.hasBlob(stale.sha256)).toBe(false);
    expect(await store.hasBlob(recent.sha256)).toBe(true);
    expect(await store.hasBlob(pinnedStale.sha256)).toBe(true);
  });

  it('evicts abandoned incomplete blobs past the cutoff', async () => {
    const donor = new BlobStore({ dbName: `${BLOBS_DB}-cleanup-donor-${testDbCounter}` });
    const descriptor = await donor.putBlob(makeBytes(1000, 4));
    await store.registerRemoteBlob(descriptor);
    await ageBlob(descriptor.sha256, 10);

    const evicted = await store.gcByAge(7 * DAY_MS);

    expect(evicted).toEqual([descriptor.sha256]);
    expect((await store.listBlobs()).map((row) => row.sha256)).not.toContain(descriptor.sha256);
  });
});

describe('runBlobCleanup', () => {
  it('applies the age rule then the size cap and reports freed bytes', async () => {
    const stale = await store.putBlob(makeBytes(1000, 5), { pin: false });
    const lru = await store.putBlob(makeBytes(1000, 6), { pin: false });
    const fresh = await store.putBlob(makeBytes(1000, 7), { pin: false });
    const pinned = await store.putBlob(makeBytes(1000, 8));
    await ageBlob(stale.sha256, 10);
    await ageBlob(lru.sha256, 2);

    const result = await runBlobCleanup({ retentionDays: 7, maxBytes: 2100 }, store);

    // Age pass removes `stale`; usage is then 3000 > 2100, so the LRU pass
    // removes `lru` (oldest unpinned), leaving fresh + pinned at 2000.
    expect(result.evicted).toBe(2);
    expect(result.freedBytes).toBe(2000);
    expect(await store.hasBlob(stale.sha256)).toBe(false);
    expect(await store.hasBlob(lru.sha256)).toBe(false);
    expect(await store.hasBlob(fresh.sha256)).toBe(true);
    expect(await store.hasBlob(pinned.sha256)).toBe(true);
  });

  it('disabled rules evict nothing', async () => {
    const blob = await store.putBlob(makeBytes(1000, 9), { pin: false });
    await ageBlob(blob.sha256, 400);

    const result = await runBlobCleanup({ retentionDays: null, maxBytes: null }, store);

    expect(result.evicted).toBe(0);
    expect(await store.hasBlob(blob.sha256)).toBe(true);
  });
});

describe('cleanup policy storage', () => {
  it('defaults, persists, and survives malformed values', () => {
    expect(getBlobCleanupPolicy()).toEqual(DEFAULT_BLOB_CLEANUP_POLICY);

    setBlobCleanupPolicy({ retentionDays: 7, maxBytes: null });
    expect(getBlobCleanupPolicy()).toEqual({ retentionDays: 7, maxBytes: null });

    localStorage.setItem('dapp-builder:blob-cleanup-policy', 'not json');
    expect(getBlobCleanupPolicy()).toEqual(DEFAULT_BLOB_CLEANUP_POLICY);

    localStorage.setItem('dapp-builder:blob-cleanup-policy', JSON.stringify({ retentionDays: -3, maxBytes: 'huge' }));
    expect(getBlobCleanupPolicy()).toEqual({ retentionDays: null, maxBytes: null });
  });
});

describe('content no dapp lists any more (review item 5.10)', () => {
  it('unpins the content of a deleted file unless another dapp still lists it', async () => {
    const orphan = await store.putBlob(makeBytes(500, 11)); // pinned: an own upload or a pin-all copy
    const shared = await store.putBlob(makeBytes(500, 12));
    referenced.add(shared.sha256);

    expect(await releaseBlobIfUnreferenced('dapp-a', orphan.sha256, store)).toBe(true);
    expect(await releaseBlobIfUnreferenced('dapp-a', shared.sha256, store)).toBe(false);

    const pinned = new Map((await store.listBlobs()).map((row) => [row.sha256, row.pinned]));
    expect(pinned.get(orphan.sha256)).toBe(false);
    expect(pinned.get(shared.sha256)).toBe(true);
    // Unpinned, it is reclaimed by the ordinary age rule; it is not deleted on the spot.
    expect(await store.hasBlob(orphan.sha256)).toBe(true);
    await ageBlob(orphan.sha256, 40);
    await runBlobCleanup({ retentionDays: 30, maxBytes: null }, store);
    expect(await store.hasBlob(orphan.sha256)).toBe(false);
    expect(await store.hasBlob(shared.sha256)).toBe(true);
  });

  it('sweeps unlisted content past the grace window, keeps listed and just-uploaded content', async () => {
    const listed = await store.putBlob(makeBytes(500, 21));
    const orphan = await store.putBlob(makeBytes(500, 22));
    const justUploaded = await store.putBlob(makeBytes(500, 23)); // its file record is still being written
    await ageBlob(listed.sha256, 5);
    await ageBlob(orphan.sha256, 5);

    const released = await sweepUnreferencedBlobs(new Set([listed.sha256]), { store });

    expect(released).toEqual([orphan.sha256]);
    expect(await store.hasBlob(orphan.sha256)).toBe(false);
    expect(await store.hasBlob(listed.sha256)).toBe(true);
    expect(await store.hasBlob(justUploaded.sha256)).toBe(true);
  });

  it('can unpin instead of delete', async () => {
    const orphan = await store.putBlob(makeBytes(500, 31));
    await ageBlob(orphan.sha256, 5);

    expect(await sweepUnreferencedBlobs(new Set(), { store, unpinOnly: true })).toEqual([orphan.sha256]);
    expect(await store.hasBlob(orphan.sha256)).toBe(true);
    expect((await store.listBlobs()).find((row) => row.sha256 === orphan.sha256)?.pinned).toBe(false);
  });
});
