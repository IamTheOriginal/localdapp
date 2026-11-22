import * as Y from 'yjs';
import type {
  CanonicalJson, ChannelDescriptor, CodeAppBindingDeclaration, CodeAppManifestShareRoute, Relationship,
  RelationshipChannelControlMessage,
  RelationshipChannelPurgeAckPayload, RelationshipChannelPurgeRequestPayload,
  RelationshipChannelShareAckPayload, RelationshipChannelShareDeclinePayload, RelationshipChannelShareOfferPayload,
} from '../types.ts';
import {
  hashRelationshipControl, hybridDecrypt, hybridEncrypt, signRelationshipControl, verifyRelationshipControl, withoutSignature,
} from './relationshipProtocol.ts';
import { installChannelDescriptor, type ChannelTuple } from './store/channelRegistry.ts';
import { parseCodeAppManifest } from './codeAppManifest.ts';
import { verifyDefinitionBundle } from './store/definitionBundle.ts';

type PinnedRelationship = Relationship & { peerPublicKey: string; peerEncPublicKey: string; pairContextId: string };

export function relationshipChannelMessages(doc: Y.Doc): Y.Map<RelationshipChannelControlMessage> {
  return doc.getMap<RelationshipChannelControlMessage>('relationshipChannelControlMessages');
}

export function hashControlMessage(message: RelationshipChannelControlMessage): Promise<string> {
  return hashRelationshipControl(message as unknown as CanonicalJson);
}

function aad(value: Pick<RelationshipChannelControlMessage,
  'protocol' | 'schemaVersion' | 'messageId' | 'kind' | 'pairContextId' | 'senderPublicKey' | 'recipientPublicKey' | 'sequence' | 'previousMessageHash' | 'createdAt'>): CanonicalJson {
  return {
    protocol: value.protocol, schemaVersion: value.schemaVersion, messageId: value.messageId, kind: value.kind,
    pairContextId: value.pairContextId, senderPublicKey: value.senderPublicKey, recipientPublicKey: value.recipientPublicKey,
    sequence: value.sequence, previousMessageHash: value.previousMessageHash, createdAt: value.createdAt,
  };
}

function requirePinned(relationship: Relationship): asserts relationship is PinnedRelationship {
  if (relationship.status !== 'active' || !relationship.peerPublicKey || !relationship.peerEncPublicKey || !relationship.pairContextId) {
    throw new Error('channel control: Active relationship with pinned keys and context required');
  }
}

/** Both pinned relationship keys, sorted — the exact member set every channel between these two peers must carry. */
function pinnedPairKeys(relationship: PinnedRelationship): string[] {
  return [relationship.localIdentity.publicKey, relationship.peerPublicKey].sort();
}

function sameKeySet(keys: string[], expected: string[]): boolean {
  return [...new Set(keys)].sort().join(':') === expected.join(':');
}

function decryptPayload<T>(message: RelationshipChannelControlMessage, relationship: Relationship): Promise<T> {
  return hybridDecrypt<T>(message.encryptedPayload, relationship.localIdentity.encPrivateKey, aad(message));
}

interface ChainState { sequence: number; hash: string; }
interface ControlOutboxEntry {
  relationshipId: string;
  purposeId: string;
  message: RelationshipChannelControlMessage;
}
function chains(doc: Y.Doc): Y.Map<ChainState> { return doc.getMap<ChainState>('relationshipChannelControlChains'); }
function outbox(doc: Y.Doc): Y.Map<ControlOutboxEntry> { return doc.getMap<ControlOutboxEntry>('relationshipChannelControlOutbox'); }
function chainKey(relationship: Relationship, direction: 'sent' | 'received'): string {
  return JSON.stringify([relationship.pairContextId, relationship.localIdentity.publicKey, relationship.peerPublicKey, direction]);
}

const outgoingLocks = new WeakMap<Y.Doc, Map<string, Promise<void>>>();

export function listRelationshipControlOutbox(
  relationshipId: string,
  doc: Y.Doc,
): ControlOutboxEntry[] {
  return Array.from(outbox(doc).values()).filter((entry) => entry.relationshipId === relationshipId);
}

