import * as Y from 'yjs';
import type {
  CanonicalJson,
  ChannelDescriptor,
  ChannelShare,
  CodeAppBindingDeclaration,
  CodeAppManifest,
  DappContactHandle,
  HybridEncryptedEnvelope,
  Relationship,
  StreamEvent,
  UnsignedStreamEvent,
} from '../types.ts';
import { projectPayload, suggestFieldMap, validatePayload } from './bindingPayload.ts';
import { parseCodeAppManifest } from './codeAppManifest.ts';
import { deriveAcceptedStreams, ingestStreamEvent, RELATIONSHIP_STREAM_EVENTS_MAP } from './projectionPublisher.ts';
import { hashStreamEvent, signStreamEvent } from './relationshipStream.ts';
import { hybridDecrypt, hybridEncrypt } from './relationshipProtocol.ts';
import { openRelationshipChannel } from './sharingRuntime.ts';
import { checkpointRootPersistence, getRootDoc, getRootPersistence } from './store/docs.ts';
import { getRunnableCodeAppFile } from './store/sourceSeal.ts';
import { getChannelDescriptorById } from './store/channelRegistry.ts';
import { listAllChannelShares, listChannelSharesByInstance } from './store/channelShares.ts';
import { deriveDappContactHandle } from './store/contacts.ts';
import { getPerson } from './store/people.ts';
import { getRelationship } from './store/relationships.ts';
import type { ChannelRoomHandle } from './channelRoomManager.ts';
import { DIAGNOSTICS_MAP, REPLAY_MAP } from './channelBindingHistory.ts';

const CHANNEL_BINDING_PROTOCOL = 'channel-binding';
const CHANNEL_BINDING_SCHEMA_VERSION = 1;
const MAX_CHANNEL_DELIVERIES = 1_000;
const MAX_CHANNEL_ACK_HISTORY = 100;
export const MAX_CHANNEL_REPLAY_HISTORY = 5_000;
const MAX_CHANNEL_DIAGNOSTICS = 500;

/** Share of the replay history dropped in one go when it is full (so pruning is rare, not per delivery). */
const REPLAY_PRUNE_FRACTION = 0.2;

const DELIVERY_STREAM_PREFIX = 'channel-binding-delivery:';
const ACK_STREAM_PREFIX = 'channel-binding-ack:';
const SEALED_PROTOCOL = 'channel-binding-sealed';
const SEALED_SCHEMA_VERSION = 1;

/**
 * Channel-room payload confidentiality (review item 6.5). The channel room is
 * a y-webrtc room: whoever holds its id + password gets the whole doc. So the
 * delivery / ack envelopes are sealed to the peer's relationship encryption
 * key (`hybridEncrypt`: fresh AES-256-GCM key per event, wrapped with
 * RSA-OAEP-256) and the stream event signs the ciphertext — a credential
 * holder sees only routing metadata.
 *
 * Writes are ALWAYS sealed. `acceptPlaintext` keeps reading the plaintext
 * envelopes of builds before 2026-09-22 (entries still queued in channel docs);
 * flip it to `false` in a later release — then a plaintext delivery or ack is
 * ignored like any other malformed entry. Tests flip it per case.
 */
export const CHANNEL_PAYLOAD_POLICY = { acceptPlaintext: true };

interface SealedChannelPayload {
  protocol: typeof SEALED_PROTOCOL;
  schemaVersion: typeof SEALED_SCHEMA_VERSION;
  encrypted: HybridEncryptedEnvelope;
}

type StreamEventRouting = Pick<UnsignedStreamEvent, 'channelId' | 'eventId' | 'streamId' | 'signerPublicKey'>;

/**
 * Additional data of a sealed payload: the channel, the event's own random id
 * (the delivery nonce / ack id) and stream, the signer and the intended
 * recipient. A ciphertext lifted into another event, channel or direction —
 * or re-signed by another key — no longer decrypts.
 */
function sealedPayloadAad(event: StreamEventRouting, recipientPublicKey: string): CanonicalJson {
  return {
    protocol: SEALED_PROTOCOL,
    schemaVersion: SEALED_SCHEMA_VERSION,
    channelId: event.channelId,
    eventId: event.eventId,
    streamId: event.streamId,
    signerPublicKey: event.signerPublicKey,
    recipientPublicKey,
  };
}

function parseSealed(value: CanonicalJson): SealedChannelPayload | null {
  if (!isPlainRecord(value) || value.protocol !== SEALED_PROTOCOL || value.schemaVersion !== SEALED_SCHEMA_VERSION) return null;
  const encrypted = value.encrypted;
  if (!isPlainRecord(encrypted)
    || !nonEmptyString(encrypted.wrappedKey, 4096)
    || !nonEmptyString(encrypted.iv, 64)
    || !nonEmptyString(encrypted.ciphertext, 1_000_000)
    || !nonEmptyString(encrypted.aadHash, 128)) return null;
  return value as unknown as SealedChannelPayload;
}

