import * as Y from 'yjs';
import { IndexeddbPersistence, clearDocument, storeState } from 'y-indexeddb';
import { WebrtcProvider } from 'y-webrtc';
import { getIdentity, getSigningIdentity } from '../identity.ts';
import { signalingEndpoints, webrtcPeerOpts } from '../signalingConfig.ts';
import { getRole, getVerifiedInvites, getVerifiedMembers, onVerifiedInvitesChange, onVerifiedMembersChange, setupAuthObserver, teardownAuthObserver } from './auth.ts';
import { setupRekeyObserver, teardownRekeyObserver } from './rotation.ts';
import { clearMemberBaseline } from './memberBaseline.ts';
import { runDappDocMigrations, CURRENT_DAPP_DOC_VERSION } from './migrations.ts';
import { parseAccessGrant, verifyAccessGrantSignature } from './accessGrant.ts';
import { signLobbyAnnounce, verifiedLobbyStates } from './lobbyAnnounce.ts';
import { FOUNDER_PLACEHOLDER_NAME } from './protocolCore.ts';
import { forgetAccessGrants, isGranterRefused, offerAccessGrant } from './pendingGrant.ts';
import { watchReplacedRecordContainers } from './recordContainerMerge.ts';
import { compactDappHistory } from './historyCompaction.ts';
import { reportStorageWriteFailure, whenLocalCopyLoaded } from './storageHealth.ts';
import { deriveConnectionCode } from '../connectionCode.ts';
import { bufferToHex } from '../../lib/hex.ts';

// ───── Root Doc (Dapp catalog) ─────

let rootDoc: Y.Doc | null = null;
let rootPersistence: IndexeddbPersistence | null = null;

export function getRootDoc(): Y.Doc {
  if (!rootDoc) {
    rootDoc = new Y.Doc();
    rootPersistence = new IndexeddbPersistence('dapp-builder-root', rootDoc);
  }
  return rootDoc;
}

export function getRootPersistence(): IndexeddbPersistence | null {
  return rootPersistence;
}

/** Waits for root restoration and forces the current root state into IndexedDB. */
export async function checkpointRootPersistence(): Promise<void> {
  if (!rootPersistence) return;
  await rootPersistence.whenSynced;
  await storeState(rootPersistence);
}

/**
 * Waits until everything written to `persistence` so far is in IndexedDB. y-indexeddb
 * writes each update in its own IndexedDB transaction, and a document whose database
 * is still opening is written only once it is open — a reload in between loses it.
 * `storeState(…, false)` runs a read-write transaction on the updates store, which
 * IndexedDB orders after every earlier one, so its completion is the barrier (it only
 * writes when the store is due for compaction anyway). False when the local copy is
 * not available (reported by storageHealth.ts) or the barrier failed.
 */
export async function flushLocalPersistence(persistence: IndexeddbPersistence | null | undefined, timeoutMs?: number): Promise<boolean> {
  if (!persistence) return true;
  if (!(await whenLocalCopyLoaded(persistence, timeoutMs))) return false;
  try {
    await storeState(persistence, false);
    return true;
  } catch (error) {
    reportStorageWriteFailure(error);
    return false;
  }
}

export function getDappsList(): Y.Array<Y.Map<string>> {
  return getRootDoc().getArray<Y.Map<string>>('dapps');
}

