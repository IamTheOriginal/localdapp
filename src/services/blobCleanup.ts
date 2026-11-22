import { getBlobStore, type BlobStore } from './blobStore.ts';
import { onVerifiedFileRemoved } from './store/auth.ts';
import { isBlobStillReferenced } from './store/blobReferences.ts';

/**
 * Device-local blob cleanup policy (docs/plans/2026-08-24-blob-store.md).
 *
 * Cleanup is a per-device concern, so the policy lives in localStorage and is
 * never synced: an always-on keeper node pins everything (pin-all
 * replication), while browsers lazily fetch on demand and reclaim space here.
 * Eviction only ever touches unpinned blobs — a user's own uploads and
 * explicitly pinned files are pinned and therefore never reclaimed, and every
 * evicted file stays listed and re-downloads from any member that holds it.
 */

export interface BlobCleanupPolicy {
  /** Evict unpinned blobs not accessed for this many days; null disables the age rule. */
  retentionDays: number | null;
  /** Evict least-recently-used unpinned blobs above this total; null disables the size cap. */
  maxBytes: number | null;
}

interface BlobCleanupResult {
  evicted: number;
  freedBytes: number;
}

const POLICY_KEY = 'dapp-builder:blob-cleanup-policy';
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_BLOB_CLEANUP_POLICY: BlobCleanupPolicy = {
  retentionDays: 30,
  maxBytes: 2 * 1024 * 1024 * 1024,
};

function storage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function getBlobCleanupPolicy(): BlobCleanupPolicy {
  const raw = storage()?.getItem(POLICY_KEY);
  if (!raw) return { ...DEFAULT_BLOB_CLEANUP_POLICY };
  try {
    const parsed = JSON.parse(raw) as Partial<BlobCleanupPolicy>;
    return {
      retentionDays: typeof parsed.retentionDays === 'number' && parsed.retentionDays > 0 ? parsed.retentionDays : null,
      maxBytes: typeof parsed.maxBytes === 'number' && parsed.maxBytes > 0 ? parsed.maxBytes : null,
    };
  } catch {
    return { ...DEFAULT_BLOB_CLEANUP_POLICY };
  }
}

export function setBlobCleanupPolicy(policy: BlobCleanupPolicy): void {
  storage()?.setItem(POLICY_KEY, JSON.stringify(policy));
}

/** Apply the policy once: age rule first, then the LRU size cap. */
export async function runBlobCleanup(
  policy: BlobCleanupPolicy = getBlobCleanupPolicy(),
  store: BlobStore = getBlobStore(),
): Promise<BlobCleanupResult> {
  const sizes = new Map((await store.listBlobs()).map((row) => [row.sha256, row.size]));
  const evicted: string[] = [];
  if (policy.retentionDays !== null) {
    evicted.push(...await store.gcByAge(policy.retentionDays * DAY_MS));
  }
  if (policy.maxBytes !== null) {
    evicted.push(...await store.gc(policy.maxBytes));
  }
  return {
    evicted: evicted.length,
    freedBytes: evicted.reduce((sum, sha256) => sum + (sizes.get(sha256) ?? 0), 0),
  };
}

// ───── Content nobody lists any more (review item 5.10) ─────
//
// Pin-all devices and keepers pin every blob a dapp lists, and own uploads are pinned
// too. When another member deletes the file record, the pin used to stay for ever.
// Two ways out, both behind the blobReferences.ts check (the same content may be
// listed by another dapp on this device, which may hold the only copy):
//
// - a file deletion this device's auth observer verifies unpins the content when no
//   dapp here lists it any more (browsers and keepers); the age/size rules above then
//   reclaim it like any other unpinned copy;
// - the keeper, which holds every catalog dapp open and runs no age/size cleanup,
//   sweeps its whole store now and then and deletes what no dapp lists
//   (`sweepUnreferencedBlobs`). Deletions it missed while it was down are caught there.

/**
 * Content touched within this window is left alone by the sweep: an upload stores
 * the blob before it writes the file record that lists it (fileIngest.ts).
 */
const UNREFERENCED_GRACE_MS = 60 * 60 * 1000;

/** Unpins the content of a deleted file record unless some dapp on this device still lists it. Returns true when it was released. */
export async function releaseBlobIfUnreferenced(
  dappId: string,
  sha256: string,
  store: BlobStore = getBlobStore(),
): Promise<boolean> {
  if (await isBlobStillReferenced(dappId, sha256)) return false;
  const meta = (await store.listBlobs()).find((row) => row.sha256 === sha256);
  if (!meta?.pinned) return false;
  await store.setPinned(sha256, false);
  return true;
}

/**
 * Releases the content of every file deletion this device verifies (see above).
 * Returns a dispose function. Idempotent per process: a second call adds nothing.
 */
let stopReleasingDeletedFiles: (() => void) | null = null;
export function releaseBlobsOfDeletedFiles(store?: BlobStore): () => void {
  if (stopReleasingDeletedFiles) return stopReleasingDeletedFiles;
  const off = onVerifiedFileRemoved((dappId, record) => {
    if (typeof record.sha256 !== 'string') return;
    void releaseBlobIfUnreferenced(dappId, record.sha256, store).catch((error: unknown) => {
      console.warn('releasing the content of a deleted file failed', error);
    });
  });
  const stop = () => {
    off();
    if (stopReleasingDeletedFiles === stop) stopReleasingDeletedFiles = null;
  };
  stopReleasingDeletedFiles = stop;
  return stop;
}

/**
 * Deletes (or, with `unpinOnly`, unpins) every stored blob that is not in
 * `referenced` and was not touched within the grace window. `referenced` must be
 * the union over EVERY dapp on this device (blobReferences.ts::
 * blobHashesReferencedByAnyDapp) — a partial set deletes content another dapp lists.
 */
export async function sweepUnreferencedBlobs(
  referenced: ReadonlySet<string>,
  options: { store?: BlobStore; unpinOnly?: boolean; now?: number; graceMs?: number } = {},
): Promise<string[]> {
  const store = options.store ?? getBlobStore();
  const cutoff = (options.now ?? Date.now()) - (options.graceMs ?? UNREFERENCED_GRACE_MS);
  const released: string[] = [];
  for (const row of await store.listBlobs()) {
    if (referenced.has(row.sha256) || row.lastAccess > cutoff) continue;
    if (options.unpinOnly) {
      if (!row.pinned) continue;
      await store.setPinned(row.sha256, false);
    } else {
      await store.deleteBlob(row.sha256);
    }
    released.push(row.sha256);
  }
  return released;
}

const STARTUP_DELAY_MS = 30_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Run cleanup shortly after boot (off the critical path) and every few hours
 * while the app stays open. Returns a dispose function.
 */
export function startBlobCleanupScheduler(): () => void {
  const run = () => void runBlobCleanup().catch(() => { /* storage unavailable; retry next tick */ });
  const startupTimer = setTimeout(run, STARTUP_DELAY_MS);
  const interval = setInterval(run, INTERVAL_MS);
  const stopReleasing = releaseBlobsOfDeletedFiles();
  return () => {
    clearTimeout(startupTimer);
    clearInterval(interval);
    stopReleasing();
  };
}
