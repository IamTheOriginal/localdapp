import { leaveDappMembership } from './store/members.ts';
import {
  archiveDappCatalogEntry,
  compactRootPersistence,
  disconnectDappNetwork,
  getDappDoc,
  getDappPersistence,
} from './store/docs.ts';
import { getIdentity } from './identity.ts';
import { requireLocalCopyLoaded } from './store/storageHealth.ts';

/** Grace period so the signed departure flushes to connected peers before we drop out of the room. */
const TOMBSTONE_FLUSH_MS = 2000;

/**
 * Leave a dapp while keeping the local copy ("leave dapp"):
 * 1. write the self-signed membership tombstone while still connected,
 * 2. wait a flush grace so online peers receive it (the founding owner's
 *    device rotates the room credentials once it verifies the departure),
 * 3. archive the catalog entry (stamps `archivedAt`, scrubs credentials so
 *    nothing reconnects on reload),
 * 4. tear down live transports (doc/source/lobby/invite providers + blob mesh).
 *
 * Doc state, IndexedDB persistence, and blob content stay — the app remains
 * openable as a read-only archive, and a fresh invite joins it as a new entry.
 * Known limit: leaving while offline never delivers the tombstone; peers then
 * see the member as silently absent until an owner removes them manually.
 *
 * Two states have no local membership to sign away, so step 1–2 are skipped:
 * - `unsynced`: nothing has synced yet (still waiting in the lobby, or approved
 *   but the first sync never arrived). There is no local copy worth archiving,
 *   so the dapp is removed from this device entirely. If an owner had already
 *   approved the device, they keep listing it until they remove it — same as
 *   the offline limit above.
 * - `removed`: an owner already removed this device. The synced copy is
 *   archived as usual.
 */
export type DappLeaveKind = 'member' | 'unsynced' | 'removed';

/** How leaving will play out for this device — also drives the confirmation wording. */
export async function resolveDappLeaveKind(dappId: string): Promise<DappLeaveKind> {
  const doc = getDappDoc(dappId);
  // An empty members map must mean "never synced", not "IndexedDB still loading" —
  // the unsynced path deletes local data.
  // …and not "IndexedDB never opened" either: that wait used to hang forever; now it stops the leave.
  await requireLocalCopyLoaded(getDappPersistence(dappId));
  const members = doc.getMap('members');
  const publicKey = getIdentity()?.publicKey;
  if (publicKey && members.has(publicKey)) return 'member';
  return members.size === 0 ? 'unsynced' : 'removed';
}

export async function leaveDapp(dappId: string, options: { flushMs?: number } = {}): Promise<DappLeaveKind> {
  const doc = getDappDoc(dappId);
  const kind = await resolveDappLeaveKind(dappId);

  if (kind === 'unsynced') {
    const { deleteDapp } = await import('./dappDeletionRuntime.ts');
    await deleteDapp(dappId);
    return kind;
  }

  if (kind === 'member') {
    await leaveDappMembership(dappId, doc);
    const flushMs = options.flushMs ?? TOMBSTONE_FLUSH_MS;
    if (flushMs > 0) await new Promise((resolve) => setTimeout(resolve, flushMs));
  }

  if (!archiveDappCatalogEntry(dappId)) throw new Error('Unknown dapp');
  disconnectDappNetwork(dappId);
  try {
    const { destroyBlobChannel } = await import('./blobRoomManager.ts');
    destroyBlobChannel(dappId);
  } catch {
    // blob channel never loaded
  }

  // Scrub the departed room's credentials from root update history.
  await compactRootPersistence();
  return kind;
}
