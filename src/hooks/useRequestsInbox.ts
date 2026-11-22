import { useSyncExternalStore } from 'react';
import { getRootDoc, getDappsList, getDappDoc, inviteDocs, inviteProviders } from '@/services/store/docs.ts';
import { getRole } from '@/services/store/auth.ts';
import { listRelationships } from '@/services/store/relationships.ts';
import { getPerson } from '@/services/store/people.ts';
import { getIdentity } from '@/services/identity.ts';
import { deriveConnectionCode } from '@/services/connectionCode.ts';
import { lobbyAnnounceVerdict, onLobbyAnnounceVerdict } from '@/services/store/lobbyAnnounce.ts';
import { classifyLobbyPeer } from '@/services/store/lobbyPeers.ts';
import type { MemberRole } from '@/types.ts';

/**
 * One watcher, many readers. The shell badge, the Requests page and a dapp's
 * Share & invite page all need the same lists; mounting the watcher per hook
 * instance meant duplicate doc observers, awareness subscriptions and polls.
 * The watcher starts with the first subscriber and stops with the last, and
 * readers only re-render when the list actually changed.
 */
function createSharedEntries<T>(start: (publish: (entries: T[]) => void) => (() => void) | undefined) {
  const listeners = new Set<() => void>();
  let entries: T[] = [];
  let serialized = '[]';
  let stop: (() => void) | undefined;
  const publish = (next: T[]): void => {
    const nextSerialized = JSON.stringify(next);
    if (nextSerialized === serialized) return;
    serialized = nextSerialized;
    entries = next;
    listeners.forEach((listener) => listener());
  };
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) stop = start(publish);
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stop?.();
        stop = undefined;
        entries = [];
        serialized = '[]';
      };
    },
    getSnapshot: (): T[] => entries,
  };
}

/**
 * Live view of open relationship pairing requests across ALL of this device's
 * hosted invites — the shell's unified "Requests" inbox reads from here, so an
 * incoming request is visible from anywhere in the app instead of only inside
 * the invite dialog that happened to create it.
 */
interface PairingRequestEntry {
  relationshipId: string;
  inviteId: string;
  personName: string;
  requestId: string;
  requesterPublicKey: string;
  /**
   * The safety number this contact will have, derivable before anyone approves ('…' while it
   * is being derived). Both sides show the same one — comparing it here is what tells a real
   * contact from someone who got hold of the invite code.
   */
  safetyNumber: string;
  valid: boolean;
}

/** Shown until the derivation (one SHA-256) comes back. */
const SAFETY_NUMBER_PENDING = '… … … … … …';

type RelationshipRuntime = typeof import('@/services/browserRelationshipRuntime.ts');