export function getRelationshipControlOutboxMessage(
  relationshipId: string,
  purposeId: string,
  doc: Y.Doc,
): RelationshipChannelControlMessage | null {
  return listRelationshipControlOutbox(relationshipId, doc).find((entry) => entry.purposeId === purposeId)?.message ?? null;
}

export function markRelationshipControlOutboxPersisted(messageIds: string[], doc: Y.Doc): void {
  const ids = new Set(messageIds);
  for (const [key, entry] of outbox(doc)) {
    if (ids.has(entry.message.messageId)) outbox(doc).delete(key);
  }
}

async function createMessage(
  relationship: Relationship,
  rootDoc: Y.Doc,
  kind: RelationshipChannelControlMessage['kind'],
  payload: CanonicalJson,
  purposeId: string,
  now: Date,
  commit?: (message: RelationshipChannelControlMessage, hash: string) => void,
): Promise<RelationshipChannelControlMessage> {
  requirePinned(relationship);
  const key = chainKey(relationship, 'sent');
  let locks = outgoingLocks.get(rootDoc);
  if (!locks) {
    locks = new Map();
    outgoingLocks.set(rootDoc, locks);
  }
  const previousWork = locks.get(key) ?? Promise.resolve();
  let resolveWork!: () => void;
  const currentWork = new Promise<void>((resolve) => { resolveWork = resolve; });
  locks.set(key, previousWork.catch(() => undefined).then(() => currentWork));
  await previousWork.catch(() => undefined);
  try {
    const previous = chains(rootDoc).get(key);
    const routing = {
      protocol: 'relationship-channel-control' as const, schemaVersion: 1 as const, messageId: crypto.randomUUID(), kind,
      correlationId: purposeId,
      pairContextId: relationship.pairContextId, senderPublicKey: relationship.localIdentity.publicKey,
      recipientPublicKey: relationship.peerPublicKey, sequence: previous ? previous.sequence + 1 : 0,
      previousMessageHash: previous?.hash ?? null, createdAt: now.toISOString(),
    };
    const base = { ...routing, encryptedPayload: await hybridEncrypt(payload, relationship.peerEncPublicKey, aad(routing)) };
    const message = { ...base, signature: await signRelationshipControl(base as unknown as CanonicalJson, relationship.localIdentity.privateKey) };
    const hash = await hashControlMessage(message);
    rootDoc.transact(() => {
      chains(rootDoc).set(key, { sequence: message.sequence, hash });
      outbox(rootDoc).set(message.messageId, Object.freeze({ relationshipId: relationship.id, purposeId, message }));
      commit?.(message, hash);
    }, 'relationship-control-outbox');
    return message;
  } finally {
    resolveWork();
  }
}

interface ValidatedIncoming { key: string; hash: string; sequence: number }

async function validateIncoming(
  message: RelationshipChannelControlMessage,
  expectedKind: RelationshipChannelControlMessage['kind'],
  relationship: Relationship,
  rootDoc: Y.Doc,
): Promise<ValidatedIncoming> {
  if (message.kind !== expectedKind || !await verifyRelationshipControlEnvelope(message, relationship)) {
    throw new Error('channel control: Wrong peer or invalid signed message');
  }
  const key = chainKey(relationship, 'received');
  const previous = chains(rootDoc).get(key);
  if (message.sequence !== (previous ? previous.sequence + 1 : 0) || message.previousMessageHash !== (previous?.hash ?? null)) {
    throw new Error('channel control: Replay or broken message chain rejected');
  }
  return { key, hash: await hashControlMessage(message), sequence: message.sequence };
}

/** Consumes the validated message's position on the received chain. */
function advanceReceivedChain(rootDoc: Y.Doc, validated: ValidatedIncoming): void {
  chains(rootDoc).set(validated.key, { sequence: validated.sequence, hash: validated.hash });
}

