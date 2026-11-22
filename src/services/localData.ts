import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { requireLocalCopyLoaded, STORAGE_PROBE_DATABASE } from './store/storageHealth.ts';

/**
 * Local-state escape hatches: export everything this device stores, and a
 * clean device reset. Both are honesty features for a local-first product —
 * the user's data must never be trapped in an opaque browser profile.
 *
 * Every app database is a y-indexeddb document store except the key vault
 * (`dapp-builder-keys`), which holds non-extractable CryptoKeys: it can be
 * neither exported (by design) nor deleted here (a reset keeps the identity).
 */

const PROTECTED_DATABASES = new Set(['dapp-builder-keys']);
/** App databases that are not y-indexeddb documents: reset deletes them, export skips them. */
const NON_DOC_DATABASES = new Set(['dapp-builder-blobs', STORAGE_PROBE_DATABASE]);
const NON_DOC_PREFIXES = ['dapp-projection-']; // legacy $db projections (deleted on sight since 2026-09)
const isNonDocDatabase = (name: string) =>
  NON_DOC_DATABASES.has(name) || NON_DOC_PREFIXES.some((prefix) => name.startsWith(prefix));
const RESET_FLAG_KEY = 'dapp-builder-pending-reset';

interface LocalDataExport {
  format: 'dapp-builder-local-export';
  version: 1;
  exportedAt: string;
  /** Base64-encoded Yjs update (full state) per document database. */
  docs: Record<string, string>;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function listAppDatabases(): Promise<string[]> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    throw new Error('local data: this browser cannot enumerate IndexedDB databases');
  }
  const databases = await indexedDB.databases();
  return databases
    .map((db) => db.name)
    .filter((name): name is string => Boolean(name) && !PROTECTED_DATABASES.has(name as string))
    .sort();
}

/** All y-indexeddb document database names on this origin (key vault and non-doc stores excluded). */
export async function listLocalDocDatabases(): Promise<string[]> {
  return (await listAppDatabases()).filter((name) => !isNonDocDatabase(name));
}

/**
 * Serialize every local Yjs document to a portable JSON bundle. Reads through
 * temporary y-indexeddb bindings, so it works whether or not a doc is
 * currently open elsewhere in the app.
 */
export async function exportLocalData(): Promise<LocalDataExport> {
  const names = await listLocalDocDatabases();
  const docs: Record<string, string> = {};
  for (const name of names) {
    const doc = new Y.Doc();
    const persistence = new IndexeddbPersistence(name, doc);
    try {
      // An export with silently empty documents would look like a good backup.
      await requireLocalCopyLoaded(persistence);
      docs[name] = bytesToBase64(Y.encodeStateAsUpdate(doc));
    } finally {
      await persistence.destroy().catch(() => undefined);
      doc.destroy();
    }
  }
  return {
    format: 'dapp-builder-local-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    docs,
  };
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`local data: failed to delete database ${name}`));
    // With the reset running before any doc is opened, nothing should hold a
    // connection; if something does, resolve anyway rather than hanging boot.
    request.onblocked = () => resolve();
  });
}

/**
 * Flag a full local data reset and reload. The deletion itself runs on the
 * next boot (completePendingLocalDataReset) — before any document database is
 * opened, so no live y-indexeddb connection can block it. Identity (key vault
 * + localStorage metadata) survives.
 */
export function requestLocalDataReset(): void {
  localStorage.setItem(RESET_FLAG_KEY, '1');
  window.location.reload();
}

export function isLocalDataResetPending(): boolean {
  try {
    return localStorage.getItem(RESET_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

/** Boot hook: perform a requested reset before any doc database is opened. */
export async function completePendingLocalDataReset(): Promise<boolean> {
  if (!isLocalDataResetPending()) return false;
  const names = await listAppDatabases();
  for (const name of names) {
    await deleteDatabase(name);
  }
  // Earlier builds kept blob chunks in OPFS; drop that directory if it still exists.
  const { clearOpfsBlobStorage } = await import('./blobStore.ts');
  await clearOpfsBlobStorage();
  localStorage.removeItem(RESET_FLAG_KEY);
  return true;
}
