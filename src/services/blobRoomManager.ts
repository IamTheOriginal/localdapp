import SimplePeer from 'simple-peer/simplepeer.min.js';
import type { BlobDescriptor } from '../types.ts';
import { blobDescriptorOf, getBlobStore } from './blobStore.ts';
import { BLOB_PROTOCOL_VERSION, BlobPeerSession, type BlobTransport } from './blobProtocol.ts';
import { reportMeshVersionMismatch } from './meshCompat.ts';
import { signalingEndpoints, subscribeSignalingEndpoints, webrtcPeerOpts } from './signalingConfig.ts';
import { getSigningIdentity } from './identity.ts';
import {
  getDappDoc, getDappSourceDoc, getDappCredentials, getDappBlobReplication, getDappPersistence, getDappSourcePersistence,
  isTrustedBlobPeer, registerProviderReconnectListener,
} from './store/docs.ts';
import { listFileRecords } from './store/files.ts';
import { onVerifiedMembersChange } from './store/auth.ts';
import { publishMeshPeerKeys } from './meshPresence.ts';
import { whenLocalCopyLoaded } from './store/storageHealth.ts';
import { bufferToHex, hexToBuffer } from '../lib/hex.ts';
import * as Y from 'yjs';

/**
 * The dapp's member mesh: a dedicated simple-peer mesh per dapp, discovered
 * through the signaling broker in a room derived from the dapp's credentials
 * (`blob-v1-…`, the name predates live sync), with signaling payloads
 * AES-GCM-encrypted under a key derived from the room password. Data channels
 * are wrapped into `BlobPeerSession`s, which enforce the membership handshake.
 *
 * All channels of a device share ONE broker socket PER SIGNALING ENDPOINT
 * (see "Broker links" below).
 *
 * It is the ONLY transport for a dapp's main and source documents and for file
 * content. The handshake is the peer whitelist: a remote device must prove an
 * Ed25519 key that the signed members map lists (or, before the first sync,
 * the key of the owner that granted access) before a single document byte is
 * sent to it or accepted from it. Holding the room password is not enough —
 * a removed member can still reach the broker room, but every session with it
 * is refused, and open sessions are dropped the moment its removal syncs.
 *
 * Live sync: local document updates are pushed to every ready session as they
 * happen and relayed onward (duplicates are no-ops in Yjs, so relaying ends by
 * itself and covers partial meshes). On connect both sides pull the diff
 * against their own state vector, which also covers everything missed offline.
 *
 * Credential rotation: derived credentials change with the main room's, and
 * `reconnectDappProviders` notifies this manager (lazy listener registration)
 * so the channel reconnects under the new topic.
 */

function deriveBlobCredentials(roomId: string, roomPassword: string): { topic: string; password: string } {
  return { topic: `blob-v1-${roomId}`, password: `blob-v1:${roomPassword}` };
}

/** Document kinds carried by the mesh. */
const DOC_KINDS = ['main', 'source'] as const;
type DocKind = typeof DOC_KINDS[number];

function docFor(dappId: string, kind: string): Y.Doc | null {
  return kind === 'main' ? getDappDoc(dappId) : kind === 'source' ? getDappSourceDoc(dappId) : null;
}

/** Transaction origin of every update that arrived over the mesh (`session` = the verified sender). */
export class MeshOrigin {
  readonly session: BlobPeerSession;
  constructor(session: BlobPeerSession) { this.session = session; }
}

interface DocTraffic { sent: number; received: number; lastSentAt: number | null; lastReceivedAt: number | null }

const ANNOUNCE_INTERVAL_MS = 30_000;
/** A device that proved an untrusted key is not dialed again for this long (cleared when the members map changes). */
const REJECTED_COOLDOWN_MS = 120_000;
// Connection budget per dapp channel. Announces are only protected by the room password,
// which a removed member still holds: with a fresh client id per message it could make this
// device open peer connections until the browser's limit starves every other dapp. Unproven
// connections are therefore few, and new ones are paced.
const MAX_PEERS_PER_CHANNEL = 32;
const MAX_UNPROVEN_PEERS = 8;
const PEER_CREATION_WINDOW_MS = 10_000;
const MAX_PEER_CREATIONS_PER_WINDOW = 12;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;
const SESSION_WAIT_MS = 8000;
/**
 * Envelope ids remembered per channel to drop the copies that arrive over the
 * other brokers. Insertion-ordered, so the oldest fall out first; a handful of
 * brokers means a duplicate follows its original within a few messages.
 */
const MAX_SEEN_MESSAGES = 512;

async function deriveSignalingKey(password: string, topic: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode(topic), iterations: 100_000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptEnvelope(key: CryptoKey, payload: Record<string, unknown>): Promise<{ iv: string; data: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv: bufferToHex(iv.buffer), data: bufferToHex(data) };
}

async function decryptEnvelope(key: CryptoKey, envelope: { iv?: unknown; data?: unknown }): Promise<Record<string, unknown> | null> {
  if (typeof envelope.iv !== 'string' || typeof envelope.data !== 'string') return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(hexToBuffer(envelope.iv)) },
      key,
      hexToBuffer(envelope.data),
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plain));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

class PeerTransport implements BlobTransport {
  private frameCallback: ((frame: Uint8Array) => void) | null = null;
  private closeCallback: (() => void) | null = null;
  private readonly peer: SimplePeer;

  constructor(peer: SimplePeer) {
    this.peer = peer;
    peer.on('data', (data) => this.frameCallback?.(data instanceof Uint8Array ? data : new Uint8Array(data)));
    peer.on('close', () => this.closeCallback?.());
    peer.on('error', () => this.closeCallback?.());
  }