/**
 * Give up on a message that cannot be processed. The received chain is strict — message
 * n+1 is only accepted after message n — so ONE message that verifies but then fails for
 * good (a manifest this build cannot read, an offer over the size limit, a late response
 * whose offer is gone, an ack nobody waits for) used to block every later message from that
 * contact forever. When the message is genuinely the peer's next one (signature and chain
 * position check out), its position is consumed and the message dropped. Returns false for
 * anything else: a forged, replayed or out-of-order message never moves the chain.
 */
export async function consumeUnprocessableControlMessage(
  message: RelationshipChannelControlMessage,
  relationship: Relationship,
  rootDoc: Y.Doc,
): Promise<boolean> {
  try {
    advanceReceivedChain(rootDoc, await validateIncoming(message, message.kind, relationship, rootDoc));
    return true;
  } catch {
    return false;
  }
}

/** Verifies signed routing fields without consuming the relationship hash chain. */
export async function verifyRelationshipControlEnvelope(
  message: RelationshipChannelControlMessage,
  relationship: Relationship,
): Promise<boolean> {
  requirePinned(relationship);
  return message.protocol === 'relationship-channel-control' && message.schemaVersion === 1
    && message.pairContextId === relationship.pairContextId
    && message.senderPublicKey === relationship.peerPublicKey
    && message.recipientPublicKey === relationship.localIdentity.publicKey
    && await verifyRelationshipControl(withoutSignature(message), message.signature, relationship.peerPublicKey);
}

/** Verifies one of this device's previously signed control messages without consuming either chain. */
export async function verifyOutgoingRelationshipControlEnvelope(
  message: RelationshipChannelControlMessage,
  relationship: Relationship,
): Promise<boolean> {
  requirePinned(relationship);
  return message.protocol === 'relationship-channel-control' && message.schemaVersion === 1
    && message.pairContextId === relationship.pairContextId
    && message.senderPublicKey === relationship.localIdentity.publicKey
    && message.recipientPublicKey === relationship.peerPublicKey
    && await verifyRelationshipControl(withoutSignature(message), message.signature, relationship.localIdentity.publicKey);
}

// ───── Channel shares ($share.open) ─────
//
// A channel-share-offer never auto-installs the channel on receipt — the recipient must see
// what a Code App is asking to share before anything connects (invariant 15's "never
// pre-confirm a destructive action" applies to installs too). receiveChannelShareOffer still
// advances the received chain immediately — the chain is one shared, strictly-ordered sequence
// per relationship direction covering every message kind, so deferring it here would corrupt
// ordering for any other message (including an unrelated later channel-share-offer) from the
// same peer. Only the side effect — installing the channel descriptor — is deferred: that
// happens solely in acceptChannelShareOffer, once the user explicitly decides. Because the
// chain already advanced, a message that arrives twice (e.g. a rescan on reload) is rejected
// by validateIncoming as normal; src/services/store/pendingShareInvites.ts's
// findPendingShareInviteByOfferMessageId is a defensive second guard against staging it twice
// within the same process, not the primary replay defense.

export function isValidChannelShareOfferPayload(payload: unknown): payload is RelationshipChannelShareOfferPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const candidate = payload as Partial<RelationshipChannelShareOfferPayload>;
  if (candidate.protocol !== 'relationship-channel-share-offer' || candidate.schemaVersion !== 1
    || typeof candidate.offerId !== 'string' || !candidate.offerId
    || typeof candidate.dappId !== 'string' || !candidate.dappId
    || typeof candidate.shareId !== 'string' || !candidate.shareId
    || typeof candidate.shareLabel !== 'string' || !candidate.shareLabel
    || typeof candidate.instanceId !== 'string' || !candidate.instanceId
    || !candidate.dappMeta || typeof candidate.dappMeta.name !== 'string'
    || typeof candidate.dappMeta.icon !== 'string' || typeof candidate.dappMeta.color !== 'string'
    || !Array.isArray(candidate.events) || !Array.isArray(candidate.actions) || !Array.isArray(candidate.routes)
    || !candidate.channel || typeof candidate.channel.id !== 'string' || !candidate.channel.id
    || candidate.channel.schemaVersion !== 1 || typeof candidate.channel.roomId !== 'string' || !candidate.channel.roomId
    || typeof candidate.channel.roomPassword !== 'string' || !candidate.channel.roomPassword
    || !Array.isArray(candidate.channel.memberDeviceKeys) || typeof candidate.channel.createdAt !== 'string'
    || (candidate.definition !== undefined && (!candidate.definition || typeof candidate.definition !== 'object'
      || candidate.definition.protocol !== 'code-app-definition' || candidate.definition.schemaVersion !== 1))) return false;
  const parsed = parseCodeAppManifest(JSON.stringify({
    routes: [{ path: '/', label: 'Shared app' }],
    bindings: { events: candidate.events, actions: candidate.actions },
    channels: { shares: [{
      id: candidate.shareId,
      label: candidate.shareLabel,
      events: candidate.events.map((event) => event?.id),
      actions: candidate.actions.map((action) => action?.id),
      routes: candidate.routes,
    }] },
  }));
  return !parsed.error;
}