export function generateRoomPassword(): string {
  return bufferToHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

interface LobbyAnnounceFields { encPublicKey?: string; isOwner: boolean; inviteId?: string }

/**
 * Announces this device in a lobby (re-applied on `synced` — y-webrtc resets local
 * state). The announce is SIGNED (lobbyAnnounce.ts): peers ignore a lobby state that
 * does not prove possession of the key it names. Returns a function that re-announces
 * when the live fields (the owner flag) may have changed.
 */
function announceIdentity(provider: WebrtcProvider, lobbyId: string, fields: LobbyAnnounceFields | (() => LobbyAnnounceFields)): () => void {
  const identity = getIdentity();
  if (!identity) return () => undefined;
  let announced = '';
  let round = 0;
  const apply = () => {
    // A function is re-evaluated on every (re)announce, so live values such as the owner flag never go stale.
    const current = typeof fields === 'function' ? fields() : fields;
    const encPublicKey = current.encPublicKey ?? identity.encPublicKey;
    if (!encPublicKey) return; // nothing a grant could be encrypted to — not a usable announce
    const claim = {
      publicKey: identity.publicKey,
      encPublicKey,
      isOwner: current.isOwner,
      ...(current.inviteId ? { inviteId: current.inviteId } : {}),
    };
    const fingerprint = JSON.stringify(claim);
    const local = provider.awareness.getLocalState() as { announceSig?: unknown } | null;
    if (fingerprint === announced && typeof local?.announceSig === 'string') return; // still standing
    const mine = ++round;
    void getSigningIdentity()
      .then((signing) => signLobbyAnnounce(lobbyId, claim, signing))
      .then((announceSig) => {
        if (mine !== round) return; // a newer announce is on its way
        // One state update: a peer must never see new fields next to the old signature.
        provider.awareness.setLocalState({
          ...(provider.awareness.getLocalState() ?? {}),
          ...claim,
          displayName: identity.displayName,
          announceSig,
        });
        announced = fingerprint;
      })
      .catch((error: unknown) => console.error('lobby: could not sign the announce — this device stays invisible in the lobby', error));
  };
  const reapply = () => {
    announced = '';
    apply();
  };
  apply();
  provider.on('synced', reapply);
  return apply;
}

/** The invite lobby a not-yet-approved dapp waits in ('' once approved / for own dapps). */
export function getDappLobbyId(dappId: string): string {
  return getCatalogItem(dappId)?.get('lobbyId') || '';
}

// ───── Dapp Docs & Lobby Docs ─────

export const dappDocs = new Map<string, Y.Doc>();
export const dappPersistences = new Map<string, IndexeddbPersistence>();

// ───── Transport ─────
//
// A dapp's main and source documents travel ONLY over the member mesh
// (services/blobRoomManager.ts): peers prove a whitelisted member key before
// any document byte is exchanged. y-webrtc — which hands the whole document to
// anyone holding the room password — is left for the lobby and invite rooms
// alone, where the other side is by definition not a member yet and only
// presence plus an encrypted grant is shared.
//
// Opening a dapp doc with room credentials brings the mesh up. The import is
// dynamic: the mesh imports this module, and the WebRTC stack stays out of the
// main chunk. Runtimes that sequence this themselves (the headless keeper
// attaches file persistence first) switch the automatic part off.
let meshAutoConnect = true;
/** Dapps whose one-time doc observers (catalog meta, auth, rekey) are attached. */
const observedDapps = new Set<string>();
/** Dapps the mesh was already asked to connect (cleared when the transport is torn down). */
const meshRequested = new Set<string>();

export function setMeshAutoConnect(enabled: boolean): void {
  meshAutoConnect = enabled;
}

function requestMesh(dappId: string): void {
  if (!meshAutoConnect || meshRequested.has(dappId)) return;
  meshRequested.add(dappId);
  void import('../blobRoomManager.ts')
    .then(({ ensureBlobChannel }) => ensureBlobChannel(dappId))
    .catch((error: unknown) => {
      meshRequested.delete(dappId);
      console.error('member mesh failed to start', error);
    });
}
// Per-doc "observer already attached" guards (providers can reconnect after
// credential rotation; doc-level observers must not stack).
const invitesObservedDocs = new WeakSet<Y.Doc>();
const metaObservedDocs = new WeakSet<Y.Doc>();

// Code App source is deliberately isolated from the main config/data document.
export const sourceDocs = new Map<string, Y.Doc>();
export const sourcePersistences = new Map<string, IndexeddbPersistence>();

const lobbyDocs = new Map<string, Y.Doc>();
const lobbyProviders = new Map<string, WebrtcProvider>();

export const inviteDocs = new Map<string, Y.Doc>();
export const inviteProviders = new Map<string, WebrtcProvider>();
/** dapp id → the invite lobbies that dapp opened (the provider registry above is shared by all dapps). */
const dappInviteIds = new Map<string, Set<string>>();
/** invite id → re-announce this device in that lobby (after a role change). */
const inviteReannouncers = new Map<string, () => void>();
// Used-up invites keep their lobby room alive briefly so the last credential
// grant can still sync to the joiner (see syncInvites cleanup).
const inviteDestroyTimers = new Map<string, ReturnType<typeof setTimeout>>();
const INVITE_LOBBY_LINGER_MS = 30_000;

function getCatalogItem(dappId: string): Y.Map<string> | null {
  const list = getDappsList();
  for (let i = 0; i < list.length; i++) {
    const item = list.get(i);
    if (item.get('id') === dappId) return item;
  }
  return null;
}

/** Current room credentials + rotation epoch for a dapp, from the local root catalog. */
export function getDappCredentials(dappId: string): { roomId: string; roomPassword: string; epoch: number } {
  const item = getCatalogItem(dappId);
  const epoch = Number.parseInt(item?.get('roomEpoch') || '0', 10);
  return {
    roomId: item?.get('roomId') || '',
    roomPassword: item?.get('roomPassword') || '',
    epoch: Number.isFinite(epoch) ? epoch : 0,
  };
}

/** Replace a dapp's room credentials in the local root catalog (rotation bookkeeping). */
export function updateDappCredentials(dappId: string, roomId: string, roomPassword: string, epoch: number): boolean {
  const item = getCatalogItem(dappId);
  if (!item) return false;
  item.set('roomId', roomId);
  item.set('roomPassword', roomPassword);
  item.set('roomEpoch', String(epoch));
  return true;
}

/**
 * The peer whitelist: whether a proven public key may connect to this dapp's
 * member mesh (live document sync + files). Normally: any current member.
 * Bootstrap case: a fresh joiner's members map is still empty (it arrives WITH
 * the doc the mesh is about to sync), so until it syncs, exactly the key that
 * granted this device access — named in the grant, human-verified via the
 * connection code — is trusted. A device with neither trusts nobody.
 */
export function isTrustedBlobPeer(dappId: string, publicKey: string): boolean {
  // The whitelist is the VERIFIED members: an entry a peer just wrote into the doc
  // (its own key, say, after it was removed) must not open the mesh to it.
  const verified = getVerifiedMembers(dappId);
  if (verified) {
    const role = verified.get(publicKey)?.role;
    return role === 'owner' || role === 'editor' || role === 'viewer';
  }
  const members = getDappDoc(dappId).getMap('members');
  if (members.size > 0) {
    const member = members.get(publicKey) as Y.Map<unknown> | undefined;
    const role = member?.get('role');
    return role === 'owner' || role === 'editor' || role === 'viewer';
  }
  const grantedBy = getCatalogItem(dappId)?.get('grantedBy') || '';
  return Boolean(grantedBy) && publicKey === grantedBy;
}

/**
 * Mark a dapp as left/archived in the local catalog: stamp `archivedAt` and
 * scrub every room/lobby credential so no provider reconnects on reload.
 * Local doc state and persistence are untouched — the copy stays readable.
 */
export function archiveDappCatalogEntry(dappId: string): boolean {
  const item = getCatalogItem(dappId);
  if (!item) return false;
  item.set('archivedAt', new Date().toISOString());
  for (const key of ['roomId', 'roomPassword', 'roomEpoch', 'lobbyId', 'lobbyPassword', 'grantedBy']) {
    item.delete(key);
  }
  return true;
}

/**
 * Tear down the lobby and invite transports for a dapp while keeping docs,
 * undo managers, and IndexedDB persistence intact; the member mesh is
 * destroyed by the caller (`destroyBlobChannel`). Complements
 * archiveDappCatalogEntry, which prevents reconnection on the next load.
 */
export function disconnectDappNetwork(dappId: string): void {
  const key = `dapp-${dappId}`;
  const doc = dappDocs.get(key);
  if (doc) {
    for (const inviteId of Array.from(doc.getMap('invites').keys())) {
      try { inviteProviders.get(inviteId)?.destroy(); } catch { /* already closed */ }
      inviteProviders.delete(inviteId);
      inviteDocs.get(inviteId)?.destroy();
      inviteDocs.delete(inviteId);
    }
  }
  try { lobbyProviders.get(key)?.destroy(); } catch { /* already closed */ }
  lobbyProviders.delete(key);
  lobbyDocs.get(key)?.destroy();
  lobbyDocs.delete(key);
  meshRequested.delete(dappId);
}

export type BlobReplicationMode = 'onDemand' | 'pinAll';

/** Per-device blob replication preference for a dapp (root catalog is local-only). */
export function getDappBlobReplication(dappId: string): BlobReplicationMode {
  return getCatalogItem(dappId)?.get('blobReplication') === 'pinAll' ? 'pinAll' : 'onDemand';
}

export function setDappBlobReplication(dappId: string, mode: BlobReplicationMode): boolean {
  const item = getCatalogItem(dappId);
  if (!item) return false;
  item.set('blobReplication', mode);
  return true;
}

// The member mesh follows credential rotations through this hook instead of
// docs.ts importing it statically — it registers lazily when first used.
const providerReconnectListeners = new Set<(dappId: string) => void>();

export function registerProviderReconnectListener(listener: (dappId: string) => void): () => void {
  providerReconnectListeners.add(listener);
  return () => providerReconnectListeners.delete(listener);
}

/**
 * Move the dapp's transport to the credentials currently in the catalog. Used
 * after credential rotation; doc state and persistence are untouched — the
 * member mesh reconnects under the topic derived from the new credentials.
 */
export function reconnectDappProviders(dappId: string): void {
  meshRequested.delete(dappId);
  getDappDoc(dappId);
  providerReconnectListeners.forEach((listener) => {
    try {
      listener(dappId);
    } catch (error) {
      console.error('provider reconnect listener failed', error);
    }
  });
}

/** The Code App source document. It syncs over the member mesh as doc kind `source`. */
export function getDappSourceDoc(dappId: string): Y.Doc {
  const key = `dapp-${dappId}-source-v1`;
  let doc = sourceDocs.get(key);
  if (!doc) {
    doc = new Y.Doc();
    sourceDocs.set(key, doc);
    sourcePersistences.set(key, new IndexeddbPersistence(key, doc));
  }
  return doc;
}

export function getDappSourcePersistence(dappId: string): IndexeddbPersistence | null {
  return sourcePersistences.get(`dapp-${dappId}-source-v1`) || null;
}

/**
 * y-indexeddb's `clearData()` starts the database deletion without waiting for
 * it, so "deleted" used to be reported while the data was still on disk (or the
 * deletion was blocked by another tab). Deleting again is harmless and awaited;
 * a blocked request resolves too — the other tab's connection ends with it.
 */
function deleteIndexedDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => { resolve(); };
    request.onblocked = () => { resolve(); };
    request.onerror = () => {
      console.warn(`could not delete local database ${name}`, request.error);
      resolve();
    };
  });
}

