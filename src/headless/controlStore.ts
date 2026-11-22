import type * as Y from 'yjs';
import { getDappDoc, getDappsList, getDappCredentials, getDappLobbyId, getLobbyProvider, inviteProviders } from '../services/store/docs.ts';
import { createDapp, syncManifestEntities, syncManifestMeta } from '../services/store/config.ts';
import { getCodeAppFiles, replaceCodeAppFiles } from '../services/store/source.ts';
import { createInvite, approveLobbyDevice, inviteLobbyId } from '../services/store/invites.ts';
import { getRole, getVerifiedMembers, getVerifiedRecordsSnapshot, onVerifiedRecordsChange, type VerifiedRecordsChange } from '../services/store/auth.ts';
import { addRecord, getEntityRecords, updateRecord } from '../services/store/data.ts';
import { deriveConnectionCode } from '../services/connectionCode.ts';
import { verifiedLobbyStates } from '../services/store/lobbyAnnounce.ts';
import { deriveLobbyOwnerCodes } from '../services/lobbyOwners.ts';
import { classifyLobbyPeer } from '../services/store/lobbyPeers.ts';
import type { MemberRole, RecordData } from '../types.ts';

/**
 * The store-facing seam of the control dapp (controlDapp.ts): every Yjs /
 * invite / membership operation the keeper needs, behind one small interface
 * so the command logic can be tested against a fake. Nothing here bypasses
 * the store's own gates — `createInvite`, `approveLobbyDevice`, `addRecord`
 * etc. still enforce roles and signing exactly as in the browser.
 */

export interface OperatorDevice {
  publicKey: string;
  name: string;
}

export interface LobbyPeer {
  publicKey: string;
  displayName: string;
  encPublicKey?: string;
  inviteId: string;
  /** Already a member that lost its copy and asks to be let back in — approval only re-sends credentials, the role stays. */
  rejoin: boolean;
  /** 6-digit code derived from the keeper's and the peer's keys — what the joining device shows. */
  safetyNumber: string;
}

/** What the keeper sees while it waits in another dapp's lobby: the code ONE owner device must show (codes are per owner device). */
export interface PendingApproval {
  safetyNumber: string;
  ownerDisplayName: string;
}

export interface ControlStore {
  /** Create the control dapp with the keeper as founding owner and install the given source files. */
  createControlDapp(name: string, icon: string, color: string, files: Record<string, string>): string;
  hasDapp(dappId: string): boolean;
  /** Current source file map of a dapp (empty until the source doc is loaded). */
  sourceFiles(dappId: string): Record<string, string>;
  /** Replace the whole source file map (owner only, validated like any Code App). */
  replaceSource(dappId: string, files: Record<string, string>): void;
  /**
   * Replace a dapp's source *and* re-seed schema + display identity from the
   * new manifest — what the browser editor does on save. For AI edits.
   */
  replaceSourceAndManifest(dappId: string, files: Record<string, string>): void;
  /** Create a dapp owned by the keeper from a generated file map. */
  createDappFromFiles(name: string, icon: string, color: string, files: Record<string, string>): string;
  /** Display identity of a dapp from its doc meta. */
  dappIdentity(dappId: string): { name: string; icon: string; color: string };
  roleOf(dappId: string, publicKey: string): MemberRole | null;
  /** Owner members of a dapp other than the keeper itself. */
  owners(dappId: string, selfKey: string): OperatorDevice[];
  isMember(dappId: string, publicKey: string): boolean;
  /** Dapps the keeper owns and has credentials for. */
  ownedDappIds(selfKey: string): string[];
  createInvite(dappId: string, uses: number): Promise<string>;
  lobbyPeers(dappId: string, selfKey: string): Promise<LobbyPeer[]>;
  /** For a dapp the keeper joined but is not yet approved in: one code per owner device in the lobby, to compare on the approving owner's screen (empty while no owner is there). */
  pendingApprovals(dappId: string, selfKey: string): Promise<PendingApproval[]>;
  approve(dappId: string, peer: LobbyPeer, role: MemberRole): Promise<void>;
  records(dappId: string, collection: string): RecordData[];
  createRecord(dappId: string, collection: string, data: Record<string, unknown>): Promise<void>;
  updateRecord(dappId: string, collection: string, recordId: string, data: Record<string, unknown>): Promise<void>;
  subscribe(dappId: string, listener: (change: VerifiedRecordsChange) => void): () => void;
  /** The auth observer's accepted records as of its last scan (empty before the first one). */
  verifiedRecords(dappId: string): VerifiedRecordsChange['upserts'];
}

async function safetyNumberFor(selfKey: string, peerKey: string, lobbyId: string): Promise<string> {
  try {
    return await deriveConnectionCode(selfKey, peerKey, lobbyId); // cached per device pair and lobby
  } catch {
    return '------';
  }
}