/**
 * Decrypted payloads per channel doc, keyed by the stored entry hash (which
 * covers the ciphertext): an RSA unwrap per queued entry per scan would make a
 * 1,000-delivery backlog cost seconds on every change. Rebuilt every scan.
 */
const openedPayloads = new WeakMap<Y.Doc, Map<string, CanonicalJson | null>>();

type ChannelBindingRejection =
  | 'instance-mismatch'
  | 'share-inactive'
  | 'event-not-approved'
  | 'replay-capacity-exceeded'
  | 'replay-window-passed'
  | 'action-not-approved'
  | 'action-not-declared'
  | 'action-not-in-current-share'
  | 'route-not-declared'
  | 'payload-invalid'
  | 'wrong-peer';

interface ChannelBindingDeliveryPayload {
  protocol: typeof CHANNEL_BINDING_PROTOCOL;
  schemaVersion: typeof CHANNEL_BINDING_SCHEMA_VERSION;
  type: 'delivery';
  instanceId: string;
  eventId: string;
  actionId: string;
  payload: CanonicalJson;
  sentAt: string;
  nonce: string;
}

interface ChannelBindingAckPayload {
  protocol: typeof CHANNEL_BINDING_PROTOCOL;
  schemaVersion: typeof CHANNEL_BINDING_SCHEMA_VERSION;
  type: 'ack';
  instanceId: string;
  deliveryNonce: string;
  deliveryHash: string;
  outcome: 'delivered' | 'rejected';
  reason?: ChannelBindingRejection;
  acknowledgedAt: string;
}

export interface ChannelActionDelivery {
  id: string;
  actionId: string;
  payload: CanonicalJson;
  from: DappContactHandle;
  instanceId: string;
  channelId: string;
  relationshipId: string;
}

type ActionInvoker = (delivery: ChannelActionDelivery) => Promise<void>;
interface RegisteredAction { runtimeId: string; invoke: ActionInvoker }

interface ObservedChannel {
  share: ChannelShare;
  descriptor: ChannelDescriptor;
  relationship: Relationship;
  room: ChannelRoomHandle;
  observer: () => void;
  queue: Promise<void>;
  /** A scan is queued and has not started yet — further changes ride along with it. */
  scanQueued: boolean;
}

export interface ChannelBindingRuntimeDependencies {
  rootDoc?: Y.Doc;
  persistentRoot?: boolean;
  listShares?: (doc: Y.Doc) => ChannelShare[];
  listSharesByInstance?: (dappId: string, instanceId: string, doc: Y.Doc) => ChannelShare[];
  getDescriptor?: (channelId: string, doc: Y.Doc) => ChannelDescriptor | null;
  getRelationship?: (relationshipId: string, doc: Y.Doc) => Relationship | null;
  openRoom?: (descriptor: ChannelDescriptor, relationship: Relationship) => Promise<ChannelRoomHandle>;
  manifestFor?: (dappId: string) => CodeAppManifest | null;
  contactFor?: (dappId: string, relationship: Relationship, doc: Y.Doc) => Promise<DappContactHandle>;
  checkpoint?: () => Promise<void>;
  now?: () => string;
  randomUUID?: () => string;
}

function manifestForDapp(dappId: string): CodeAppManifest | null {
  // The sealed manifest decides what leaves the dapp through a channel share (sourceSeal.ts).
  const result = parseCodeAppManifest(getRunnableCodeAppFile(dappId, 'manifest.yaml'));
  return result.error ? null : result.manifest;
}