async function destroyDappSourceResources(dappId: string): Promise<void> {
  const key = `dapp-${dappId}-source-v1`;
  const persistence = sourcePersistences.get(key);
  if (persistence) await persistence.clearData();
  else await clearDocument(key);
  await deleteIndexedDatabase(key);
  sourceDocs.get(key)?.destroy();
  sourcePersistences.delete(key);
  sourceDocs.delete(key);
}

export async function clearIndexeddbDocument(name: string): Promise<void> {
  await clearDocument(name);
}

/** Rewrites root persistence to one current-state update, removing deleted credentials from update history. */
export async function compactRootPersistence(): Promise<void> {
  if (!rootPersistence) return;
  await rootPersistence.whenSynced;
  await storeState(rootPersistence, true);
}

/** Dapps being erased right now; `getDappDoc` must not bring their document back. */
const purgingDapps = new Set<string>();
/** y-indexeddb's `whenSynced` never settles when the database cannot be opened; deletion must not hang on it. */
const PURGE_LOAD_TIMEOUT_MS = 5_000;

export async function purgeDappLocalResources(dappId: string): Promise<void> {
  const key = `dapp-${dappId}`;
  const doc = dappDocs.get(key) ?? getDappDoc(dappId);
  purgingDapps.add(dappId);
  try {
    await purgeDappResources(dappId, key, doc);
  } finally {
    purgingDapps.delete(dappId);
  }
}