interface PreparedChannelShareOffer {
  offerId: string;
  channelId: string;
  instanceId: string;
  message: RelationshipChannelControlMessage;
  messageHash: string;
}

const MAX_CHANNEL_SHARE_CIPHERTEXT_CHARS = 12_000_000;

function assertChannelShareEnvelopeSize(message: RelationshipChannelControlMessage): void {
  if (message.encryptedPayload.ciphertext.length > MAX_CHANNEL_SHARE_CIPHERTEXT_CHARS) {
    throw new Error('channel control: Channel share offer is too large');
  }
}

export async function sendChannelShareOffer(options: {
  relationship: Relationship;
  descriptor: ChannelDescriptor;
  dappId: string;
  shareId: string;
  shareLabel: string;
  instanceId: string;
  dappMeta: { name: string; icon: string; color: string };
  events: CodeAppBindingDeclaration[];
  actions: CodeAppBindingDeclaration[];
  routes: CodeAppManifestShareRoute[];
  definition?: RelationshipChannelShareOfferPayload['definition'];
  rootDoc: Y.Doc;
  controlDoc: Y.Doc;
  now?: Date;
  /** Synchronous root-state commit run atomically with the signed outbox/hash-chain update. */
  beforePublish?: (prepared: PreparedChannelShareOffer) => void;
  /** Persists the combined root update before the offer is exposed in the shared control room. */
  persistBeforePublish?: () => Promise<void>;
}): Promise<PreparedChannelShareOffer> {
  requirePinned(options.relationship);
  const keys = [...new Set(options.descriptor.memberDeviceKeys)];
  if (!sameKeySet(keys, pinnedPairKeys(options.relationship))) {
    throw new Error('channel control: Share offer requires exactly the two pinned relationship keys');
  }
  const verifiedDefinition = options.definition ? await verifyDefinitionBundle(options.definition) : undefined;
  if (verifiedDefinition && verifiedDefinition.authorPublicKey !== options.relationship.localIdentity.publicKey) {
    throw new Error('channel control: Attached definition must be signed by this relationship identity');
  }
  const offerId = crypto.randomUUID();
  const payload: RelationshipChannelShareOfferPayload = {
    protocol: 'relationship-channel-share-offer', schemaVersion: 1, offerId,
    dappId: options.dappId, shareId: options.shareId, shareLabel: options.shareLabel, instanceId: options.instanceId,
    dappMeta: options.dappMeta, events: options.events, actions: options.actions, routes: options.routes,
    ...(verifiedDefinition ? { definition: verifiedDefinition } : {}),
    channel: {
      id: options.descriptor.id, schemaVersion: 1, roomId: options.descriptor.roomId,
      roomPassword: options.descriptor.roomPassword, memberDeviceKeys: keys, createdAt: options.descriptor.createdAt,
    },
  };
  const prepare = (message: RelationshipChannelControlMessage, messageHash: string): PreparedChannelShareOffer => ({
    offerId, channelId: options.descriptor.id, instanceId: options.instanceId, message, messageHash,
  });
  const message = await createMessage(
    options.relationship, options.rootDoc, 'channel-share-offer', payload as unknown as CanonicalJson, offerId, options.now ?? new Date(),
    (preparedMessage, messageHash) => options.beforePublish?.(prepare(preparedMessage, messageHash)),
  );
  const prepared = prepare(message, await hashControlMessage(message));
  await options.persistBeforePublish?.();
  relationshipChannelMessages(options.controlDoc).set(message.messageId, message);
  return prepared;
}