  send(frame: Uint8Array): void {
    try {
      if (!this.peer.destroyed) this.peer.send(frame);
    } catch {
      // Destroy the connection, not only the session: a peer left in the channel's map
      // without a session blocked redialling that device until the liveness sweep.
      this.closeCallback?.();
      this.close();
    }
  }

  onFrame(callback: (frame: Uint8Array) => void): void { this.frameCallback = callback; }
  onClose(callback: () => void): void { this.closeCallback = callback; }
  bufferedAmount(): number { return this.peer._channel?.bufferedAmount ?? 0; }
  close(): void {
    try {
      this.peer.destroy();
    } catch {
      // already gone
    }
  }
}

interface BlobChannel {
  dappId: string;
  topic: string;
  clientId: string;
  key: CryptoKey;
  peers: Map<string, SimplePeer>;
  sessions: Map<string, BlobPeerSession>;
  peerCreatedAt: Map<string, number>;
  /** Timestamps of recent peer creations (pacing, see MAX_PEER_CREATIONS_PER_WINDOW). */
  peerCreations: number[];
  /** Broker client id → when its proven key was refused as not whitelisted. */
  rejectedAt: Map<string, number>;
  /** Ids of envelopes already handled: the same one arrives once per broker (see MAX_SEEN_MESSAGES). */
  seenMessages: Set<string>;
  docTraffic: Record<DocKind, DocTraffic>;
  /** Doc kind → pulls of that kind in flight, over all sessions. */
  pullsInFlight: Map<string, number>;
  /** Doc kind → sessions whose poke arrived during such a pull, oldest first (see onDocPoke). */
  pendingPokes: Map<string, BlobPeerSession[]>;
  /** Undo functions for the doc listeners this channel attached. */
  detachDocs: Array<() => void>;
  announceTimer: ReturnType<typeof setInterval> | null;
  /** Sweeps since the last periodic catch-up pull (see CATCH_UP_EVERY_SWEEPS). */
  sweepsSinceCatchUp: number;
  destroyed: boolean;
}

const channels = new Map<string, BlobChannel>();
/** Bumped by every destroy, so a channel creation that was waiting meanwhile notices and gives up. */
const channelGenerations = new Map<string, number>();
let reconnectListenerRegistered = false;

function sessionHost(channel: BlobChannel) {
  const dappId = channel.dappId;
  return {
    getSigningIdentity,
    isMember: (publicKey: string) => isTrustedBlobPeer(dappId, publicKey),
    getDescriptor: (sha256: string): BlobDescriptor | null => {
      const record = listFileRecords(dappId).find((row) => row.sha256 === sha256);
      return record ? blobDescriptorOf(record) : null;
    },
    listAvailable: async (): Promise<string[]> => {
      const store = getBlobStore();
      const available: string[] = [];
      for (const record of listFileRecords(dappId)) {
        if (await store.hasBlob(record.sha256)) available.push(record.sha256);
      }
      return [...new Set(available)];
    },
    store: getBlobStore(),
    encodeDocState: (kind: string, vector: Uint8Array | null): Uint8Array | null => {
      const doc = docFor(dappId, kind);
      if (!doc) return null;
      if (vector) {
        try {
          return Y.encodeStateAsUpdate(doc, vector);
        } catch {
          // Malformed requester vector — fall through to the full state.
        }
      }
      return Y.encodeStateAsUpdate(doc);
    },
    applyDocState: (kind: string, update: Uint8Array, from: BlobPeerSession): void => {
      const doc = docFor(dappId, kind);
      if (!doc) throw new Error('doc sync: unknown doc kind');
      // The doc's update listener (attachDocs) counts it and relays it onward.
      Y.applyUpdate(doc, update, new MeshOrigin(from));
    },
    onVersionMismatch: (remoteVersion: number, claimedKey: string | null): void => {
      // Only a key that is a member here counts: the version is not proven, and
      // non-members should not be able to raise an "update" hint.
      if (claimedKey && isTrustedBlobPeer(dappId, claimedKey)) reportMeshVersionMismatch(dappId, remoteVersion, BLOB_PROTOCOL_VERSION);
    },
    onDocPoke: (kind: string, from: BlobPeerSession): void => {
      if (!docFor(dappId, kind)) return;
      // Merge pokes: after one large update the author and every relayer poke,
      // and each pull would fetch the same diff again. While a pull of this
      // kind is in flight (from any session), only note who poked; one
      // follow-up pull runs when it finished (finishPull) — needed because the
      // running pull's state vector may predate what this poke announces.
      if ((channel.pullsInFlight.get(kind) ?? 0) > 0) {
        const pokers = channel.pendingPokes.get(kind) ?? [];
        channel.pendingPokes.set(kind, [...pokers.filter((session) => session !== from), from]);
        return;
      }
      void pullFromSession(channel, from, [kind]);
    },
  };
}

/** Pull what this device is missing from one ready session (diff against our state vector). */
async function pullFromSession(channel: BlobChannel, session: BlobPeerSession, kinds: readonly string[] = DOC_KINDS): Promise<void> {
  // Counted from here on, so a poke that arrives while this pull still waits
  // for local storage is merged as well.
  const unfinished = new Set(kinds);
  unfinished.forEach((kind) => channel.pullsInFlight.set(kind, (channel.pullsInFlight.get(kind) ?? 0) + 1));
  try {
    // The state vector must describe what is stored, not a half-loaded doc —
    // otherwise the peer resends everything IndexedDB is about to restore anyway.
    await Promise.all([
      whenLocalCopyLoaded(getDappPersistence(channel.dappId)),
      whenLocalCopyLoaded(getDappSourcePersistence(channel.dappId)),
    ]);
    for (const kind of [...unfinished]) {
      if (channel.destroyed || session.state !== 'ready') return;
      const doc = docFor(channel.dappId, kind);
      if (doc) await session.requestDocSync(kind, () => Y.encodeStateVector(doc));
      unfinished.delete(kind);
      finishPull(channel, kind);
    }
  } finally {
    unfinished.forEach((kind) => finishPull(channel, kind));
  }
}