async function purgeDappResources(dappId: string, key: string, doc: Y.Doc): Promise<void> {
  // The mesh goes first: while it is up, a handshake or a pull asks for the document
  // and would recreate it — with a new database — in the middle of the erasure.
  try {
    const { destroyBlobChannel } = await import('../blobRoomManager.ts');
    destroyBlobChannel(dappId);
  } catch {
    // blob channel never loaded
  }
  const loaded = dappPersistences.get(key)?.whenSynced.catch(() => undefined);
  if (loaded) await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, PURGE_LOAD_TIMEOUT_MS))]);
  const inviteIds = Array.from(doc.getMap('invites').keys());
  // File records die with the doc; without this, their blob content would
  // stay orphaned in the local chunk store until a full device reset.
  const blobHashes = new Set<string>();
  doc.getMap('files').forEach((raw) => {
    const sha256 = (raw as Y.Map<unknown>).get('sha256');
    if (typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256)) blobHashes.add(sha256);
  });

  lobbyProviders.get(key)?.destroy();
  for (const inviteId of inviteIds) {
    inviteProviders.get(inviteId)?.destroy();
    inviteDocs.get(inviteId)?.destroy();
    inviteProviders.delete(inviteId);
    inviteDocs.delete(inviteId);
  }

  const persistence = dappPersistences.get(key);
  if (persistence) await persistence.clearData();
  else await clearDocument(key);
  await deleteIndexedDatabase(key);
  doc.destroy();
  lobbyDocs.get(key)?.destroy();

  meshRequested.delete(dappId);
  observedDapps.delete(dappId);
  forgetAccessGrants(dappId);
  // A document created later under this id (a rejoin in the same session) needs its own observers.
  teardownAuthObserver(dappId);
  teardownRekeyObserver(dappId);
  // The verified member baseline dies with the local copy: a rejoin starts from what the
  // approving owner serves, trust on first use again (memberBaseline.ts). Cleared here rather
  // than inside teardownAuthObserver, which also runs where a session merely ends and the
  // baseline is exactly what must survive.
  clearMemberBaseline(dappId);
  // Same for the seal this device verified last (sourceSeal.ts). Dynamic: sourceSeal imports this module.
  void import('./sourceSeal.ts').then((seal) => {
    seal.forgetSourceSeal(dappId);
    seal.clearSourceSealMemory(dappId);
  }).catch((error: unknown) => console.error('could not clear the source seal memory', error));
  dappPersistences.delete(key);
  dappDocs.delete(key);
  lobbyProviders.delete(key);
  lobbyDocs.delete(key);

  await destroyDappSourceResources(dappId);

  try {
    const { destroyReadModel } = await import('./readModel.ts');
    destroyReadModel(dappId);
  } catch (error) {
    console.warn('read-model cleanup after dapp deletion failed', error);
  }
  if (blobHashes.size > 0) {
    try {
      const { getBlobStore } = await import('../blobStore.ts');
      // Content another dapp on this device still lists keeps its local copy:
      // this device may hold the only one.
      const { blobHashesReferencedElsewhere } = await import('./blobReferences.ts');
      const keep = await blobHashesReferencedElsewhere(dappId);
      const store = getBlobStore();
      for (const sha256 of blobHashes) {
        if (!keep.has(sha256)) await store.deleteBlob(sha256);
      }
    } catch (error) {
      console.warn('blob cleanup after dapp deletion failed', error);
    }
  }
}

