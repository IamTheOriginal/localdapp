import { dappPersistences, sourcePersistences } from './store/docs.ts';
import type { MeshChannelStatus } from './blobRoomManager.ts';

/**
 * Sync observability for one dapp plus the wake-up watchdog.
 *
 * A dapp's documents travel over the member mesh (blobRoomManager.ts), which
 * sweeps dead sessions by itself every 30 s. What it cannot notice is a device
 * waking from sleep: data channels and the broker socket may have died without
 * a close event. The watchdog nudges every open mesh channel the moment the
 * page becomes visible, regains focus or comes back online, so devices resume
 * syncing right away instead of after the next sweep.
 *
 * The mesh is imported dynamically — this module loads at app start and must
 * not pull the WebRTC stack into that chunk.
 */

function nudgeMesh(): void {
  void import('./blobRoomManager.ts').then(({ nudgeBlobChannels }) => nudgeBlobChannels()).catch(() => undefined);
}

let watchdogStop: (() => void) | null = null;

export function startSyncWatchdog(): () => void {
  if (watchdogStop) return watchdogStop;
  const onWake = () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    nudgeMesh();
  };
  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('online', onWake);
  window.addEventListener('focus', onWake);
  watchdogStop = () => {
    document.removeEventListener('visibilitychange', onWake);
    window.removeEventListener('online', onWake);
    window.removeEventListener('focus', onWake);
    watchdogStop = null;
  };
  return watchdogStop;
}

// ── panel snapshot ──

export interface SyncDocSnapshot {
  label: 'data' | 'source';
  /** Live updates pushed from / applied on this device since the mesh channel opened. */
  sent: number;
  received: number;
  lastSentAt: number | null;
  lastReceivedAt: number | null;
  /** Whether the local IndexedDB copy has finished loading. */
  persistenceSynced: boolean;
}

function persistenceLoaded(persistence: unknown): boolean {
  return Boolean((persistence as { synced?: boolean } | undefined)?.synced);
}

/** Per-document view of the mesh status: traffic counters plus local-storage state. */
export function getDappSyncDocs(dappId: string, mesh: MeshChannelStatus): SyncDocSnapshot[] {
  const idle = { sent: 0, received: 0, lastSentAt: null, lastReceivedAt: null };
  return [
    { label: 'data', ...(mesh.docs?.main ?? idle), persistenceSynced: persistenceLoaded(dappPersistences.get(`dapp-${dappId}`)) },
    { label: 'source', ...(mesh.docs?.source ?? idle), persistenceSynced: persistenceLoaded(sourcePersistences.get(`dapp-${dappId}-source-v1`)) },
  ];
}