async function validateDecryptedChannelShareOffer(
  payload: unknown,
  relationship: Relationship,
): Promise<RelationshipChannelShareOfferPayload> {
  if (!isValidChannelShareOfferPayload(payload)) {
    throw new Error('channel control: Malformed channel share offer');
  }
  requirePinned(relationship);
  if (!sameKeySet(payload.channel.memberDeviceKeys, pinnedPairKeys(relationship))) {
    throw new Error('channel control: Share offer does not contain exactly the pinned relationship keys');
  }
  if (payload.definition) {
    payload.definition = await verifyDefinitionBundle(payload.definition);
    if (payload.definition.authorPublicKey !== relationship.peerPublicKey) {
      throw new Error('channel control: Attached definition signer does not match the relationship sender');
    }
  }
  return payload;
}

/** Decrypts, validates, and consumes a newly received share offer's chain position without installing anything. */
export async function receiveChannelShareOffer(options: {
  message: RelationshipChannelControlMessage;
  relationship: Relationship;
  rootDoc: Y.Doc;
}): Promise<{ payload: RelationshipChannelShareOfferPayload; messageHash: string }> {
  assertChannelShareEnvelopeSize(options.message);
  const validated = await validateIncoming(options.message, 'channel-share-offer', options.relationship, options.rootDoc);
  const payload = await validateDecryptedChannelShareOffer(await decryptPayload<unknown>(options.message, options.relationship), options.relationship);
  advanceReceivedChain(options.rootDoc, validated);
  return { payload, messageHash: validated.hash };
}

/** Re-derives a staged offer from the original signed message without consuming its chain again. */
export async function inspectChannelShareOffer(options: {
  message: RelationshipChannelControlMessage;
  relationship: Relationship;
}): Promise<{ payload: RelationshipChannelShareOfferPayload; messageHash: string }> {
  assertChannelShareEnvelopeSize(options.message);
  if (options.message.kind !== 'channel-share-offer'
    || !await verifyRelationshipControlEnvelope(options.message, options.relationship)) {
    throw new Error('channel control: Invalid staged channel share offer');
  }
  return {
    payload: await validateDecryptedChannelShareOffer(await decryptPayload<unknown>(options.message, options.relationship), options.relationship),
    messageHash: await hashControlMessage(options.message),
  };
}

/** Installs the channel — call only once the user accepts. The received chain already advanced in receiveChannelShareOffer. */
export async function acceptChannelShareOffer(options: {
  offerMessage: RelationshipChannelControlMessage;
  offerPayload: RelationshipChannelShareOfferPayload;
  offerMessageHash: string;
  localDappId: string;
  relationship: Relationship;
  rootDoc: Y.Doc;
  controlDoc: Y.Doc;
  now?: Date;
}): Promise<{ descriptor: ChannelDescriptor; ack: RelationshipChannelControlMessage }> {
  requirePinned(options.relationship);
  const expectedKeys = [options.relationship.localIdentity.publicKey, options.relationship.peerPublicKey];
  const now = options.now ?? new Date();
  const tuple: ChannelTuple = { relationshipId: options.relationship.id, dappId: options.localDappId, sensitiveShareId: options.offerPayload.instanceId };
  const descriptor: ChannelDescriptor = {
    ...options.offerPayload.channel, relationshipId: options.relationship.id, dappId: options.localDappId,
    sensitiveShareId: options.offerPayload.instanceId, persistenceKey: `relationship-channel-v1-${options.offerPayload.channel.id}`,
    controlOfferMessageId: options.offerMessage.messageId,
    memberDeviceKeys: expectedKeys, status: 'active', updatedAt: now.toISOString(),
  };
  const installed = installChannelDescriptor(tuple, descriptor, options.rootDoc);
  const ackPayload: RelationshipChannelShareAckPayload = {
    protocol: 'relationship-channel-share-ack', schemaVersion: 1, offerId: options.offerPayload.offerId,
    channelId: options.offerPayload.channel.id, offerMessageHash: options.offerMessageHash, acceptedAt: now.toISOString(),
  };
  const ack = await createMessage(
    options.relationship, options.rootDoc, 'channel-share-ack', ackPayload as unknown as CanonicalJson, `share-ack:${options.offerPayload.offerId}`, now,
  );
  relationshipChannelMessages(options.controlDoc).set(ack.messageId, ack);
  return { descriptor: installed, ack };
}