function watchPairingRequests(setEntries: (entries: PairingRequestEntry[]) => void): (() => void) | undefined {
  // Environments without IndexedDB (isolated component tests) simply show
  // no pairing requests rather than crashing the shell.
  let rootDoc: ReturnType<typeof getRootDoc>;
  try {
    rootDoc = getRootDoc();
  } catch {
    return;
  }

  let disposed = false;
  let runtime: RelationshipRuntime | null = null;
  const inviteCleanups: Array<() => void> = [];
  const byInvite = new Map<string, PairingRequestEntry[]>();
  const safetyNumbers = new Map<string, string>();

  const publish = () => {
    if (disposed) return;
    const entries = [...byInvite.values()].flat();
    for (const entry of entries) {
      const key = `${entry.relationshipId}|${entry.requesterPublicKey}`;
      entry.safetyNumber = safetyNumbers.get(key) ?? SAFETY_NUMBER_PENDING;
      if (safetyNumbers.has(key) || !runtime) continue;
      safetyNumbers.set(key, SAFETY_NUMBER_PENDING); // reserve so we derive once
      void runtime.pendingPairingSafetyNumber(entry.relationshipId, entry.requesterPublicKey)
        .then((number) => {
          if (disposed || !number) return;
          safetyNumbers.set(key, number);
          publish();
        })
        .catch(() => undefined);
    }
    setEntries(entries);
  };

  const resubscribe = () => {
    if (disposed || !runtime) return;
    inviteCleanups.splice(0).forEach((dispose) => dispose());
    byInvite.clear();
    publish();
    for (const relationship of listRelationships(rootDoc)) {
      if (relationship.status !== 'pending') continue;
      try {
        if (runtime.getPendingPairingKind(relationship.id) !== 'hosted') continue;
        // Reopens the persisted lobby when needed, so requests stay
        // reachable even if no invite dialog was ever opened this session.
        const invite = runtime.getHostedPairingInvite(relationship.id);
        if (!invite || invite.expired) continue;
        const personName = getPerson(relationship.personId, rootDoc)?.displayName ?? 'Unknown person';
        const dispose = runtime.observeHostedPairingRequests(invite.inviteId, (requests) => {
          byInvite.set(invite.inviteId, requests.map(({ request, valid }) => ({
            relationshipId: relationship.id,
            inviteId: invite.inviteId,
            // The requester announces their own signed name; the local person
            // entry is only a placeholder until approval.
            personName: request.displayName?.trim() || personName,
            requestId: request.requestId,
            requesterPublicKey: request.requesterPublicKey,
            safetyNumber: SAFETY_NUMBER_PENDING,
            valid,
          })));
          publish();
        });
        inviteCleanups.push(dispose);
      } catch {
        // An invite whose lobby is not open (yet) contributes no requests.
      }
    }
  };

  const relationships = rootDoc.getMap('relationships');
  const hostedInvites = rootDoc.getMap('relationshipPairingHostedInvites');
  relationships.observeDeep(resubscribe);
  hostedInvites.observe(resubscribe);

  // The relationship runtime is deliberately code-split (see App.tsx); load
  // it the same lazy way so the shell bundle stays lean.
  void import('@/services/browserRelationshipRuntime.ts')
    .then((mod) => {
      if (disposed) return;
      runtime = mod;
      resubscribe();
    })
    .catch(() => undefined);

  return () => {
    disposed = true;
    relationships.unobserveDeep(resubscribe);
    hostedInvites.unobserve(resubscribe);
    inviteCleanups.splice(0).forEach((dispose) => dispose());
  };
}

const pairingRequestStore = createSharedEntries(watchPairingRequests);

/** Open contact (pairing) requests across all hosted invites. Every caller shares one set of observers. */
export function usePairingRequests(): PairingRequestEntry[] {
  return useSyncExternalStore(pairingRequestStore.subscribe, pairingRequestStore.getSnapshot);
}

/**
 * A device waiting in one of your dapps' invite lobbies — the same request
 * DappSettingsPage shows as "Devices Requesting Access", surfaced globally so
 * an owner sees it from anywhere in the shell, not only on that settings page.
 */
export interface DappAccessRequestEntry {
  dappId: string;
  dappName: string;
  dappIcon: string;
  inviteId: string;
  publicKey: string;
  displayName: string;
  encPublicKey?: string;
  /** Six-digit connection code to verify against the joiner's screen ('------' while deriving). */
  safetyNumber: string;
  /** Lobby room of the invite — part of what the connection code is derived from. */
  lobbyId: string;
  /** True when the invite is 1-step — an online owner admits this device automatically. */
  autoApprove: boolean;
  /**
   * True when this device already is a member and asks to be let back in (it
   * lost its copy). Approval re-sends the credentials to the key stored for
   * that member and leaves its role untouched; never automatic.
   */
  rejoin: boolean;
  /**
   * An owner already approved this device, which now shows its person "approved by X — code N"
   * and waits for their confirmation (services/store/pendingGrant.ts). The row stays, with
   * the code, until that device has joined — this is the moment the code is compared.
   */
  awaitingConfirmation: boolean;
  /** The role a rejoining member keeps. */
  currentRole?: MemberRole;
}