/** One pull of `kind` ended; when it was the last one in flight, run the single follow-up pull that merged pokes asked for. */
function finishPull(channel: BlobChannel, kind: string): void {
  const stillInFlight = (channel.pullsInFlight.get(kind) ?? 1) - 1;
  if (stillInFlight > 0) {
    channel.pullsInFlight.set(kind, stillInFlight);
    return;
  }
  channel.pullsInFlight.delete(kind);
  const pokers = channel.pendingPokes.get(kind);
  channel.pendingPokes.delete(kind);
  if (!pokers || channel.destroyed) return;
  // The latest poker that is still connected; any of them holds what was announced or a superset.
  const session = [...pokers].reverse().find((candidate) => candidate.state === 'ready');
  if (session) void pullFromSession(channel, session, [kind]);
}

function publishPresence(channel: BlobChannel): void {
  if (channels.get(channel.dappId) !== channel) return; // a replaced channel must not overwrite its successor
  const keys: string[] = [];
  if (!channel.destroyed) {
    for (const session of channel.sessions.values()) {
      if (session.state === 'ready' && session.remotePublicKey) keys.push(session.remotePublicKey);
    }
  }
  publishMeshPeerKeys(channel.dappId, keys);
}

/**
 * Wire the dapp's documents to the channel: push local and relayed updates to
 * every ready session, and re-check the whitelist whenever membership changes.
 */
function attachDocs(channel: BlobChannel): void {
  const { dappId } = channel;
  for (const kind of DOC_KINDS) {
    const doc = docFor(dappId, kind);
    if (!doc) continue;
    const persistence: unknown = kind === 'main' ? getDappPersistence(dappId) : getDappSourcePersistence(dappId);
    const onUpdate = (update: Uint8Array, origin: unknown): void => {
      if (channel.destroyed) return;
      if (persistence && origin === persistence) return; // local storage restore — peers pull what they miss on connect
      const traffic = channel.docTraffic[kind];
      const sender = origin instanceof MeshOrigin ? origin.session : null;
      if (sender) {
        traffic.received += 1;
        traffic.lastReceivedAt = Date.now();
      } else {
        traffic.sent += 1;
        traffic.lastSentAt = Date.now();
      }
      // Relayed to every other session, including those that already have it
      // from the author (a duplicate is a Yjs no-op, which ends the relay).
      // Suppressing that would need to know which peers are connected to each
      // other — knowledge about the remote topology that does not exist here.
      for (const session of channel.sessions.values()) {
        if (session !== sender) session.sendDocUpdate(kind, update);
      }
    };
    doc.on('update', onUpdate);
    channel.detachDocs.push(() => doc.off('update', onUpdate));
  }

  const members = getDappDoc(dappId).getMap('members');
  const onMembersChanged = (): void => {
    if (channel.destroyed) return;
    for (const [remoteId, session] of [...channel.sessions]) {
      if (session.remotePublicKey && !isTrustedBlobPeer(dappId, session.remotePublicKey)) dropPeer(channel, remoteId);
    }
    // Devices refused a moment ago may be members now (a fresh joiner's first
    // sync, a new approval) — forget the refusals and invite a reconnect.
    channel.rejectedAt.clear();
    announce(channel);
  };
  members.observe(onMembersChanged);
  channel.detachDocs.push(() => members.unobserve(onMembersChanged));
  // The whitelist is the VERIFIED member set, which trails the map by one auth scan: a
  // device approved a moment ago dials right away and is refused until then. Without this
  // second trigger that refusal stood for the whole cooldown — a fresh joiner stayed on
  // "Syncing…" for two minutes.
  channel.detachDocs.push(onVerifiedMembersChange(dappId, onMembersChanged));
}

/**
 * Publish one envelope on every broker this device holds (or on `links` only,
 * e.g. the one that just came up). Each message carries a fresh id INSIDE the
 * encrypted envelope: the receiver gets one copy per shared broker and drops
 * the repeats (`alreadySeen`) — feeding the same SDP to simple-peer twice
 * breaks the connection that was just being set up.
 */
function publish(channel: BlobChannel, payload: Record<string, unknown>, links: BrokerLink[] = openLinks()): void {
  if (links.length === 0) return;
  void encryptEnvelope(channel.key, { ...payload, id: crypto.randomUUID() }).then((envelope) => {
    if (!channel.destroyed) brokerSend({ type: 'publish', topic: channel.topic, envelope }, links);
  });
}

function announce(channel: BlobChannel, links?: BrokerLink[]): void {
  publish(channel, { kind: 'announce', from: channel.clientId }, links);
}

/** True when this envelope was already handled — it came in over another broker. */
function alreadySeen(channel: BlobChannel, id: unknown): boolean {
  // No id: a device on an older build, which publishes on one broker only.
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return false;
  if (channel.seenMessages.has(id)) return true;
  channel.seenMessages.add(id);
  while (channel.seenMessages.size > MAX_SEEN_MESSAGES) {
    const oldest = channel.seenMessages.values().next().value;
    if (oldest === undefined) break;
    channel.seenMessages.delete(oldest);
  }
  return false;
}

