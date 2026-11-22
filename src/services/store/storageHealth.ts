/**
 * Local storage health. y-indexeddb tells nobody when IndexedDB fails: its
 * `whenSynced` promise never settles if the database cannot be opened (private
 * windows of some browsers, a blocked upgrade, a damaged profile), and a write
 * that fails — `QuotaExceededError` on a full disk — is dropped without a word.
 * The app then keeps working in memory and every edit is gone after a reload.
 *
 * This module is the one place that turns both cases into a visible state
 * (`useStorageHealth` → the banner in the app shell) and gives callers a load
 * wait that ends. Leaf module: no store imports.
 */

export type StorageHealth = 'ok' | 'unavailable' | 'write-failed';

interface LoadablePersistence {
  whenSynced: PromiseLike<unknown>;
}

const DEFAULT_LOAD_TIMEOUT_MS = 10_000;

let health: StorageHealth = 'ok';
const listeners = new Set<() => void>();

export function getStorageHealth(): StorageHealth {
  return health;
}

export function onStorageHealthChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** `write-failed` is never downgraded: data written before the failure is safe, later edits are not. */
function setStorageHealth(next: StorageHealth): void {
  if (health === next || health === 'write-failed') return;
  health = next;
  listeners.forEach((listener) => {
    try { listener(); } catch (error) { console.error('storage health listener failed', error); }
  });
}

export function reportStorageUnavailable(reason: unknown): void {
  console.error('local storage is not available — changes are kept in memory only', reason);
  setStorageHealth('unavailable');
}

export function reportStorageWriteFailure(reason: unknown): void {
  console.error('a write to local storage failed — recent changes may not survive a reload', reason);
  setStorageHealth('write-failed');
}

/**
 * Wait for a document's local copy to load, but not forever. Resolves `true`
 * once loaded; `false` when it did not load in time or failed — the storage is
 * then marked unavailable. Callers whose decision depends on the loaded state
 * (leaving, exporting) must stop on `false`; the rest carry on in memory.
 */
export async function whenLocalCopyLoaded(
  persistence: LoadablePersistence | null | undefined,
  timeoutMs: number = DEFAULT_LOAD_TIMEOUT_MS,
): Promise<boolean> {
  if (!persistence) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => { resolve('timeout'); }, timeoutMs); });
  try {
    const outcome = await Promise.race([Promise.resolve(persistence.whenSynced).then(() => 'loaded' as const), timedOut]);
    if (outcome === 'loaded') return true;
    reportStorageUnavailable(new Error(`the local database did not open within ${timeoutMs} ms`));
    return false;
  } catch (error) {
    reportStorageUnavailable(error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Error for flows that must not decide anything on an unloaded document. */
export class LocalStorageUnavailableError extends Error {
  constructor() {
    super('Local storage is not available on this device right now. Reload the app; if it stays like this, check that the browser may store data for this site (not a private window) and that the disk is not full.');
    this.name = 'LocalStorageUnavailableError';
  }
}

export async function requireLocalCopyLoaded(persistence: LoadablePersistence | null | undefined, timeoutMs?: number): Promise<void> {
  if (!(await whenLocalCopyLoaded(persistence, timeoutMs))) throw new LocalStorageUnavailableError();
}

function looksLikeStorageWriteError(reason: unknown): boolean {
  const name = reason instanceof Error || reason instanceof DOMException ? reason.name : '';
  const text = `${name} ${reason instanceof Error ? reason.message : String(reason)}`;
  return /QuotaExceededError|quota.*exceeded|disk.*full|NS_ERROR_FILE_NO_DEVICE_SPACE/i.test(text);
}

/** Opened and deleted again at start to see whether IndexedDB works at all; localData.ts skips the name. */
export const STORAGE_PROBE_DATABASE = 'dapp-builder-storage-probe';

let watching = false;

/**
 * Start watching once at app start. y-indexeddb does not handle the promise of
 * its own writes, so a failed one reaches the page as an `unhandledrejection`
 * — the only signal there is. A probe open catches storage that is not
 * available at all before any document waits for it.
 */
export function watchStorageHealth(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  window.addEventListener('unhandledrejection', (event) => {
    if (looksLikeStorageWriteError(event.reason)) reportStorageWriteFailure(event.reason);
  });
  try {
    const request = indexedDB.open(STORAGE_PROBE_DATABASE, 1);
    request.onerror = () => { reportStorageUnavailable(request.error); };
    request.onsuccess = () => {
      // Nothing is kept: an empty database left behind would be taken for a document
      // by the local-data export and reset (localData.ts lists every database).
      request.result.close();
      indexedDB.deleteDatabase(STORAGE_PROBE_DATABASE);
    };
  } catch (error) {
    reportStorageUnavailable(error);
  }
}