export function getDappDoc(dappId: string): Y.Doc {
  const key = `dapp-${dappId}`;
  let existingDoc = dappDocs.get(key);
  // Asked for while the dapp is being erased (a timer, a late handshake): hand out an
  // empty throwaway instead of recreating the document, its database and its mesh.
  if (!existingDoc && purgingDapps.has(dappId)) return new Y.Doc();
  if (!existingDoc) {
    const doc = new Y.Doc();
    existingDoc = doc;
    // Before anything can reach the document: a collection container of this device that
    // loses to a concurrently created one gets this device's records put back (5.9).
    watchReplacedRecordContainers(doc, () => getIdentity()?.publicKey);
    const persistence = new IndexeddbPersistence(key, doc);
    dappDocs.set(key, doc);
    dappPersistences.set(key, persistence);
    const configMap = doc.getMap('config');

    // Migration hook: bring the doc to CURRENT_DAPP_DOC_VERSION once real
    // content exists. An empty doc (fresh join, content still syncing) must
    // not be stamped — that would mark unmigrated state as migrated.
    // Legacy array collections are converted by owner devices on open
    // (dynamic import — data.ts imports this module).
    const migrate = () => {
      runDappDocMigrations(doc);
      void import('./data.ts').then(({ migrateLegacyCollections }) => migrateLegacyCollections(dappId)).catch(() => undefined);
      // Founder entries used to be named "Owner"; the founder's own device puts its real name there.
      void import('./members.ts').then(({ healFounderName }) => healFounderName(dappId)).catch(() => undefined);
      // Owner devices drop expired record/file tombstones and superseded rekey entries (5.10).
      try {
        const self = getIdentity()?.publicKey;
        if (self && getRole(dappId, self) === 'owner') compactDappHistory(doc, { currentEpoch: getDappCredentials(dappId).epoch });
      } catch (error) {
        console.warn('history compaction failed', error);
      }
    };
    void persistence.whenSynced.then(() => {
      if (configMap.size > 0) {
        migrate();
        return;
      }
      const onFirstContent = () => {
        if (configMap.size === 0) return;
        configMap.unobserve(onFirstContent);
        migrate();
      };
      configMap.observe(onFirstContent);
    });
  }
  
  const doc = existingDoc;

  // Retrieve all credentials from the root catalog
  const catalogItem = getCatalogItem(dappId);
  const roomId = catalogItem?.get('roomId') || '';
  const roomPassword = catalogItem?.get('roomPassword') || '';
  const lobbyId = catalogItem?.get('lobbyId') || '';
  const lobbyPassword = catalogItem?.get('lobbyPassword') || '';

  const signalingServer = signalingEndpoints();

  // 1. Connect to Lobby Provider (Invitee only)
  if (lobbyId && lobbyPassword && !roomId && !lobbyDocs.has(key)) {
    const lDoc = new Y.Doc();
    lobbyDocs.set(key, lDoc);
    const lProvider = new WebrtcProvider(lobbyId, lDoc, { 
      password: lobbyPassword,
      signaling: signalingServer,
      peerOpts: webrtcPeerOpts(),
    });
    lobbyProviders.set(key, lProvider);

    const identity = getIdentity();
    if (identity) {
      announceIdentity(lProvider, lobbyId, { encPublicKey: identity.encPublicKey, isOwner: false });
      const grantedMap = lDoc.getMap('grantedAccess');
      const signatureMap = lDoc.getMap('grantSignatures');
      // Owner devices that PROVED their key in this lobby (signed announce) — the ones this
      // device shows a connection code for. Remembered, because the approving owner may be
      // gone again by the time its grant is processed.
      const provenOwners = new Map<string, string>();
      const noteOwners = async () => {
        for (const state of await verifiedLobbyStates(lobbyId, lProvider.awareness.getStates().values())) {
          const peer = state as { isOwner?: unknown; publicKey?: unknown; displayName?: unknown };
          if (peer.isOwner === true && typeof peer.publicKey === 'string') {
            provenOwners.set(peer.publicKey, typeof peer.displayName === 'string' && peer.displayName ? peer.displayName : 'Owner device');
          }
        }
      };
      // A grant is USED only after the person joining confirmed who approved them
      // (pendingGrant.ts: "evil twin" owner). Until then it waits — also across a reload,
      // because the approving device may be offline again by then: the still-encrypted
      // grant and its signature are kept in the local-only catalog entry.
      let heldPayload: string | null = null;
      const holdGrant = async (payload: string, signatureEntry: unknown, signedBy: string, approverName: string) => {
        // Awareness changes re-run this for the same grant; decrypting and writing it again would only grow the root doc.
        if (isGranterRefused(dappId, signedBy) || heldPayload === payload) return;
        const { decryptMessage } = await import('../identity.ts');
        const grant = parseAccessGrant(await decryptMessage(payload));
        if (!grant || grant.grantedBy !== signedBy) return;
        heldPayload = payload;
        const held = JSON.stringify({ payload, signature: signatureEntry, approverName });
        const entry = getCatalogItem(dappId);
        if (entry && entry.get('pendingGrant') !== held) entry.set('pendingGrant', held);
        offerAccessGrant({
          dappId,
          approvedBy: signedBy,
          approverName,
          code: await deriveConnectionCode(identity.publicKey, signedBy, lobbyId),
          automatic: (signatureEntry as { automatic?: unknown } | null)?.automatic === true,
          accept: () => {
            // Update the local catalog with the decrypted Main Room credentials. `grantedBy`
            // is pinned: it bootstraps peer trust (doc-sync) until the members map has synced.
            const item = getCatalogItem(dappId);
            if (item) {
              item.set('roomId', grant.roomId);
              item.set('roomPassword', grant.roomPassword);
              if (grant.epoch) item.set('roomEpoch', grant.epoch);
              item.set('grantedBy', signedBy);
              item.delete('pendingGrant');
            }
            // Disconnect from Lobby as we no longer need it
            try { lProvider.destroy(); } catch { /* already closed */ }
            lobbyProviders.delete(key);
            // Call getDappDoc again to trigger the Main Room connection
            getDappDoc(dappId);
          },
          discard: () => {
            heldPayload = null;
            getCatalogItem(dappId)?.delete('pendingGrant');
            // Make room for the real owner's grant (the entry is per joiner key).
            if (grantedMap.get(identity.publicKey) === payload) grantedMap.delete(identity.publicKey);
          },
        });
      };
      let accepting = false;
      const tryAcceptGrant = async () => {
        const payload = grantedMap.get(identity.publicKey);
        if (typeof payload !== 'string' || !payload || accepting) return;
        accepting = true;
        try {
          // The lobby doc is writable by everyone holding the invite link (and by every member,
          // removed ones included). A grant therefore counts only when it is signed — over this
          // lobby, this device and this exact ciphertext — by an owner that proved its key here,
          // and names that same owner inside. No signature, no entry: older builds' unsigned
          // grants (and their "pick any announced owner" fallback) are not accepted any more.
          const signedBy = await verifyAccessGrantSignature(signatureMap.get(identity.publicKey), { lobbyId, joinerKey: identity.publicKey, ciphertext: payload });
          if (!signedBy) return;
          await noteOwners();
          if (!provenOwners.has(signedBy)) {
            console.warn('lobby: ignoring a credential grant signed by a device that never proved an owner key in this lobby');
            return;
          }
          await holdGrant(payload, signatureMap.get(identity.publicKey), signedBy, provenOwners.get(signedBy) ?? 'Owner device');
        } catch (error) {
          console.error('lobby: could not process the credential grant', error);
        } finally {
          accepting = false;
        }
      };
      // A grant held before a reload: its signature is checked again; that its signer had
      // proved an owner key in the lobby was checked before it was stored.
      const stored = catalogItem?.get('pendingGrant');
      if (typeof stored === 'string' && stored) {
        void (async () => {
          try {
            const parsed = JSON.parse(stored) as { payload?: unknown; signature?: unknown; approverName?: unknown };
            if (typeof parsed.payload !== 'string') return;
            const signedBy = await verifyAccessGrantSignature(parsed.signature, { lobbyId, joinerKey: identity.publicKey, ciphertext: parsed.payload });
            if (signedBy) await holdGrant(parsed.payload, parsed.signature, signedBy, typeof parsed.approverName === 'string' ? parsed.approverName : 'Owner device');
          } catch (error) {
            console.error('lobby: could not restore the held credential grant', error);
          }
        })();
      }
      lProvider.awareness.on('change', () => { void noteOwners().then(tryAcceptGrant); });
      grantedMap.observe(() => { void tryAcceptGrant(); });
      signatureMap.observe(() => { void tryAcceptGrant(); });
    }
  }

  // Manage Dynamic Invite Lobbies (Owner only)
  if (roomId && roomPassword) {
    const invitesMap = doc.getMap('invites');
    // Every member holds the room credentials and sits in the invite lobbies,
    // but only owners can approve. Joiners list one connection code per
    // announced owner, so the flag must reflect the real role — read live,
    // because the members map may still be loading or the role may change.
    const membersMap = doc.getMap('members');
    const localIsOwner = () => {
      const self = getIdentity();
      const member = self ? membersMap.get(self.publicKey) as Y.Map<unknown> | undefined : undefined;
      return member?.get('role') === 'owner';
    };
    const syncInvites = () => {
      // Lobbies are opened for VERIFIED invites only (owner-signed, not closed — see
      // auth.ts "Invites"). Opening one for whatever entry sits in the map let any member
      // plant a lobby that owner devices then served, 1-step admission included.
      const verified = getVerifiedInvites(dappId);
      let ownInvites = dappInviteIds.get(dappId);
      if (!ownInvites) {
        ownInvites = new Set();
        dappInviteIds.set(dappId, ownInvites);
      }
      const openedHere = ownInvites;
      verified?.forEach((invite, inviteId) => {
        const lId = typeof invite.lobbyId === 'string' ? invite.lobbyId : undefined;
        const lPw = typeof invite.lobbyPassword === 'string' ? invite.lobbyPassword : undefined;
        const pendingDestroy = inviteDestroyTimers.get(inviteId);
        if (pendingDestroy) {
          // The invite is (again) valid — e.g. a member deleted it and the observer restored it.
          clearTimeout(pendingDestroy);
          inviteDestroyTimers.delete(inviteId);
        }

        if (lId && lPw && !inviteProviders.has(inviteId)) {
          openedHere.add(inviteId);
          const iDoc = new Y.Doc();
          inviteDocs.set(inviteId, iDoc);
          const iProvider = new WebrtcProvider(lId, iDoc, {
            password: lPw,
            signaling: signalingServer,
            peerOpts: webrtcPeerOpts(),
          });
          inviteProviders.set(inviteId, iProvider);
          inviteReannouncers.set(inviteId, announceIdentity(iProvider, lId, () => ({ encPublicKey: getIdentity()?.encPublicKey, isOwner: localIsOwner(), inviteId })));

          // 1-step invites: whenever a device shows up in this lobby, let the
          // invite layer decide whether it gets auto-approved (no-op for
          // regular invites). Dynamic import — invites.ts imports this module.
          const maybeAutoApprove = () => {
            import('./invites.ts')
              .then(({ autoApproveLobbyPeers }) => autoApproveLobbyPeers(dappId, inviteId))
              .catch(() => undefined);
          };
          iProvider.awareness.on('change', maybeAutoApprove);
          maybeAutoApprove();
        }
      });

      // Only THIS dapp's lobbies: the provider registry is global, and walking all of it
      // used to tear down the invite lobbies of every other open dapp.
      for (const inviteId of [...openedHere]) {
        if (!inviteProviders.has(inviteId)) {
          openedHere.delete(inviteId);
          continue;
        }
        if (!verified?.has(inviteId) && !inviteDestroyTimers.has(inviteId)) {
          // A single-use invite is burned in the same breath as the encrypted
          // credential grant is written into its lobby doc. Destroying the
          // provider in that same tick drops the grant before it reaches the
          // joiner — so let the room linger briefly, then tear it down.
          inviteDestroyTimers.set(inviteId, setTimeout(() => {
            inviteDestroyTimers.delete(inviteId);
            openedHere.delete(inviteId);
            const provider = inviteProviders.get(inviteId);
            if (!provider) return;
            try { provider.destroy(); } catch { /* already gone */ }
            inviteProviders.delete(inviteId);
            inviteDocs.delete(inviteId);
          }, INVITE_LOBBY_LINGER_MS));
        }
      }
    };
    
    if (!invitesObservedDocs.has(doc)) {
      // Verification lands a scan after the entry does — that is what (re)opens and closes lobbies.
      onVerifiedInvitesChange(dappId, syncInvites);
      // Keep the announced owner flag in step with promotions, demotions and a late-loading members map.
      membersMap.observeDeep(() => {
        // The flag is part of the SIGNED announce, so it is re-announced rather than patched in place.
        invitesMap.forEach((_invite, inviteId) => {
          if (inviteProviders.has(inviteId)) inviteReannouncers.get(inviteId)?.();
        });
      });
      invitesObservedDocs.add(doc);
    }
    syncInvites();
  }

  // 2. Member: attach the one-time doc observers and bring up the member mesh
  if (roomId && roomPassword) {
    requestMesh(dappId);
  }
  if (roomId && roomPassword && !observedDapps.has(dappId)) {
    observedDapps.add(dappId);

    // Auto-update local catalog when meta syncs (guarded — the doc-level observer must not stack)
    if (!metaObservedDocs.has(doc)) {
      metaObservedDocs.add(doc);
      const configMap = doc.getMap('config');
      configMap.observeDeep(() => {
        const meta = configMap.get('meta') as Y.Map<string> | undefined;
        const item = meta?.get('name') ? getCatalogItem(dappId) : null;
        if (!item || !meta) return;
        item.set('name', meta.get('name') || 'Unnamed Dapp');
        item.set('icon', meta.get('icon') || '📦');
        item.set('color', meta.get('color') || '#888888');
      });
    }

    setupAuthObserver(dappId);
    setupRekeyObserver(dappId);

    // Remember this device's VERIFIED role in the local-only catalog. The shell decides from it
    // which dapps to open at startup (only the ones this device owns — useRequestsInbox.ts)
    // without having to open a document first, and the direct-binding approval reads it too.
    // It is a cache for decisions about THIS device's own behaviour, never an authority:
    // everything that grants something asks the auth observer.
    onVerifiedMembersChange(dappId, () => {
      const self = getIdentity()?.publicKey;
      const role = self ? getVerifiedMembers(dappId)?.get(self)?.role : undefined;
      const item = getCatalogItem(dappId);
      if (item && typeof role === 'string' && item.get('role') !== role) item.set('role', role);
    });
  }

  return doc;
}