function dropPeer(channel: BlobChannel, remoteId: string): void {
  const session = channel.sessions.get(remoteId);
  if (session?.rejectedUntrusted) channel.rejectedAt.set(remoteId, Date.now());
  session?.close();
  channel.sessions.delete(remoteId);
  channel.peerCreatedAt.delete(remoteId);
  const peer = channel.peers.get(remoteId);
  channel.peers.delete(remoteId);
  if (peer && !peer.destroyed) {
    try {
      peer.destroy();
    } catch {
      // already gone
    }
  }
  publishPresence(channel);
}

/** Whether the channel's connection budget allows one more (still unproven) peer right now. */
function mayCreatePeer(channel: BlobChannel): boolean {
  if (channel.peers.size >= MAX_PEERS_PER_CHANNEL) return false;
  let unproven = 0;
  for (const remoteId of channel.peers.keys()) {
    if (channel.sessions.get(remoteId)?.remotePublicKey == null) unproven += 1;
  }
  if (unproven >= MAX_UNPROVEN_PEERS) return false;
  const now = Date.now();
  while (channel.peerCreations.length > 0 && now - channel.peerCreations[0] > PEER_CREATION_WINDOW_MS) channel.peerCreations.shift();
  if (channel.peerCreations.length >= MAX_PEER_CREATIONS_PER_WINDOW) return false;
  channel.peerCreations.push(now);
  return true;
}

function createPeer(channel: BlobChannel, remoteId: string, initiator: boolean): SimplePeer | null {
  if (!mayCreatePeer(channel)) return null; // the device announces again within 30 s
  const peer = new SimplePeer({ initiator, trickle: true, ...(webrtcPeerOpts() ?? {}) });
  channel.peers.set(remoteId, peer);
  channel.peerCreatedAt.set(remoteId, Date.now());
  peer.on('signal', (data) => publish(channel, { kind: 'signal', from: channel.clientId, to: remoteId, data }));
  peer.on('connect', () => {
    if (channel.destroyed) return;
    const session = new BlobPeerSession(new PeerTransport(peer), sessionHost(channel));
    channel.sessions.set(remoteId, session);
    void session.whenReady().then((ready) => {
      if (!ready || channel.destroyed) return;
      publishPresence(channel);
      void pullFromSession(channel, session);
    });
  });
  peer.on('close', () => dropPeer(channel, remoteId));
  peer.on('error', () => dropPeer(channel, remoteId));
  return peer;
}

function handleEnvelope(channel: BlobChannel, message: Record<string, unknown>): void {
  const from = message.from;
  if (typeof from !== 'string' || from === channel.clientId) return;
  if (alreadySeen(channel, message.id)) return;
  const rejectedAt = channel.rejectedAt.get(from);
  if (rejectedAt !== undefined) {
    if (Date.now() - rejectedAt < REJECTED_COOLDOWN_MS) return; // proved a key that is not whitelisted — do not redial yet
    channel.rejectedAt.delete(from);
  }

  if (message.kind === 'announce') {
    const known = channel.peers.has(from);
    if (!known) {
      // Deterministic glare avoidance: the lexicographically smaller client id
      // initiates; the other side answers on the first inbound signal.
      // The reply is what makes the OTHER side dial when it holds the smaller id — it must
      // not be throttled (three devices coming online together would miss each other until
      // the next periodic announce). When this side dials, the offer itself is the answer.
      if (channel.clientId < from) createPeer(channel, from, true);
      else announce(channel);
    }
    return;
  }

  if (message.kind === 'signal' && message.to === channel.clientId) {
    const peer = channel.peers.get(from) ?? createPeer(channel, from, false);
    if (!peer) return; // over budget
    try {
      peer.signal(message.data);
    } catch {
      dropPeer(channel, from);
    }
  }
}

// ───── Broker links ─────
//
// ONE signaling socket per ENDPOINT, shared by every dapp channel: each channel
// is just a topic subscription on each socket (the broker speaks the y-webrtc
// protocol — subscribe / unsubscribe / publish, publishes are echoed to every
// subscriber of the topic, the sender included). A socket per dapp multiplied
// quickly — dapps × tabs × devices behind one public IP — and ran into the
// broker's per-IP connection limit, leaving whichever channel came last
// without peers.
//
// Every configured endpoint is held AT THE SAME TIME, not one after the other.
// A broker only relays between its own subscribers, so a device that moved to
// the next URL after a drop stopped meeting everyone still on the first one and
// never found them again (review item 2.2). Announces and signals therefore go
// out on every open link, and the copies that come back over the other brokers
// are dropped by envelope id (`alreadySeen`), so a peer is dialed exactly once
// whichever broker introduced it.
//
// Not here, on purpose: which brokers a DAPP uses. The list is per device
// (build default, or Settings → Signaling); carrying it in invite links, in the
// dapp document and moving a dapp between brokers are later steps of the broker
// feature in TODO.md. They plug in where `signalingEndpoints()` is read.

interface BrokerLink {
  /** Broker URL this link dials — also its key in `brokerLinks`. */
  url: string;
  ws: WebSocket | null;
  retries: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** When this broker last sent anything (a pong, an envelope, the echo of an own announce). */
  lastMessageAt: number;
  /** When the current socket opened, 0 while it is down — see BROKER_STABLE_MS. */
  openedAt: number;
}