/** Tells the sender no channel will be installed — call only once the user declines. The received chain already advanced in receiveChannelShareOffer. */
export async function declineChannelShareOffer(options: {
  offerMessage: RelationshipChannelControlMessage;
  offerPayload: RelationshipChannelShareOfferPayload;
  offerMessageHash: string;
  relationship: Relationship;
  rootDoc: Y.Doc;
  controlDoc: Y.Doc;
  now?: Date;
}): Promise<RelationshipChannelControlMessage> {
  requirePinned(options.relationship);
  const now = options.now ?? new Date();
  const declinePayload: RelationshipChannelShareDeclinePayload = {
    protocol: 'relationship-channel-share-decline', schemaVersion: 1, offerId: options.offerPayload.offerId,
    offerMessageHash: options.offerMessageHash, declinedAt: now.toISOString(),
  };
  const decline = await createMessage(
    options.relationship, options.rootDoc, 'channel-share-decline', declinePayload as unknown as CanonicalJson, `share-decline:${options.offerPayload.offerId}`, now,
  );
  relationshipChannelMessages(options.controlDoc).set(decline.messageId, decline);
  return decline;
}

export type ChannelShareResponseOutcome =
  | { kind: 'accepted'; payload: RelationshipChannelShareAckPayload }
  | { kind: 'declined'; payload: RelationshipChannelShareDeclinePayload };

/**
 * Sender side: consumes the recipient's signed share ack or decline. The caller supplies the
 * id and hash of the immutable original offer (from the control room or the staged copy), so
 * this works both for a live waiter and for a response that arrives after a reload/timeout.
 */
export async function receiveChannelShareResponse(options: {
  message: RelationshipChannelControlMessage;
  relationship: Relationship;
  rootDoc: Y.Doc;
  expectedOfferId: string;
  expectedOfferMessageHash: string;
  /** Runs inside the same root-doc transaction that advances the received chain. Must be synchronous. */
  onConsumed?: (outcome: ChannelShareResponseOutcome) => void;
}): Promise<ChannelShareResponseOutcome> {
  const kind = options.message.kind;
  if (kind !== 'channel-share-ack' && kind !== 'channel-share-decline') {
    throw new Error('channel control: Expected a channel share response');
  }
  const validated = await validateIncoming(options.message, kind, options.relationship, options.rootDoc);
  const payload = await decryptPayload<RelationshipChannelShareAckPayload | RelationshipChannelShareDeclinePayload>(options.message, options.relationship);
  const accepted = kind === 'channel-share-ack';
  const label = accepted ? 'ack' : 'decline';
  if (payload.protocol !== `relationship-channel-share-${label}` || payload.schemaVersion !== 1
    || payload.offerId !== options.expectedOfferId || payload.offerMessageHash !== options.expectedOfferMessageHash
    || options.message.correlationId !== `share-${label}:${payload.offerId}`
    || (accepted && !(payload as RelationshipChannelShareAckPayload).channelId)) {
    throw new Error(`channel control: Late share ${label} does not match its original offer`);
  }
  const outcome: ChannelShareResponseOutcome = accepted
    ? { kind: 'accepted', payload: payload as RelationshipChannelShareAckPayload }
    : { kind: 'declined', payload: payload as RelationshipChannelShareDeclinePayload };
  options.rootDoc.transact(() => {
    advanceReceivedChain(options.rootDoc, validated);
    options.onConsumed?.(outcome);
  }, 'relationship-share-response-consumed');
  return outcome;
}