/** Return the main dapp document's local IndexedDB persistence provider. */
export function getDappPersistence(dappId: string): IndexeddbPersistence | null {
  getDappDoc(dappId);
  return dappPersistences.get(`dapp-${dappId}`) || null;
}

/**
 * A dapp created a moment before a hard reload could keep its catalog entry
 * (root doc, long open) and lose its document (a database still opening). The
 * creation paths call this before they report the dapp as created: it resolves
 * once the catalog, the dapp document and its source are stored. Never throws
 * and never waits forever — false means storage is not available right now,
 * which the shell already shows (storageHealth.ts); the dapp lives on in memory.
 */
export async function persistNewDapp(dappId: string): Promise<boolean> {
  const results = await Promise.all([
    flushLocalPersistence(rootPersistence),
    flushLocalPersistence(dappPersistences.get(`dapp-${dappId}`)),
    flushLocalPersistence(sourcePersistences.get(`dapp-${dappId}-source-v1`)),
  ]);
  return results.every(Boolean);
}

export function getInviteDoc(inviteId: string): Y.Doc | null {
  return inviteDocs.get(inviteId) || null;
}

export function getLobbyProvider(dappId: string): WebrtcProvider | null {
  return lobbyProviders.get(`dapp-${dappId}`) || null;
}