/** Endpoint URL → its socket. Rebuilt from `signalingEndpoints()` whenever the setting changes. */
const brokerLinks = new Map<string, BrokerLink>();
let brokerWatchdog: ReturnType<typeof setInterval> | null = null;

/** How often an open socket is probed, and how long it may stay silent before it counts as dead. */
const BROKER_PING_MS = 30_000;
const BROKER_SILENCE_MS = 75_000;
/**
 * A socket must have stood this long before its endpoint's backoff is
 * forgotten. A broker that accepts a connection and drops it right away would
 * otherwise be redialed every two seconds for ever.
 */
const BROKER_STABLE_MS = 60_000;

function liveChannels(): BlobChannel[] {
  return [...channels.values()].filter((channel) => !channel.destroyed);
}

function linkIsOpen(link: BrokerLink): boolean {
  return link.ws !== null && link.ws.readyState === WebSocket.OPEN;
}

function openLinks(): BrokerLink[] {
  return [...brokerLinks.values()].filter(linkIsOpen);
}

/** At least one broker is reachable — the mesh needs no more than that. */
function brokerIsOpen(): boolean {
  return [...brokerLinks.values()].some(linkIsOpen);
}

function brokerSend(message: Record<string, unknown>, links: BrokerLink[] = openLinks()): void {
  if (links.length === 0) return;
  const raw = JSON.stringify(message);
  for (const link of links) {
    if (!linkIsOpen(link)) continue;
    try {
      link.ws?.send(raw);
    } catch {
      // the close handler takes it from here
    }
  }
}

/** Reconcile the held links with the configured endpoints (the device setting can change while running). */
function syncBrokerLinks(): void {
  const wanted = signalingEndpoints();
  for (const [url, link] of [...brokerLinks]) {
    if (wanted.includes(url)) continue;
    closeLink(link); // no longer configured — peers found through it keep their direct connection
    brokerLinks.delete(url);
  }
  for (const url of wanted) {
    if (!brokerLinks.has(url)) {
      brokerLinks.set(url, { url, ws: null, retries: 0, reconnectTimer: null, lastMessageAt: 0, openedAt: 0 });
    }
  }
}

function closeLink(link: BrokerLink): void {
  if (link.reconnectTimer) {
    clearTimeout(link.reconnectTimer);
    link.reconnectTimer = null;
  }
  const ws = link.ws;
  link.ws = null;
  link.openedAt = 0;
  link.retries = 0;
  try {
    ws?.close();
  } catch {
    // already closed
  }
}

/**
 * Drop one endpoint's socket and dial it again at once. A half-open socket (the network path
 * died while the device slept, no FIN ever arrived) still reports OPEN and never fires `close`.
 */
function replaceLinkSocket(link: BrokerLink): void {
  const ws = link.ws;
  link.ws = null;
  link.openedAt = 0;
  if (link.reconnectTimer) {
    clearTimeout(link.reconnectTimer);
    link.reconnectTimer = null;
  }
  try { ws?.close(); } catch { /* already closed */ }
  connectLink(link);
}

/** Manual "reconnect now" / wake-up: replace every endpoint's socket. */
function replaceBrokerSocket(): void {
  syncBrokerLinks();
  brokerLinks.forEach((link) => replaceLinkSocket(link));
}

function watchBroker(): void {
  brokerWatchdog ??= setInterval(() => {
    if (liveChannels().length === 0) {
      if (brokerWatchdog) clearInterval(brokerWatchdog);
      brokerWatchdog = null;
      return;
    }
    // Per endpoint: probe the ones that are up, replace whichever went silent,
    // and keep the ones that are down moving (their own backoff decides when).
    for (const link of [...brokerLinks.values()]) {
      if (!linkIsOpen(link)) {
        connectLink(link);
        continue;
      }
      if (Date.now() - link.lastMessageAt > BROKER_SILENCE_MS) {
        console.warn(`member mesh: the signaling socket to ${link.url} went silent, reconnecting`);
        replaceLinkSocket(link);
        continue;
      }
      brokerSend({ type: 'ping' }, [link]);
    }
  }, BROKER_PING_MS);
}

/** Make sure one endpoint's socket is up (or on its way) while any channel needs it. */
function connectLink(link: BrokerLink): void {
  if (link.ws || link.reconnectTimer || liveChannels().length === 0) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(link.url);
  } catch {
    scheduleLinkReconnect(link);
    return;
  }
  link.ws = ws;

  watchBroker();

  ws.onopen = () => {
    if (link.ws !== ws) return;
    link.openedAt = Date.now();
    link.lastMessageAt = Date.now();
    const open = liveChannels();
    brokerSend({ type: 'subscribe', topics: [...new Set(open.map((channel) => channel.topic))] }, [link]);
    // Only on this link: the other brokers have heard this announce already.
    open.forEach((channel) => announce(channel, [link]));
  };
  ws.onmessage = (event) => {
    if (link.ws === ws) link.lastMessageAt = Date.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const message = parsed as { type?: string; topic?: string; envelope?: { iv?: unknown; data?: unknown } };
    if (message.type !== 'publish' || typeof message.topic !== 'string' || !message.envelope) return;
    const envelope = message.envelope;
    for (const channel of liveChannels()) {
      if (channel.topic !== message.topic) continue;
      void decryptEnvelope(channel.key, envelope).then((payload) => {
        if (payload && !channel.destroyed) handleEnvelope(channel, payload);
      });
    }
  };
  ws.onclose = () => {
    if (link.ws !== ws) return;
    link.ws = null;
    // A socket that stood for a while starts from a fresh backoff; one that was
    // accepted and dropped straight away keeps climbing.
    if (link.openedAt > 0 && Date.now() - link.openedAt >= BROKER_STABLE_MS) link.retries = 0;
    link.openedAt = 0;
    scheduleLinkReconnect(link);
  };
  ws.onerror = () => ws.close();
}