export interface PreparedChannelPurge {
  requestId: string;
  channelId: string;
  reason: RelationshipChannelPurgeRequestPayload['reason'];
  message: RelationshipChannelControlMessage;
  messageHash: string;
}

export async function sendChannelPurgeRequest(options: {
  relationship: Relationship;
  channelId: string;
  reason: RelationshipChannelPurgeRequestPayload['reason'];
  rootDoc: Y.Doc;
  controlDoc: Y.Doc;
  now?: Date;
  publish?: boolean;
  requestId?: string;
}): Promise<PreparedChannelPurge> {
  requirePinned(options.relationship);
  if (!options.channelId) throw new Error('channel control: Purge channel is required');
  const now = options.now ?? new Date();
  const requestId = options.requestId ?? crypto.randomUUID();
  const payload: RelationshipChannelPurgeRequestPayload = {
    protocol: 'relationship-channel-purge-request', schemaVersion: 1, requestId,
    channelId: options.channelId, reason: options.reason, requestedAt: now.toISOString(),
  };
  const message = await createMessage(
    options.relationship, options.rootDoc, 'channel-purge-request', payload as unknown as CanonicalJson, requestId, now,
  );
  if (options.publish !== false) relationshipChannelMessages(options.controlDoc).set(message.messageId, message);
  return {
    requestId, channelId: options.channelId, reason: options.reason, message,
    messageHash: await hashControlMessage(message),
  };
}

export async function receiveChannelPurgeRequest(options: {
  message: RelationshipChannelControlMessage;
  relationship: Relationship;
  rootDoc: Y.Doc;
  controlDoc: Y.Doc;
  purgeLocal: (channelId: string) => Promise<void>;
  now?: Date;
}): Promise<{ payload: RelationshipChannelPurgeRequestPayload; ack: RelationshipChannelControlMessage; requestMessageHash: string }> {
  const validated = await validateIncoming(options.message, 'channel-purge-request', options.relationship, options.rootDoc);
  const payload = await decryptPayload<RelationshipChannelPurgeRequestPayload>(options.message, options.relationship);
  if (payload.protocol !== 'relationship-channel-purge-request' || payload.schemaVersion !== 1
    || !payload.requestId || !payload.channelId || !['grant-revoked', 'dapp-deleted'].includes(payload.reason)) {
    throw new Error('channel control: Malformed purge request');
  }
  await options.purgeLocal(payload.channelId);
  const now = options.now ?? new Date();
  const ackPayload: RelationshipChannelPurgeAckPayload = {
    protocol: 'relationship-channel-purge-ack', schemaVersion: 1, requestId: payload.requestId,
    channelId: payload.channelId, requestMessageHash: validated.hash, purgedAt: now.toISOString(),
  };
  const ack = await createMessage(
    options.relationship, options.rootDoc, 'channel-purge-ack', ackPayload as unknown as CanonicalJson, `purge-ack:${payload.requestId}`, now,
  );
  advanceReceivedChain(options.rootDoc, validated);
  relationshipChannelMessages(options.controlDoc).set(ack.messageId, ack);
  return { payload, ack, requestMessageHash: validated.hash };
}

export async function receiveChannelPurgeAck(options: {
  message: RelationshipChannelControlMessage;
  relationship: Relationship;
  rootDoc: Y.Doc;
  pending: PreparedChannelPurge;
}): Promise<RelationshipChannelPurgeAckPayload> {
  const validated = await validateIncoming(options.message, 'channel-purge-ack', options.relationship, options.rootDoc);
  const payload = await decryptPayload<RelationshipChannelPurgeAckPayload>(options.message, options.relationship);
  if (payload.protocol !== 'relationship-channel-purge-ack' || payload.schemaVersion !== 1
    || payload.requestId !== options.pending.requestId || payload.channelId !== options.pending.channelId
    || payload.requestMessageHash !== options.pending.messageHash) {
    throw new Error('channel control: Purge ack does not match pending request');
  }
  advanceReceivedChain(options.rootDoc, validated);
  return payload;
}