async function contactForRelationship(dappId: string, relationship: Relationship, doc: Y.Doc): Promise<DappContactHandle> {
  return {
    handle: await deriveDappContactHandle(dappId, relationship.id, doc),
    displayName: getPerson(relationship.personId, doc)?.displayName ?? 'Unknown',
    verified: Boolean(relationship.verifiedAt),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmptyString(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function parseDelivery(value: CanonicalJson): ChannelBindingDeliveryPayload | null {
  if (!isPlainRecord(value)
    || value.protocol !== CHANNEL_BINDING_PROTOCOL
    || value.schemaVersion !== CHANNEL_BINDING_SCHEMA_VERSION
    || value.type !== 'delivery'
    || !nonEmptyString(value.instanceId)
    || !nonEmptyString(value.eventId)
    || !nonEmptyString(value.actionId)
    || !nonEmptyString(value.sentAt)
    || !nonEmptyString(value.nonce)) return null;
  if (!Object.hasOwn(value, 'payload')) return null;
  return value as unknown as ChannelBindingDeliveryPayload;
}

function parseAck(value: CanonicalJson): ChannelBindingAckPayload | null {
  if (!isPlainRecord(value)
    || value.protocol !== CHANNEL_BINDING_PROTOCOL
    || value.schemaVersion !== CHANNEL_BINDING_SCHEMA_VERSION
    || value.type !== 'ack'
    || !nonEmptyString(value.instanceId)
    || !nonEmptyString(value.deliveryNonce)
    || !nonEmptyString(value.deliveryHash, 64)
    || !/^[a-f0-9]{64}$/.test(value.deliveryHash)
    || (value.outcome !== 'delivered' && value.outcome !== 'rejected')
    || !nonEmptyString(value.acknowledgedAt)) return null;
  return value as unknown as ChannelBindingAckPayload;
}

function declarationFor(manifest: CodeAppManifest, kind: 'events' | 'actions', endpointId: string): CodeAppBindingDeclaration | null {
  return manifest.bindings?.[kind]?.find(({ id }) => id === endpointId) ?? null;
}

function replayKey(channelId: string, signerPublicKey: string, nonce: string): string {
  return `${channelId}\u0000${signerPublicKey}\u0000${nonce}`;
}

function replayPrefix(channelId: string, signerPublicKey: string): string {
  return `${channelId}\u0000${signerPublicKey}\u0000`;
}

const RESERVED_REPLAY_NONCES = ['__capacity-saturated__', '__high-water__'];

function rowTime(serialized: string, field: 'sentAt' | 'processedAt'): string {
  try {
    const value = (JSON.parse(serialized) as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/** `sentAt` up to which this signer's deliveries were already pruned from the replay history. */
function replayHighWater(replay: Y.Map<string>, channelId: string, signerPublicKey: string): string {
  const serialized = replay.get(`${replayPrefix(channelId, signerPublicKey)}__high-water__`);
  return serialized ? rowTime(serialized, 'sentAt') : '';
}

/**
 * Replay protection is a SLIDING WINDOW per (channel, signer). It used to be a
 * hard cap: at 5,000 remembered deliveries a flag was set and every later
 * delivery was rejected for good — a chat-like share died silently after some
 * months. Now the oldest rows are dropped when the history is full, and the
 * newest `sentAt` among them becomes the high-water mark: a delivery that is
 * not remembered any more AND was sent at or before the mark is refused
 * (`replay-window-passed`), so dropping rows never turns an old delivery into a
 * fresh one. `sentAt` is part of the signed payload. Trade-off: a genuine
 * delivery that arrives more than ~4,000 deliveries late is refused as well.
 *
 * Returns whether a delivery sent at `sentAt` may be processed.
 */
export function reserveChannelReplayCapacity(
  replay: Y.Map<string>,
  channelId: string,
  signerPublicKey: string,
  sentAt: string,
): boolean {
  const prefix = replayPrefix(channelId, signerPublicKey);
  // Left by the hard cap of earlier builds: the window makes the channel work again.
  replay.delete(`${prefix}__capacity-saturated__`);
  const highWater = replayHighWater(replay, channelId, signerPublicKey);
  if (highWater && sentAt <= highWater) return false;

  const rows: Array<{ key: string; sentAt: string; order: string }> = [];
  replay.forEach((serialized, key) => {
    if (!key.startsWith(prefix) || RESERVED_REPLAY_NONCES.includes(key.slice(prefix.length))) return;
    const sent = rowTime(serialized, 'sentAt');
    rows.push({ key, sentAt: sent, order: sent || rowTime(serialized, 'processedAt') });
  });
  if (rows.length < MAX_CHANNEL_REPLAY_HISTORY - 1) return true;

  rows.sort((left, right) => left.order.localeCompare(right.order) || left.key.localeCompare(right.key));
  const dropped = rows.slice(0, Math.max(1, Math.floor(MAX_CHANNEL_REPLAY_HISTORY * REPLAY_PRUNE_FRACTION)));
  // Rows written before `sentAt` was stored order by `processedAt`, which is never earlier than it.
  const mark = dropped.reduce((latest, row) => (row.order > latest ? row.order : latest), highWater);
  dropped.forEach((row) => replay.delete(row.key));
  replay.set(`${prefix}__high-water__`, JSON.stringify({ sentAt: mark }));
  return sentAt > mark;
}

export function pruneChannelBindingMetadata(map: Y.Map<string>, maximum: number): void {
  if (map.size <= maximum) return;
  const rows = Array.from(map.entries()).map(([key, serialized]) => {
    try {
      const value = JSON.parse(serialized) as { processedAt?: unknown; recordedAt?: unknown };
      const timestamp = typeof value.processedAt === 'string' ? value.processedAt
        : typeof value.recordedAt === 'string' ? value.recordedAt : '';
      return { key, timestamp };
    } catch {
      return { key, timestamp: '' };
    }
  });
  rows.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.key.localeCompare(right.key));
  rows.slice(0, Math.max(0, rows.length - maximum)).forEach(({ key }) => map.delete(key));
}

export class ChannelBindingRuntime {
  private readonly rootDoc: Y.Doc;
  private readonly persistentRoot: boolean;
  private readonly dependencies: Required<Omit<ChannelBindingRuntimeDependencies, 'rootDoc' | 'persistentRoot' | 'checkpoint'>>
    & { checkpoint: () => Promise<void> };
  private readonly actions = new Map<string, RegisteredAction>();
  private readonly channels = new Map<string, ObservedChannel>();
  private readonly processing = new Set<string>();
  private rootObserver: (() => void) | null = null;
  private reconcileQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(input: ChannelBindingRuntimeDependencies = {}) {
    this.rootDoc = input.rootDoc ?? getRootDoc();
    this.persistentRoot = input.persistentRoot ?? input.rootDoc === undefined;
    this.dependencies = {
      listShares: input.listShares ?? listAllChannelShares,
      listSharesByInstance: input.listSharesByInstance ?? listChannelSharesByInstance,
      getDescriptor: input.getDescriptor ?? getChannelDescriptorById,
      getRelationship: input.getRelationship ?? getRelationship,
      openRoom: input.openRoom ?? ((descriptor, relationship) => openRelationshipChannel(descriptor, relationship, true, { allowPending: true })),
      manifestFor: input.manifestFor ?? manifestForDapp,
      contactFor: input.contactFor ?? contactForRelationship,
      checkpoint: input.checkpoint ?? (async () => { if (this.persistentRoot) await checkpointRootPersistence(); }),
      now: input.now ?? (() => new Date().toISOString()),
      randomUUID: input.randomUUID ?? (() => crypto.randomUUID()),
    };
  }

  async initialize(): Promise<void> {
    if (this.disposed) throw new Error('channel binding runtime: Runtime is disposed');
    if (this.persistentRoot) await (getRootPersistence()?.whenSynced ?? Promise.resolve());
    if (!this.rootObserver) {
      this.rootObserver = () => this.scheduleReconcile();
      this.rootDoc.getMap('channelShares').observeDeep(this.rootObserver);
      this.rootDoc.getMap('channelDescriptors').observeDeep(this.rootObserver);
      this.rootDoc.getMap('relationships').observeDeep(this.rootObserver);
    }
    await this.reconcileShares();
  }

  dispose(): void {
    this.disposed = true;
    if (this.rootObserver) {
      this.rootDoc.getMap('channelShares').unobserveDeep(this.rootObserver);
      this.rootDoc.getMap('channelDescriptors').unobserveDeep(this.rootObserver);
      this.rootDoc.getMap('relationships').unobserveDeep(this.rootObserver);
    }
    this.rootObserver = null;
    for (const observed of this.channels.values()) {
      observed.room.doc.getMap(RELATIONSHIP_STREAM_EVENTS_MAP).unobserve(observed.observer);
    }
    this.channels.clear();
    this.actions.clear();
    this.processing.clear();
  }

  private scheduleReconcile(): void {
    if (this.disposed) return;
    this.reconcileQueue = this.reconcileQueue.then(() => this.reconcileShares()).catch(() => undefined);
  }

  async reconcileShares(): Promise<void> {
    if (this.disposed) return;
    const activeIds = new Set<string>();
    for (const share of this.dependencies.listShares(this.rootDoc)) {
      // Pending shares are observed too: their channel doc is our durable outbox,
      // so an event published before the recipient accepts waits there instead of
      // being lost. Inbound processing stays gated on 'active' (verifyStreamEvent).
      if (share.status !== 'active' && share.status !== 'pending') continue;
      const descriptor = this.dependencies.getDescriptor(share.channelId, this.rootDoc);
      const relationship = this.dependencies.getRelationship(share.relationshipId, this.rootDoc);
      if (!descriptor || (descriptor.status !== 'active' && descriptor.status !== 'prepared')
        || !relationship || relationship.status !== 'active' || !relationship.peerPublicKey) continue;
      if (descriptor.id !== share.channelId
        || descriptor.relationshipId !== share.relationshipId
        || descriptor.dappId !== share.dappId
        || descriptor.sensitiveShareId !== share.instanceId) continue;
      activeIds.add(share.channelId);
      const existing = this.channels.get(share.channelId);
      if (existing) {
        const becameActive = existing.descriptor.status !== 'active' && descriptor.status === 'active';
        existing.share = share;
        existing.descriptor = descriptor;
        existing.relationship = relationship;
        // Events that synced in while the channel was still pending were skipped
        // by the scanner; the activation flip is the moment to process them.
        if (becameActive) this.scheduleScan(existing);
        continue;
      }
      const room = await this.dependencies.openRoom(descriptor, relationship);
      await room.persistenceReady;
      const observed: ObservedChannel = {
        share, descriptor, relationship, room, queue: Promise.resolve(), scanQueued: false, observer: () => this.scheduleScan(observed),
      };
      room.doc.getMap(RELATIONSHIP_STREAM_EVENTS_MAP).observe(observed.observer);
      this.channels.set(share.channelId, observed);
      await this.scanObserved(observed);
    }
    for (const [channelId, observed] of this.channels) {
      if (activeIds.has(channelId)) continue;
      observed.room.doc.getMap(RELATIONSHIP_STREAM_EVENTS_MAP).unobserve(observed.observer);
      this.channels.delete(channelId);
    }
  }

  private scheduleScan(observed: ObservedChannel): void {
    if (this.disposed) return;
    // One queued scan covers every change that lands before it starts (it reads
    // the doc then). Without this, draining a backlog queues a full scan per
    // ack written. The scan itself stays cheap on unchanged entries because
    // deriveAcceptedStreams remembers its verdicts per channel doc.
    if (observed.scanQueued) return;
    observed.scanQueued = true;
    observed.queue = observed.queue.then(() => {
      observed.scanQueued = false;
      return this.scanObserved(observed);
    }).catch(() => undefined);
  }

  async scanChannel(channelId: string): Promise<void> {
    const observed = this.channels.get(channelId);
    if (!observed) throw new Error('channel binding runtime: Channel is not active');
    // Behind the scans already queued: a delivery an observer-triggered scan is still
    // processing is skipped by a parallel scan, which then returned before that scan had
    // written the ack (sealing it to the peer made the window wide enough to matter).
    const scan = observed.queue.then(() => this.scanObserved(observed));
    observed.queue = scan.catch(() => undefined);
    await scan;
  }

  registerActionRuntime(dappId: string, runtimeId: string, actionId: string, invoke: ActionInvoker): () => void {
    const manifest = this.dependencies.manifestFor(dappId);
    if (!manifest || !declarationFor(manifest, 'actions', actionId)) throw new Error(`Undeclared Code App action: ${actionId}`);
    const key = `${dappId}\u0000${actionId}`;
    this.actions.set(key, { runtimeId, invoke });
    for (const observed of this.channels.values()) {
      if (observed.share.dappId === dappId && observed.share.actionIds.includes(actionId)) this.scheduleScan(observed);
    }
    return () => {
      const current = this.actions.get(key);
      if (current?.runtimeId === runtimeId) this.actions.delete(key);
    };
  }

  async publishChannelEvent(
    dappId: string,
    eventId: string,
    payload: unknown,
    instanceId: string,
  ): Promise<{ deliveryIds: string[]; failures: Array<{ relationshipId: string; error: string }> }> {
    const manifest = this.dependencies.manifestFor(dappId);
    if (!manifest) throw new Error('channel binding runtime: Code App manifest is unavailable');
    const event = declarationFor(manifest, 'events', eventId);
    if (!event) throw new Error(`Undeclared Code App event: ${eventId}`);
    const validatedEvent = validatePayload(event.payload, payload);
    if (!validatedEvent.ok) throw new Error(validatedEvent.error);
    await this.reconcileShares();
    // Pending participants get the delivery queued in their channel doc now; it
    // reaches them once they accept the invite and their channel activates.
    const shares = this.dependencies.listSharesByInstance(dappId, instanceId, this.rootDoc)
      .filter(({ status }) => status === 'active' || status === 'pending');
    if (shares.length === 0) throw new Error('channel binding runtime: Share instance not found');
    const deliveryIds: string[] = [];
    const failures: Array<{ relationshipId: string; error: string }> = [];
    for (const share of shares) {
      try {
        if (!share.eventIds.includes(eventId)) throw new Error('Event is not approved for this participant');
        const manifestShare = manifest.channels?.shares?.find(({ id }) => id === share.shareId);
        if (!manifestShare) throw new Error('Share declaration is no longer present');
        const routes = manifestShare.routes.filter((route) => route.eventId === eventId);
        if (routes.length === 0) throw new Error('No channel route is declared for this event');
        const observed = this.channels.get(share.channelId);
        if (!observed) throw new Error('Channel is not active');
        for (const route of routes) {
          if (!share.actionIds.includes(route.actionId)) throw new Error(`Action ${route.actionId} is not approved for this participant`);
          const action = declarationFor(manifest, 'actions', route.actionId);
          if (!action) throw new Error(`Action ${route.actionId} is no longer declared`);
          const fieldMap = route.fieldMap ?? suggestFieldMap(event.payload, action.payload);
          const projected = action.payload ? projectPayload(fieldMap, validatedEvent.value) : validatedEvent.value;
          const validatedAction = validatePayload(action.payload, projected);
          if (!validatedAction.ok) throw new Error(validatedAction.error);
          const nonce = this.dependencies.randomUUID();
          await this.appendDelivery(observed, eventId, route.actionId, validatedAction.value, nonce);
          deliveryIds.push(nonce);
        }
      } catch (error) {
        failures.push({ relationshipId: share.relationshipId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (deliveryIds.length === 0 && failures.length > 0) throw new Error(`channel binding runtime: ${failures[0].error}`);
    return { deliveryIds, failures };
  }

  private async appendDelivery(
    observed: ObservedChannel,
    eventId: string,
    actionId: string,
    payload: CanonicalJson,
    nonce: string,
  ): Promise<void> {
    // Our own outbound writes may land while the share is still pending (the
    // recipient has not accepted yet) — validate them against an active view of
    // the descriptor. Inbound scans keep the real status, so nothing foreign is
    // processed before activation.
    const outboundDescriptor = observed.descriptor.status === 'active'
      ? observed.descriptor
      : { ...observed.descriptor, status: 'active' as const };
    const accepted = await deriveAcceptedStreams(observed.room.doc, outboundDescriptor);
    let pending = 0;
    accepted.forEach((stream) => {
      const candidate = stream.events[0];
      // Our own deliveries are sealed to the peer: count them by their signed stream id.
      if (candidate?.signerPublicKey === observed.relationship.localIdentity.publicKey
        && candidate.kind === 'action' && candidate.streamId.startsWith(DELIVERY_STREAM_PREFIX)) pending += 1;
    });
    if (pending >= MAX_CHANNEL_DELIVERIES) throw new Error(`Channel delivery queue is limited to ${MAX_CHANNEL_DELIVERIES}.`);
    const sentAt = this.dependencies.now();
    const envelope: ChannelBindingDeliveryPayload = {
      protocol: CHANNEL_BINDING_PROTOCOL,
      schemaVersion: CHANNEL_BINDING_SCHEMA_VERSION,
      type: 'delivery',
      instanceId: observed.share.instanceId,
      eventId,
      actionId,
      payload,
      sentAt,
      nonce,
    };
    const signed = await this.sealAndSign(observed, nonce, `${DELIVERY_STREAM_PREFIX}${nonce}`, sentAt, envelope as unknown as CanonicalJson);
    const result = await ingestStreamEvent(observed.room.doc, outboundDescriptor, signed);
    if (result.status !== 'stored' && result.status !== 'duplicate') throw new Error('Channel delivery was rejected');
  }

  /**
   * Seals `plaintext` to the peer and signs the event carrying the ciphertext.
   * The signature covers the ciphertext and every field the AAD binds, so a
   * stored entry is exactly as authentic as a plaintext one was; the signer key
   * in the AAD keeps a re-signed ciphertext from decrypting. The event's
   * `relationshipId` is the channel id: the local relationship id is this
   * device's own bookkeeping and never goes on the wire.
   */
  private async sealAndSign(
    observed: ObservedChannel,
    eventId: string,
    streamId: string,
    createdAt: string,
    plaintext: CanonicalJson,
  ): Promise<StreamEvent> {
    const { peerPublicKey, peerEncPublicKey, localIdentity } = observed.relationship;
    if (!peerPublicKey || !peerEncPublicKey) throw new Error('Contact has no encryption key');
    const routing: StreamEventRouting = { channelId: observed.descriptor.id, eventId, streamId, signerPublicKey: localIdentity.publicKey };
    const sealed: SealedChannelPayload = {
      protocol: SEALED_PROTOCOL,
      schemaVersion: SEALED_SCHEMA_VERSION,
      encrypted: await hybridEncrypt(plaintext, peerEncPublicKey, sealedPayloadAad(routing, peerPublicKey)),
    };
    const unsigned: UnsignedStreamEvent = {
      protocol: 'relationship-stream',
      schemaVersion: 1,
      ...routing,
      relationshipId: observed.descriptor.id,
      sequence: 0,
      previousEventHash: null,
      kind: 'action',
      createdAt,
      payload: sealed as unknown as CanonicalJson,
    };
    return signStreamEvent(unsigned, localIdentity.privateKey);
  }

  /** The plaintext envelope of a peer-written entry, or null when it cannot (or may not) be read. */
  private async openPayload(
    observed: ObservedChannel,
    event: StreamEvent,
    hash: string,
    previous: Map<string, CanonicalJson | null> | undefined,
    opened: Map<string, CanonicalJson | null>,
  ): Promise<CanonicalJson | null> {
    const sealed = parseSealed(event.payload);
    if (!sealed) return CHANNEL_PAYLOAD_POLICY.acceptPlaintext ? event.payload : null;
    if (previous?.has(hash)) {
      const cached = previous.get(hash) ?? null;
      opened.set(hash, cached);
      return cached;
    }
    const { localIdentity } = observed.relationship;
    let plaintext: CanonicalJson | null;
    try {
      plaintext = await hybridDecrypt<CanonicalJson>(sealed.encrypted, localIdentity.encPrivateKey, sealedPayloadAad(event, localIdentity.publicKey));
    } catch {
      plaintext = null;
    }
    opened.set(hash, plaintext);
    return plaintext;
  }

  private async scanObserved(observed: ObservedChannel): Promise<void> {
    if (this.channels.get(observed.share.channelId) !== observed) return;
    const doc = observed.room.doc;
    const accepted = await deriveAcceptedStreams(doc, observed.descriptor);
    const previous = openedPayloads.get(doc);
    const opened = new Map<string, CanonicalJson | null>();
    for (const stream of accepted.values()) {
      const event = stream.events[0];
      const hash = stream.hashes[0];
      if (!event || !hash || event.kind !== 'action') continue;
      // Our own entries are queue rows and acks we wrote, sealed to the peer —
      // nothing to process inbound (and nothing we could decrypt).
      if (event.signerPublicKey === observed.relationship.localIdentity.publicKey) continue;
      const payload = await this.openPayload(observed, event, hash, previous, opened);
      if (payload === null) continue;
      const ack = parseAck(payload);
      if (ack) {
        await this.processAck(observed, event, ack);
        continue;
      }
      const delivery = parseDelivery(payload);
      if (!delivery) continue;
      await this.processDelivery(observed, event, hash, delivery);
    }
    openedPayloads.set(doc, opened);
    this.pruneAckHistory(observed, accepted);
  }

  private async processAck(observed: ObservedChannel, event: StreamEvent, ack: ChannelBindingAckPayload): Promise<void> {
    if (event.signerPublicKey !== observed.relationship.peerPublicKey || ack.instanceId !== observed.share.instanceId) return;
    const serialized = observed.room.doc.getMap<string>(RELATIONSHIP_STREAM_EVENTS_MAP).get(ack.deliveryHash);
    if (!serialized) return;
    let deliveryEvent: StreamEvent;
    try { deliveryEvent = JSON.parse(serialized) as StreamEvent; } catch { return; }
    // Our own delivery is sealed to the peer, so it is matched by its signed
    // routing fields: every delivery is written with eventId = nonce under
    // `channel-binding-delivery:<nonce>` (the plaintext ones of earlier builds
    // too), and a channel carries exactly one share instance (checked above).
    if (!isPlainRecord(deliveryEvent)
      || deliveryEvent.kind !== 'action'
      || deliveryEvent.signerPublicKey !== observed.relationship.localIdentity.publicKey
      || deliveryEvent.eventId !== ack.deliveryNonce
      || deliveryEvent.streamId !== `${DELIVERY_STREAM_PREFIX}${ack.deliveryNonce}`
      || await hashStreamEvent(deliveryEvent) !== ack.deliveryHash) return;
    observed.room.doc.getMap(RELATIONSHIP_STREAM_EVENTS_MAP).delete(ack.deliveryHash);
  }

  private async processDelivery(
    observed: ObservedChannel,
    event: StreamEvent,
    deliveryHash: string,
    delivery: ChannelBindingDeliveryPayload,
  ): Promise<void> {
    const key = replayKey(observed.descriptor.id, event.signerPublicKey, delivery.nonce);
    const replay = this.rootDoc.getMap<string>(REPLAY_MAP);
    // Local outbound envelopes share the same Y.Doc; they are queue entries, not inbound actions.
    if (event.signerPublicKey === observed.relationship.localIdentity.publicKey) return;
    if (replay.has(key) || this.processing.has(key)) return;
    this.processing.add(key);
    try {
      let rejection: ChannelBindingRejection | null = null;
      if (observed.share.status !== 'active' || observed.descriptor.status !== 'active') {
        // Not a rejection: the ack window between the peer's accept and our own
        // activation must not burn the delivery. Leave it queued for the scan
        // that runs when the share flips active.
        return;
      }
      if (!reserveChannelReplayCapacity(replay, observed.descriptor.id, event.signerPublicKey, delivery.sentAt)) {
        rejection = 'replay-window-passed';
      } else if (event.signerPublicKey !== observed.relationship.peerPublicKey) rejection = 'wrong-peer';
      else if (delivery.instanceId !== observed.share.instanceId || observed.descriptor.sensitiveShareId !== delivery.instanceId) rejection = 'instance-mismatch';
      else if (!observed.share.eventIds.includes(delivery.eventId)) rejection = 'event-not-approved';
      else if (!observed.share.actionIds.includes(delivery.actionId)) rejection = 'action-not-approved';
      const manifest = this.dependencies.manifestFor(observed.share.dappId);
      const action = manifest ? declarationFor(manifest, 'actions', delivery.actionId) : null;
      const manifestShare = manifest?.channels?.shares?.find(({ id }) => id === observed.share.shareId);
      const route = manifestShare?.routes.find(({ eventId, actionId }) => eventId === delivery.eventId && actionId === delivery.actionId);
      if (!rejection && !action) rejection = 'action-not-declared';
      else if (!rejection && !manifestShare?.actions.includes(delivery.actionId)) rejection = 'action-not-in-current-share';
      else if (!rejection && !route) rejection = 'route-not-declared';
      const validated = action ? validatePayload(action.payload, delivery.payload) : null;
      if (!rejection && validated && !validated.ok) rejection = 'payload-invalid';
      if (rejection) {
        // A delivery behind the window gets no replay row: the high-water mark already covers it.
        await this.recordOutcome(observed, event, deliveryHash, delivery, 'rejected', rejection, rejection !== 'replay-window-passed');
        return;
      }
      const registered = this.actions.get(`${observed.share.dappId}\u0000${delivery.actionId}`);
      if (!registered || !validated?.ok) return;
      const from = await this.dependencies.contactFor(observed.share.dappId, observed.relationship, this.rootDoc);
      await registered.invoke({
        id: delivery.nonce,
        actionId: delivery.actionId,
        payload: validated.value,
        from,
        instanceId: observed.share.instanceId,
        channelId: observed.descriptor.id,
        relationshipId: observed.relationship.id,
      });
      await this.recordOutcome(observed, event, deliveryHash, delivery, 'delivered');
    } finally {
      this.processing.delete(key);
    }
  }

  private async recordOutcome(
    observed: ObservedChannel,
    event: StreamEvent,
    deliveryHash: string,
    delivery: ChannelBindingDeliveryPayload,
    outcome: 'delivered' | 'rejected',
    reason?: ChannelBindingRejection,
    persistReplay = true,
  ): Promise<void> {
    const processedAt = this.dependencies.now();
    const key = replayKey(observed.descriptor.id, event.signerPublicKey, delivery.nonce);
    const replay = this.rootDoc.getMap<string>(REPLAY_MAP);
    if (persistReplay) replay.set(key, JSON.stringify({ deliveryHash, outcome, processedAt, sentAt: delivery.sentAt }));
    if (reason) {
      const diagnostics = this.rootDoc.getMap<string>(DIAGNOSTICS_MAP);
      diagnostics.set(key, JSON.stringify({
        channelId: observed.descriptor.id,
        instanceId: observed.share.instanceId,
        actionId: delivery.actionId,
        nonce: delivery.nonce,
        deliveryHash,
        reason,
        recordedAt: processedAt,
      }));
      pruneChannelBindingMetadata(diagnostics, MAX_CHANNEL_DIAGNOSTICS);
    }
    await this.dependencies.checkpoint();
    const ack: ChannelBindingAckPayload = {
      protocol: CHANNEL_BINDING_PROTOCOL,
      schemaVersion: CHANNEL_BINDING_SCHEMA_VERSION,
      type: 'ack',
      instanceId: observed.share.instanceId,
      deliveryNonce: delivery.nonce,
      deliveryHash,
      outcome,
      ...(reason ? { reason } : {}),
      acknowledgedAt: processedAt,
    };
    const ackId = this.dependencies.randomUUID();
    const signed = await this.sealAndSign(observed, ackId, `${ACK_STREAM_PREFIX}${ackId}`, processedAt, ack as unknown as CanonicalJson);
    const result = await ingestStreamEvent(observed.room.doc, observed.descriptor, signed);
    if (result.status !== 'stored' && result.status !== 'duplicate') throw new Error('Channel acknowledgement was rejected');
  }

  private pruneAckHistory(observed: ObservedChannel, accepted: Awaited<ReturnType<typeof deriveAcceptedStreams>>): void {
    const acks: Array<{ hash: string; createdAt: string }> = [];
    accepted.forEach((stream) => {
      const event = stream.events[0];
      const hash = stream.hashes[0];
      // Recognised by the signed stream id: the acks we wrote are sealed to the peer.
      if (event && hash && event.kind === 'action' && event.streamId.startsWith(ACK_STREAM_PREFIX)) acks.push({ hash, createdAt: event.createdAt });
    });
    acks.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const map = observed.room.doc.getMap(RELATIONSHIP_STREAM_EVENTS_MAP);
    acks.slice(MAX_CHANNEL_ACK_HISTORY).forEach(({ hash }) => map.delete(hash));
  }
}

let globalRuntime: ChannelBindingRuntime | null = null;

export function getChannelBindingRuntime(): ChannelBindingRuntime {
  if (!globalRuntime) {
    globalRuntime = new ChannelBindingRuntime();
    void globalRuntime.initialize().catch((error: unknown) => console.error('Could not initialize channel binding runtime', error));
  }
  return globalRuntime;
}