/** Dial every configured endpoint that is not up yet. */
function connectBroker(): void {
  if (liveChannels().length === 0) return;
  syncBrokerLinks();
  brokerLinks.forEach((link) => connectLink(link));
}

function scheduleLinkReconnect(link: BrokerLink): void {
  if (link.reconnectTimer || liveChannels().length === 0) return;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(link.retries, 5));
  link.retries++;
  link.reconnectTimer = setTimeout(() => {
    link.reconnectTimer = null;
    connectLink(link);
  }, delay);
}

/** A new channel joins every shared socket: subscribe its topic on the open ones, dial the rest. */
function joinBroker(channel: BlobChannel): void {
  const open = openLinks();
  if (open.length > 0) {
    brokerSend({ type: 'subscribe', topics: [channel.topic] }, open);
    announce(channel, open);
  }
  connectBroker();
}

/** A channel is gone: drop its topic unless another channel shares it, and hang up after the last one. */
function leaveBroker(channel: BlobChannel): void {
  const remaining = liveChannels();
  if (!remaining.some((other) => other.topic === channel.topic)) {
    brokerSend({ type: 'unsubscribe', topics: [channel.topic] });
  }
  if (remaining.length > 0) return;
  if (brokerWatchdog) clearInterval(brokerWatchdog);
  brokerWatchdog = null;
  brokerLinks.forEach((link) => closeLink(link));
  // Dropped entirely: the next channel re-reads the endpoint list.
  brokerLinks.clear();
}

/**
 * Single-flight guard: channel creation awaits key derivation before it can
 * register in `channels`, so two overlapping calls (StrictMode double
 * effects, several pages ensuring the same dapp) would otherwise BOTH pass
 * the existence check and spawn a second, orphaned channel — an invisible
 * twin with its own clientId that every peer then sees as a duplicate device.
 */
const channelCreations = new Map<string, Promise<boolean>>();

/**
 * Ensure the blob exchange channel for a dapp is up, re-deriving credentials
 * from the catalog (a rotation therefore lands on the new topic). No-op when
 * the dapp has no room credentials yet.
 */
export function ensureBlobChannel(dappId: string): Promise<boolean> {
  if (!reconnectListenerRegistered) {
    reconnectListenerRegistered = true;
    registerProviderReconnectListener((changedDappId) => {
      if (channels.has(changedDappId)) {
        destroyBlobChannel(changedDappId);
        void ensureBlobChannel(changedDappId);
      }
    });
    // The device changed its signaling servers (Settings → Signaling): drop the
    // sockets that are gone, dial the new ones, keep the ones that stayed —
    // no reload, and no peer connection is torn down for it.
    subscribeSignalingEndpoints(() => {
      if (liveChannels().length === 0) return;
      connectBroker();
    });
  }
  const pending = channelCreations.get(dappId);
  if (pending) return pending;
  const creation = createBlobChannel(dappId);
  channelCreations.set(dappId, creation);
  void creation.finally(() => {
    if (channelCreations.get(dappId) === creation) channelCreations.delete(dappId);
  });
  return creation;
}

async function createBlobChannel(dappId: string): Promise<boolean> {
  const { roomId, roomPassword } = getDappCredentials(dappId);
  if (!roomId || !roomPassword) return false;
  const { topic, password } = deriveBlobCredentials(roomId, roomPassword);

  const existing = channels.get(dappId);
  if (existing && !existing.destroyed) {
    if (existing.topic === topic) return true;
    destroyBlobChannel(dappId); // credentials rotated
  }

  const generation = channelGenerations.get(dappId) ?? 0;
  const key = await deriveSignalingKey(password, topic);
  // The mesh serves documents and decides trust from the members map, so it must not go
  // online with a half-loaded copy: a peer connecting then pulled an almost empty diff,
  // and with `members` still empty real members were refused. (Bounded — when local storage
  // never opens the mesh still starts; the shell shows the storage warning.)
  await Promise.all([
    whenLocalCopyLoaded(getDappPersistence(dappId)),
    whenLocalCopyLoaded(getDappSourcePersistence(dappId)),
  ]);
  // Destroyed (dapp left or deleted) or re-keyed while this was waiting: that caller's word counts.
  if ((channelGenerations.get(dappId) ?? 0) !== generation) return false;
  const current = getDappCredentials(dappId);
  if (current.roomId !== roomId || current.roomPassword !== roomPassword) return createBlobChannel(dappId);

  const channel: BlobChannel = {
    dappId,
    topic,
    clientId: crypto.randomUUID(),
    key,
    peers: new Map(),
    sessions: new Map(),
    peerCreatedAt: new Map(),
    peerCreations: [],
    rejectedAt: new Map(),
    seenMessages: new Set(),
    docTraffic: {
      main: { sent: 0, received: 0, lastSentAt: null, lastReceivedAt: null },
      source: { sent: 0, received: 0, lastSentAt: null, lastReceivedAt: null },
    },
    pullsInFlight: new Map(),
    pendingPokes: new Map(),
    detachDocs: [],
    announceTimer: null,
    sweepsSinceCatchUp: 0,
    destroyed: false,
  };
  channels.set(dappId, channel);
  attachDocs(channel);
  joinBroker(channel);
  channel.announceTimer = setInterval(() => { sweepChannel(channel); announce(channel); }, ANNOUNCE_INTERVAL_MS);
  return true;
}