/**
 * Whether the shell opens this dapp in the background. Only an owner can approve a waiting
 * device, so only dapps this device owns are watched — opening EVERY catalog entry at startup
 * loaded each document and brought up each mesh whatever the person was looking at (and, with
 * several tabs and devices behind one address, filled the signaling proxy's connection limit).
 * A dapp this device does not own syncs when it is opened; an always-on keeper covers the gap.
 * The role comes from the catalog cache docs.ts keeps; an entry without one (created by an
 * earlier build) is opened once so the role gets recorded.
 */
export function watchedAtStartup(item: { get(key: string): string | undefined }): boolean {
  if (!item.get('id') || !item.get('roomId')) return false; // not joined/approved yet — nothing to host
  const role = item.get('role');
  return !role || role === 'owner';
}

function watchDappAccessRequests(setEntries: (entries: DappAccessRequestEntry[]) => void): (() => void) | undefined {
  const identity = getIdentity();
  if (!identity) return;
  try {
    getRootDoc();
  } catch {
    return; // no IndexedDB (isolated component tests) — show no requests
  }

  let disposed = false;
  const awarenessSubs = new Map<object, () => void>();
  const observedDappDocs = new Set<string>();
  const docCleanups: Array<() => void> = [];
  const safetyNumbers = new Map<string, string>();

  const collect = () => {
    if (disposed) return;
    const next: DappAccessRequestEntry[] = [];
    const list = getDappsList();
    for (let i = 0; i < list.length; i++) {
      const item = list.get(i);
      const dappId = item.get('id');
      if (!dappId || !watchedAtStartup(item)) continue;
      if (getRole(dappId, identity.publicKey) !== 'owner') continue;
      const doc = getDappDoc(dappId);
      const members = doc.getMap('members');
      const invitesMap = doc.getMap('invites');
      const dappName = (item.get('name') as string) || 'Unnamed app';
      const dappIcon = (item.get('icon') as string) || '📦';

      const pushPeer = (state: Record<string, unknown>, inviteId: string, lobbyId: string, autoApprove = false) => {
        // Listed only once the device proved the key it announces (lobbyAnnounce.ts); the
        // verdict arrives asynchronously and triggers another collect.
        if (lobbyAnnounceVerdict(lobbyId, state) !== true) return;
        const peer = classifyLobbyPeer(state, identity.publicKey, members);
        if (!peer) return;
        const { publicKey } = peer;
        if (next.some((entry) => entry.dappId === dappId && entry.publicKey === publicKey)) return;
        next.push({
          dappId,
          dappName,
          dappIcon,
          inviteId,
          publicKey,
          displayName: peer.displayName,
          encPublicKey: peer.encPublicKey,
          lobbyId,
          safetyNumber: safetyNumbers.get(`${lobbyId}|${publicKey}`) ?? '--------',
          // A member asking to be let back in is always a person's decision.
          autoApprove: autoApprove && !peer.rejoin,
          rejoin: peer.rejoin,
          awaitingConfirmation: inviteDocs.get(inviteId)?.getMap('grantedAccess').has(publicKey) ?? false,
          ...(peer.currentRole ? { currentRole: peer.currentRole } : {}),
        });
      };

      invitesMap.forEach((raw, inviteId) => {
        const invite = raw as { get(key: string): unknown };
        const autoApprove = invite.get('autoApprove') === 'true';
        const provider = inviteProviders.get(inviteId);
        const lobbyId = invite.get('lobbyId');
        if (typeof lobbyId !== 'string' || !lobbyId) return;
        provider?.awareness.getStates().forEach((state) => pushPeer(state, inviteId, lobbyId, autoApprove));
      });
    }

    for (const entry of next) {
      const codeKey = `${entry.lobbyId}|${entry.publicKey}`;
      if (!safetyNumbers.has(codeKey)) {
        safetyNumbers.set(codeKey, '--------'); // reserve so we derive once
        void deriveConnectionCode(identity.publicKey, entry.publicKey, entry.lobbyId)
          .then((code) => {
            if (disposed) return;
            safetyNumbers.set(codeKey, code);
            collect();
          })
          .catch(() => undefined);
      }
    }

    setEntries(next);
  };

  // Lobby/invite providers appear and vanish asynchronously (docs.ts creates
  // them when invite entries sync), so resync walks everything: it opens
  // owned dapp docs, attaches doc observers once, and (re)subscribes to
  // whatever awareness objects currently exist.
  const resync = () => {
    if (disposed) return;
    const list = getDappsList();
    const liveAwareness = new Set<object>();
    for (let i = 0; i < list.length; i++) {
      const item = list.get(i);
      const dappId = item.get('id');
      if (!dappId || !watchedAtStartup(item)) continue;
      const doc = getDappDoc(dappId);
      if (!observedDappDocs.has(dappId)) {
        observedDappDocs.add(dappId);
        const members = doc.getMap('members');
        const invitesMap = doc.getMap('invites');
        members.observeDeep(collect);
        invitesMap.observe(onInvitesChanged);
        docCleanups.push(() => {
          members.unobserveDeep(collect);
          invitesMap.unobserve(onInvitesChanged);
        });
      }
      doc.getMap('invites').forEach((_raw, inviteId) => {
        const provider = inviteProviders.get(inviteId);
        if (provider) liveAwareness.add(provider.awareness);
      });
    }

    for (const [awareness, unsub] of awarenessSubs) {
      if (!liveAwareness.has(awareness)) {
        unsub();
        awarenessSubs.delete(awareness);
      }
    }
    liveAwareness.forEach((awareness) => {
      if (awarenessSubs.has(awareness)) return;
      const target = awareness as { on(event: string, fn: () => void): void; off(event: string, fn: () => void): void };
      target.on('change', collect);
      awarenessSubs.set(awareness, () => target.off('change', collect));
    });

    collect();
  };

  // An invites change also triggers provider creation in docs.ts via its own
  // observer — re-run shortly after so the new provider gets subscribed.
  const onInvitesChanged = () => {
    resync();
    setTimeout(resync, 1_000);
  };

  const dappsList = getDappsList();
  dappsList.observeDeep(resync);
  resync();
  // Safety net for provider lifecycle edges (reconnects, rotation).
  const interval = setInterval(resync, 15_000);
  // Announce signatures verify asynchronously — list the device once its proof checked out.
  const stopVerdicts = onLobbyAnnounceVerdict(collect);

  return () => {
    disposed = true;
    stopVerdicts();
    clearInterval(interval);
    dappsList.unobserveDeep(resync);
    docCleanups.splice(0).forEach((dispose) => dispose());
    awarenessSubs.forEach((unsub) => unsub());
    awarenessSubs.clear();
  };
}

const accessRequestStore = createSharedEntries(watchDappAccessRequests);

/** Devices waiting in the invite lobbies of dapps this device owns. Every caller shares one set of observers and one poll. */
export function useDappAccessRequests(): DappAccessRequestEntry[] {
  return useSyncExternalStore(accessRequestStore.subscribe, accessRequestStore.getSnapshot);
}

/**
 * Requests a person has to act on — 1-step invites admit their devices without anyone
 * approving, and an approved device only waits for its own user (it stays listed, with its
 * code, but needs nothing from the owner any more).
 */
export function approvableAccessRequests(entries: DappAccessRequestEntry[]): DappAccessRequestEntry[] {
  return entries.filter((entry) => !entry.autoApprove && !entry.awaitingConfirmation);
}

/** Number of devices waiting for a decision, per dapp id. */
export function countAccessRequestsByDapp(entries: DappAccessRequestEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of approvableAccessRequests(entries)) counts[entry.dappId] = (counts[entry.dappId] ?? 0) + 1;
  return counts;
}