export function initDappDoc(
  dappId: string,
  name: string,
  icon: string,
  color: string,
  publicKey: string,
  encPublicKey?: string,
  /** The creating device's name — the founder's entry in the member list. */
  displayName?: string,
): void {
  const doc = getDappDoc(dappId);

  // Config
  const config = doc.getMap('config');
  if (!config.get('docVersion')) config.set('docVersion', CURRENT_DAPP_DOC_VERSION);
  if (!config.get('meta')) {
    const meta = new Y.Map<string>();
    meta.set('name', name);
    meta.set('icon', icon);
    meta.set('color', color);
    meta.set('createdAt', new Date().toISOString());
    meta.set('createdBy', publicKey);
    config.set('meta', meta);
  }
  if (!config.get('schema')) {
    const schema = new Y.Map();
    const entities = new Y.Map();
    schema.set('entities', entities);
    config.set('schema', schema);
  }
  if (!config.get('theme')) {
    const theme = new Y.Map<string>();
    theme.set('primary', '#f97316');
    theme.set('radius', '0.5rem');
    config.set('theme', theme);
  }

  // Members
  const members = doc.getMap('members');
  if (!members.get(publicKey)) {
    const member = new Y.Map<string>();
    member.set('name', displayName?.trim() || FOUNDER_PLACEHOLDER_NAME);
    member.set('role', 'owner');
    member.set('canEditConfig', 'true');
    member.set('canInvite', 'true');
    member.set('publicKey', publicKey);
    if (encPublicKey) member.set('encPublicKey', encPublicKey);
    members.set(publicKey, member);
  }
}