/** Sessions silent past this many ms are dead — pings guarantee live ones produce frames. */
const STALE_SESSION_MS = 90_000;
/**
 * Every this many sweeps (30 s each → 5 min) one ready session is asked for what this
 * device is missing. Live pushes are fire-and-forget: an update lost to backpressure, a
 * relay that did not happen or a pull that ended early would otherwise stay missing until
 * the next reconnect. The request is a state vector; the usual answer is an empty diff.
 */
const CATCH_UP_EVERY_SWEEPS = 10;
/** Peers that never completed the handshake get this long before being recycled. */
const HANDSHAKE_GRACE_MS = 60_000;

/**
 * Liveness sweep. A datachannel that died while the device slept keeps its
 * peer entry, and a known peer id blocks the broker announce path from ever
 * rebuilding the connection — the same zombie pattern the y-webrtc watchdog
 * handles for doc rooms. Ping every session; drop the silent and the stuck.
 */
function sweepChannel(channel: BlobChannel): void {
  if (channel.destroyed) return;
  const now = Date.now();
  for (const [remoteId, peer] of [...channel.peers]) {
    const session = channel.sessions.get(remoteId);
    if (peer.destroyed) {
      dropPeer(channel, remoteId);
      continue;
    }
    if (!session) {
      if (now - (channel.peerCreatedAt.get(remoteId) ?? now) > HANDSHAKE_GRACE_MS) dropPeer(channel, remoteId);
      continue;
    }
    if (now - session.lastFrameAt > STALE_SESSION_MS) {
      dropPeer(channel, remoteId);
      continue;
    }
    session.ping();
  }
  channel.sweepsSinceCatchUp += 1;
  if (channel.sweepsSinceCatchUp >= CATCH_UP_EVERY_SWEEPS) {
    const ready = [...channel.sessions.values()].filter((session) => session.state === 'ready');
    if (ready.length > 0) {
      channel.sweepsSinceCatchUp = 0;
      // A different peer each round, so one lagging device is not the only source.
      void pullFromSession(channel, ready[Math.floor(Math.random() * ready.length)]);
    }
  }
}

export function destroyBlobChannel(dappId: string): void {
  channelGenerations.set(dappId, (channelGenerations.get(dappId) ?? 0) + 1);
  const channel = channels.get(dappId);
  if (!channel) return;
  channel.destroyed = true;
  if (channel.announceTimer) clearInterval(channel.announceTimer);
  channel.detachDocs.splice(0).forEach((detach) => detach());
  [...channel.peers.keys()].forEach((remoteId) => dropPeer(channel, remoteId));
  publishMeshPeerKeys(dappId, []);
  channels.delete(dappId);
  leaveBroker(channel);
}

/** Manual "reconnect now": drop the channel (every peer session) and the shared broker socket, and dial again. */
export function reconnectBlobChannel(dappId: string): Promise<boolean> {
  destroyBlobChannel(dappId);
  // The socket is shared by all dapps, so destroying one channel used to leave it in place —
  // and a socket that is the actual problem stayed. The other channels resubscribe on open.
  if (liveChannels().length > 0) replaceBrokerSocket();
  return ensureBlobChannel(dappId);
}

function readySessions(dappId: string): BlobPeerSession[] {
  const channel = channels.get(dappId);
  if (!channel) return [];
  return [...channel.sessions.values()].filter((session) => session.state === 'ready');
}

/**
 * Wake-up nudge from the sync watchdog: a broker socket that died while the
 * device slept may never fire its close event. Closing it explicitly kicks
 * the channel's own reconnect path.
 */
export function nudgeBlobChannels(): void {
  liveChannels().forEach((channel) => sweepChannel(channel));
  if (liveChannels().length === 0) return;
  syncBrokerLinks();
  for (const link of brokerLinks.values()) {
    const ws = link.ws;
    if (!ws) {
      connectLink(link);
      continue;
    }
    if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
      try { ws.close(); } catch { /* already closed */ }
      // A socket that died in its sleep may never fire `close` — do not wait for it.
      if (link.ws === ws) {
        link.ws = null;
        link.openedAt = 0;
        scheduleLinkReconnect(link);
      }
    }
  }
}

export interface MeshBrokerStatus {
  url: string;
  connected: boolean;
}

/**
 * Every configured signaling endpoint with its socket state — for Settings,
 * which shows the effective list whether or not a dapp is open.
 */
export function getBrokerLinkStatus(): MeshBrokerStatus[] {
  return signalingEndpoints().map((url) => {
    const link = brokerLinks.get(url);
    return { url, connected: link !== undefined && linkIsOpen(link) };
  });
}

/** The endpoint the UI names as "the" broker: the first connected one, else the first configured. */
function primaryBrokerUrl(): string | null {
  const connected = openLinks()[0];
  if (connected) return connected.url;
  const [first] = brokerLinks.keys();
  return first ?? null;
}

export interface MeshChannelStatus {
  active: boolean;
  /** At least ONE signaling endpoint is reachable — the mesh needs no more than that. */
  brokerConnected: boolean;
  /** The endpoint peers are currently found through (the first connected one), null before the first attempt. */
  brokerUrl: string | null;
  /** Every configured endpoint and whether its socket is up; a peer is reached through any of them. */
  brokers: MeshBrokerStatus[];
  peers: Array<{ publicKey: string | null; ready: boolean; lastSeenMsAgo: number }>;
  /** Live-sync traffic per document since the channel opened (absent while inactive). */
  docs: Record<DocKind, DocTraffic> | null;
}