export const liveControlStore: ControlStore = {
  createControlDapp(name, icon, color, files) {
    const id = createDapp(name, icon, color);
    replaceCodeAppFiles(id, files);
    return id;
  },

  hasDapp(dappId) {
    const list = getDappsList();
    for (let i = 0; i < list.length; i++) {
      if (list.get(i).get('id') === dappId) return true;
    }
    return false;
  },

  sourceFiles(dappId) {
    return getCodeAppFiles(dappId);
  },

  replaceSource(dappId, files) {
    replaceCodeAppFiles(dappId, files);
  },

  replaceSourceAndManifest(dappId, files) {
    replaceCodeAppFiles(dappId, files);
    syncManifestEntities(dappId);
    syncManifestMeta(dappId);
  },

  createDappFromFiles(name, icon, color, files) {
    const id = createDapp(name, icon, color);
    replaceCodeAppFiles(id, files);
    syncManifestEntities(id);
    syncManifestMeta(id);
    return id;
  },

  dappIdentity(dappId) {
    const meta = getDappDoc(dappId).getMap('config').get('meta') as Y.Map<unknown> | undefined;
    const text = (key: string, fallback: string): string => {
      const value = meta?.get(key);
      return typeof value === 'string' && value ? value : fallback;
    };
    return { name: text('name', 'Unnamed Dapp'), icon: text('icon', '📦'), color: text('color', '#0ea5e9') };
  },

  roleOf(dappId, publicKey) {
    return getRole(dappId, publicKey);
  },

  // Operators run commands, get auto-owner in the keeper's dapps and their approvals let
  // the keeper join without a confirmation — so they come from the members the auth observer
  // VERIFIED, never from the live map, where a forged `role: 'owner'` sits until the next
  // scan reverts it. No verified set yet (doc still loading) = no operators yet.
  owners(dappId, selfKey) {
    const result: OperatorDevice[] = [];
    getVerifiedMembers(dappId)?.forEach((member, publicKey) => {
      if (publicKey === selfKey || member.role !== 'owner') return;
      result.push({ publicKey, name: typeof member.name === 'string' && member.name ? member.name : 'Unknown device' });
    });
    return result;
  },

  isMember(dappId, publicKey) {
    return getVerifiedMembers(dappId)?.has(publicKey) ?? false;
  },

  ownedDappIds(selfKey) {
    const list = getDappsList();
    const ids: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const id = list.get(i).get('id');
      if (!id || !getDappCredentials(id).roomId) continue;
      if (getRole(id, selfKey) === 'owner') ids.push(id);
    }
    return ids;
  },

  createInvite(dappId, uses) {
    return createInvite(dappId, uses);
  },

  async lobbyPeers(dappId, selfKey) {
    const doc = getDappDoc(dappId);
    const members = doc.getMap('members');
    const peers: LobbyPeer[] = [];
    const seen = new Set<string>();
    const invites = doc.getMap('invites');
    for (const inviteId of invites.keys()) {
      const provider = inviteProviders.get(inviteId);
      const lobbyId = inviteLobbyId(dappId, inviteId);
      if (!provider || !lobbyId) continue;
      // Signed announces only: the operator auto-admission downstream trusts `publicKey`.
      for (const state of await verifiedLobbyStates(lobbyId, provider.awareness.getStates().values())) {
        const peer = classifyLobbyPeer(state, selfKey, members);
        if (!peer || seen.has(peer.publicKey)) continue;
        seen.add(peer.publicKey);
        peers.push({
          publicKey: peer.publicKey,
          displayName: peer.displayName,
          ...(peer.encPublicKey ? { encPublicKey: peer.encPublicKey } : {}),
          inviteId,
          rejoin: peer.rejoin,
          safetyNumber: await safetyNumberFor(selfKey, peer.publicKey, lobbyId),
        });
      }
    }
    return peers;
  },

  approve(dappId, peer, role) {
    return approveLobbyDevice(dappId, peer, role);
  },

  async pendingApprovals(dappId, selfKey) {
    const provider = getLobbyProvider(dappId);
    if (!provider) return [];
    const owners = await deriveLobbyOwnerCodes(provider.awareness.getStates().values(), selfKey, getDappLobbyId(dappId));
    return owners.map((owner) => ({ safetyNumber: owner.safetyNumber, ownerDisplayName: owner.displayName }));
  },

  records(dappId, collection) {
    return getEntityRecords(dappId, collection) ?? [];
  },

  createRecord(dappId, collection, data) {
    return addRecord(dappId, collection, data);
  },

  updateRecord(dappId, collection, recordId, data) {
    return updateRecord(dappId, collection, recordId, data);
  },

  subscribe(dappId, listener) {
    return onVerifiedRecordsChange(dappId, listener);
  },

  verifiedRecords(dappId) {
    const snapshot = getVerifiedRecordsSnapshot(dappId);
    if (!snapshot) return [];
    return [...snapshot].map(([key, record]) => ({ entityId: key.slice(0, Math.max(0, key.indexOf(':'))), record }));
  },
};