/** Live mesh status for the sync panel and the keeper. */
export function getBlobChannelStatus(dappId: string): MeshChannelStatus {
  const channel = channels.get(dappId);
  if (!channel || channel.destroyed) {
    return { active: false, brokerConnected: false, brokerUrl: null, brokers: [], peers: [], docs: null };
  }
  const now = Date.now();
  return {
    active: true,
    brokerConnected: brokerIsOpen(),
    brokerUrl: primaryBrokerUrl(),
    brokers: [...brokerLinks.values()].map((link) => ({ url: link.url, connected: linkIsOpen(link) })),
    docs: { main: { ...channel.docTraffic.main }, source: { ...channel.docTraffic.source } },
    peers: [...channel.sessions.values()].map((session) => ({
      publicKey: session.remotePublicKey,
      ready: session.state === 'ready',
      lastSeenMsAgo: now - session.lastFrameAt,
    })),
  };
}

/** Number of ready peers announcing a blob — the UI's redundancy indicator. */
export function countBlobHolders(dappId: string, sha256: string): number {
  return readySessions(dappId).filter((session) => session.remoteHas(sha256)).length;
}

/**
 * Pin-all replication: fetch and pin every indexed blob this device is
 * missing. Runs opportunistically (Files page open, channel connected); a
 * no-op unless the dapp's local replication mode is 'pinAll'.
 */
export async function replicateAllBlobs(dappId: string): Promise<void> {
  if (getDappBlobReplication(dappId) !== 'pinAll') return;
  const store = getBlobStore();
  for (const record of listFileRecords(dappId)) {
    if (await store.hasBlob(record.sha256)) {
      await store.setPinned(record.sha256, true);
      continue;
    }
    const fetched = await fetchBlobFromPeers(dappId, blobDescriptorOf(record));
    if (fetched) await store.setPinned(record.sha256, true);
  }
}

/**
 * Explicit catch-up (docs/plans/2026-08-24-blob-store.md, doc-sync extension):
 * pull the main doc's missing state from every connected member, in chunks.
 * The mesh already does this on connect; this is the manual / scheduled
 * "pull now" with progress. Resolves true once a peer's state was applied.
 */
export async function syncDappStateFromPeers(
  dappId: string,
  onProgress?: (received: number, total: number) => void,
): Promise<boolean> {
  await ensureBlobChannel(dappId);
  const deadline = Date.now() + SESSION_WAIT_MS;
  // Ask EVERY reachable member, not just the first responder: the first peer
  // may itself be behind (its "success" is an empty diff). The state vector is
  // re-encoded before each request, so each peer only sends what is still
  // missing after the previous ones — asking everyone is cheap and converges
  // on the union of all reachable members' knowledge.
  const attempted = new Set<BlobPeerSession>();
  let pulled = false;
  for (;;) {
    const fresh = readySessions(dappId).filter((session) => !attempted.has(session));
    if (fresh.length === 0) {
      if (pulled || Date.now() >= deadline) return pulled;
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    for (const session of fresh) {
      attempted.add(session);
      if (await session.requestDocSync('main', () => Y.encodeStateVector(getDappDoc(dappId)), { onProgress })) pulled = true;
    }
  }
}

/** Announce a freshly-added local blob to connected peers. */
export function announceLocalBlob(dappId: string, sha256: string): void {
  readySessions(dappId).forEach((session) => session.announceHave([sha256]));
}

async function waitForHolders(dappId: string, sha256: string, timeoutMs: number): Promise<BlobPeerSession[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const holders = readySessions(dappId).filter((session) => session.remoteHas(sha256));
    if (holders.length > 0) return holders;
    if (Date.now() >= deadline) return readySessions(dappId); // last resort: ask everyone connected
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Fetch a blob from connected members: waits for peers that announced the
 * content, splits missing chunk ranges round-robin across them, and retries
 * leftovers once on the surviving sessions. Resolves true when the blob is
 * complete and verified locally.
 */
export async function fetchBlobFromPeers(
  dappId: string,
  descriptor: BlobDescriptor,
  onProgress?: (received: number, total: number) => void,
): Promise<boolean> {
  const store = getBlobStore();
  if (await store.hasBlob(descriptor.sha256)) return true;
  await ensureBlobChannel(dappId);

  const holders = await waitForHolders(dappId, descriptor.sha256, SESSION_WAIT_MS);
  if (holders.length === 0) return false;

  await store.registerRemoteBlob(descriptor);
  const missing = await store.missingChunks(descriptor);
  const total = missing.length;
  let received = 0;
  const report = () => onProgress?.(++received, total);

  const buckets = new Map<BlobPeerSession, number[]>();
  missing.forEach((index, position) => {
    const session = holders[position % holders.length];
    const bucket = buckets.get(session) ?? [];
    bucket.push(index);
    buckets.set(session, bucket);
  });
  await Promise.all([...buckets.entries()].map(([session, indexes]) =>
    session.fetchBlob(descriptor, { indexes, onProgress: report })));

  // Retry anything still missing (a peer died or timed out) on any surviving session.
  let remaining = await store.missingChunks(descriptor);
  if (remaining.length > 0) {
    for (const session of readySessions(dappId)) {
      if (remaining.length === 0) break;
      await session.fetchBlob(descriptor, { indexes: remaining, onProgress: report });
      remaining = await store.missingChunks(descriptor);
    }
  }

  if (remaining.length === 0 && !(await store.hasBlob(descriptor.sha256))) {
    await store.finalizeBlob(descriptor);
  }
  return store.hasBlob(descriptor.sha256);
}
