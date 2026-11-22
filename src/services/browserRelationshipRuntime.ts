import type {
  ChannelDescriptor, ChannelShare, CodeAppBindingDeclaration, CodeAppManifestShareRoute, PendingRemotePurge, PendingShareInvite, Relationship,
  RelationshipChannelControlMessage, RelationshipChannelShareOfferPayload, RemotePurgeIntent,
} from '../types.ts';
import { createPerson, deletePerson, getPerson, updatePerson } from './store/people.ts';
import { getIdentity } from './identity.ts';
import { createRelationship, deleteRelationship, getRelationship, getRelationshipControlCapability, listRelationships, removeRelationshipControlCapability } from './store/relationships.ts';
import { compactRootPersistence, getRootDoc, getRootPersistence } from './store/docs.ts';
import {
  activateChannelDescriptor, admitChannelDevice, getChannelDescriptor, getChannelDescriptorById, listChannelDescriptors,
  registerChannelDescriptor, setChannelControlOfferMessage, type ChannelTuple,
} from './store/channelRegistry.ts';
import {
  createChannelShare as createChannelShareRecord, getChannelShareById, listAllChannelShares, listChannelSharesByInstance,
  removeChannelShare, setChannelShareStatus,
} from './store/channelShares.ts';
import {
  createPendingShareInvite, declinePendingShareInvitesByChannel, findPendingShareInviteByOfferMessageId, getPendingShareInvite,
  listPendingShareInvites, setPendingShareInviteStatus,
} from './store/pendingShareInvites.ts';
import { createRelationshipIdentity } from './relationshipIdentity.ts';
import { parseCodeAppManifest } from './codeAppManifest.ts';
import { isShareInviteCompatible } from './shareCompatibility.ts';
import { getCodeAppFile } from './store/source.ts';
import { exportDefinitionBundle, importDefinitionBundle } from './store/definitionBundle.ts';
import {
  createBrowserRelationshipPairingRoomManager,
  type RelationshipPairingRoomHandle,
} from './relationshipPairingRoomManager.ts';
import { RelationshipPairingRuntime, type CompletedRelationshipPairing, type RelationshipPairingRequestInfo } from './relationshipPairingRuntime.ts';
import { deriveRelationshipSafetyNumber } from './relationshipProtocol.ts';
import {
  acceptChannelShareOffer, declineChannelShareOffer, getRelationshipControlOutboxMessage, hashControlMessage,
  inspectChannelShareOffer, listRelationshipControlOutbox, markRelationshipControlOutboxPersisted,
  consumeUnprocessableControlMessage, receiveChannelPurgeAck, receiveChannelPurgeRequest, receiveChannelShareOffer, receiveChannelShareResponse,
  relationshipChannelMessages, sendChannelPurgeRequest, sendChannelShareOffer, verifyOutgoingRelationshipControlEnvelope,
  type ChannelShareResponseOutcome, type PreparedChannelPurge,
} from './relationshipChannelControl.ts';
import { openRelationshipChannel, purgeRelationshipChannelLocal } from './sharingRuntime.ts';
import {
  acknowledgeRemotePurge, enqueueRemotePurge, getProcessedRemotePurge, listPendingRemotePurges,
  listRemotePurgeIntents, persistRemotePurgeIntent, recordProcessedRemotePurge, recordRemotePurgeAttempt,
  recordRemotePurgeIntentFailure, removeRemotePurgeIntent, removeRemotePurgesForRelationship,
} from './store/remotePurgeQueue.ts';

const rootDoc = getRootDoc();
const rooms = createBrowserRelationshipPairingRoomManager();
const pairing = new RelationshipPairingRuntime({ rootDoc, rooms });
const processing = new Set<string>();
/** Message id → failed processing attempts this session (see the catch in processIncomingMessage). */
const failedAttempts = new Map<string, number>();
const MAX_CONTROL_MESSAGE_ATTEMPTS = 3;
const activelyAwaitedShareOffers = new Map<string, {
  response: Promise<RelationshipChannelControlMessage>;
  finish: (message: RelationshipChannelControlMessage) => void;
}>();
const outgoingShareCreations = new Set<string>();
const channelOperationTails = new Map<string, Promise<void>>();
const observedControls = new Map<string, () => void>();

interface ProcessedShareResponse {
  relationshipId: string;
  offerId: string;
  messageHash: string;
  outcome: ChannelShareResponseOutcome;
}
function processedShareResponses() {
  return rootDoc.getMap<ProcessedShareResponse>('processedChannelShareResponses');
}

/**
 * Durable copy of this device's signed share offers, keyed by offerId. The control-room
 * message map is shared state that can lose entries (remote compaction, storage eviction);
 * the late-response path must still be able to verify an ack against the original offer.
 */
function stagedShareOffers() {
  return rootDoc.getMap<{ relationshipId: string; message: RelationshipChannelControlMessage }>('stagedChannelShareOffers');
}

function registerAwaitedShareOffer(offerId: string) {
  let finish!: (message: RelationshipChannelControlMessage) => void;
  const response = new Promise<RelationshipChannelControlMessage>((resolve) => { finish = resolve; });
  const waiter = { response, finish };
  activelyAwaitedShareOffers.set(offerId, waiter);
  return waiter;
}

async function withChannelOperation<T>(relationshipId: string, channelId: string, task: () => Promise<T>): Promise<T> {
  const key = `${relationshipId}:${channelId}`;
  const previous = channelOperationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  channelOperationTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (channelOperationTails.get(key) === tail) channelOperationTails.delete(key);
  }
}

interface HostedPairing {
  relationshipId: string;
  inviteId: string;
  uri: string;
  lobby: RelationshipPairingRoomHandle;
}

function requireRelationship(id: string): Relationship {
  const relationship = getRelationship(id, rootDoc);
  if (!relationship) throw new Error('relationship runtime: Unknown relationship');
  return relationship;
}

function openControl(relationship: Relationship): RelationshipPairingRoomHandle {
  const capability = getRelationshipControlCapability(relationship.id, rootDoc);
  if (!capability) throw new Error('relationship runtime: Control capability is unavailable');
  const room = rooms.openControl(capability, relationship.localIdentity.publicKey);
  rooms.connect(room.descriptor.id);
  return room;
}

function isUnknownChannelError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Unknown channel');
}

async function flushRelationshipControlOutbox(
  relationship: Relationship,
  control: RelationshipPairingRoomHandle,
): Promise<void> {
  const entries = listRelationshipControlOutbox(relationship.id, rootDoc);
  if (entries.length === 0) return;
  const messages = relationshipChannelMessages(control.doc);
  control.doc.transact(() => {
    for (const entry of entries) messages.set(entry.message.messageId, entry.message);
  }, 'flush-relationship-control-outbox');
  await rooms.compact(control.descriptor.id);
  markRelationshipControlOutboxPersisted(entries.map((entry) => entry.message.messageId), rootDoc);
  await compactRootPersistence();
}

async function removeCredentialOffersFromControl(
  control: RelationshipPairingRoomHandle,
  offerMessageIds: Iterable<string | undefined>,
): Promise<void> {
  const ids = [...new Set([...offerMessageIds].filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return;
  const messages = relationshipChannelMessages(control.doc);
  control.doc.transact(() => {
    for (const id of ids) messages.delete(id);
  }, 'remove-relationship-credential-offers');
  await rooms.compact(control.descriptor.id);
}

async function processIncomingPurgeAck(
  relationship: Relationship,
  control: RelationshipPairingRoomHandle,
  message: RelationshipChannelControlMessage,
): Promise<void> {
  const candidates = listPendingRemotePurges(rootDoc).filter((pending) => pending.relationshipId === relationship.id);
  if (candidates.length === 0) throw new Error('relationship runtime: Purge acknowledgement has no queued request');
  let lastError: unknown = null;
  for (const pending of candidates) {
    const prepared: PreparedChannelPurge = {
      requestId: pending.requestId,
      channelId: pending.channelId,
      reason: pending.reason,
      message: pending.requestMessage,
      messageHash: pending.requestMessageHash,
    };
    try {
      const ack = await receiveChannelPurgeAck({ message, relationship, rootDoc, pending: prepared });
      await removeCredentialOffersFromControl(control, [pending.controlOfferMessageId]);
      acknowledgeRemotePurge(pending.requestId, ack.purgedAt, rootDoc);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function processShareResponse(
  relationship: Relationship,
  control: RelationshipPairingRoomHandle,
  message: RelationshipChannelControlMessage,
): Promise<void> {
  const prefix = message.kind === 'channel-share-ack' ? 'share-ack:' : 'share-decline:';
  const correlationId = message.correlationId;
  if (!correlationId?.startsWith(prefix)) throw new Error('relationship runtime: Malformed share response correlation');
  const offerId = correlationId.slice(prefix.length);
  const activeWaiter = activelyAwaitedShareOffers.get(offerId);
  const messageHash = await hashControlMessage(message);
  const processed = processedShareResponses().get(message.messageId);
  let outcome: ChannelShareResponseOutcome;
  if (processed) {
    if (processed.relationshipId !== relationship.id || processed.offerId !== offerId || processed.messageHash !== messageHash) {
      throw new Error('relationship runtime: Processed share response does not match this signed envelope');
    }
    outcome = processed.outcome;
  } else {
    const staged = stagedShareOffers().get(offerId);
    const originalOffer = Array.from(relationshipChannelMessages(control.doc).values()).find((candidate) =>
      candidate.kind === 'channel-share-offer' && candidate.correlationId === offerId
      && candidate.senderPublicKey === relationship.localIdentity.publicKey
      && candidate.recipientPublicKey === relationship.peerPublicKey)
      ?? (staged?.relationshipId === relationship.id ? staged.message : undefined);
    if (!originalOffer || !await verifyOutgoingRelationshipControlEnvelope(originalOffer, relationship)) {
      throw new Error('relationship runtime: Late share response has no valid original signed offer');
    }
    outcome = await receiveChannelShareResponse({
      message, relationship, rootDoc, expectedOfferId: offerId, expectedOfferMessageHash: await hashControlMessage(originalOffer),
      onConsumed: (consumedOutcome) => {
        processedShareResponses().set(message.messageId, { relationshipId: relationship.id, offerId, messageHash, outcome: consumedOutcome });
      },
    });
    // The response is consumed — the staged offer copy has served its purpose.
    if (staged) stagedShareOffers().delete(offerId);
    await compactRootPersistence();
  }
  if (activeWaiter) {
    activeWaiter.finish(message);
    return;
  }
  const share = listAllChannelShares(rootDoc).find((candidate) => candidate.relationshipId === relationship.id
    && candidate.offerId === offerId && candidate.status === 'pending');
  if (share) {
    await withChannelOperation(share.relationshipId, share.channelId, async () => {
      const current = getChannelShareById(share.id, rootDoc);
      if (!current || current.status !== 'pending') return;
      if (outcome.kind === 'accepted' && outcome.payload.channelId === current.channelId) {
        const descriptor = getChannelDescriptorById(current.channelId, rootDoc);
        if (descriptor && descriptor.status !== 'revoked' && descriptor.relationshipId === relationship.id) {
          activateChannelDescriptor({
            relationshipId: descriptor.relationshipId, dappId: descriptor.dappId, sensitiveShareId: descriptor.sensitiveShareId,
          }, rootDoc);
          setChannelShareStatus(current.id, 'active', rootDoc);
        }
      } else if (outcome.kind === 'declined') {
        await removeChannelShareLocally(current);
      }
    });
  }
  await compactRootPersistence();
}

async function processIncomingPurgeRequest(
  relationship: Relationship,
  control: RelationshipPairingRoomHandle,
  message: RelationshipChannelControlMessage,
): Promise<void> {
  const messageHash = await hashControlMessage(message);
  const processed = getProcessedRemotePurge(messageHash, rootDoc);
  if (processed) {
    relationshipChannelMessages(control.doc).set(processed.ackMessage.messageId, processed.ackMessage);
    return;
  }
  const result = await receiveChannelPurgeRequest({
    message,
    relationship,
    rootDoc,
    controlDoc: control.doc,
    purgeLocal: async (channelId) => withChannelOperation(relationship.id, channelId, async () => {
      const channel = getChannelDescriptorById(channelId, rootDoc);
      const matchingInvites = listPendingShareInvites(rootDoc).filter((invite) =>
        invite.relationshipId === relationship.id && invite.channel.id === channelId);
      const matchingShares = listAllChannelShares(rootDoc).filter((share) =>
        share.channelId === channelId && share.relationshipId === relationship.id);
      declinePendingShareInvitesByChannel(relationship.id, channelId, rootDoc);
      try {
        await purgeRelationshipChannelLocal(channelId, relationship.id, rootDoc);
      } catch (error) {
        // A channel this device does not know is already gone here — that IS the purged state.
        // Failing instead left the request unanswered: the sender retried every 30 s for ever.
        if (!isUnknownChannelError(error)) throw error;
      }
      await removeCredentialOffersFromControl(control, [
        channel?.controlOfferMessageId,
        ...matchingInvites.map((invite) => invite.offerMessageId),
        ...matchingShares.map((share) => share.controlOfferMessageId),
      ]);
      for (const share of matchingShares) {
        if (share.offerId) stagedShareOffers().delete(share.offerId);
        removeChannelShare(share.id, rootDoc);
      }
      await compactRootPersistence();
    }),
  });
  recordProcessedRemotePurge({
    schemaVersion: 1,
    requestId: result.payload.requestId,
    requestMessageHash: result.requestMessageHash,
    channelId: result.payload.channelId,
    relationshipId: relationship.id,
    ackMessage: result.ack,
    purgedAt: new Date().toISOString(),
  }, rootDoc);
}

async function processIncomingMessage(
  relationship: Relationship,
  control: RelationshipPairingRoomHandle,
  message: RelationshipChannelControlMessage,
): Promise<void> {
  if (message.recipientPublicKey !== relationship.localIdentity.publicKey || processing.has(message.messageId)) return;
  processing.add(message.messageId);
  try {
    if (message.kind === 'channel-purge-request') {
      await processIncomingPurgeRequest(relationship, control, message);
    } else if (message.kind === 'channel-purge-ack') {
      await processIncomingPurgeAck(relationship, control, message);
    } else if (message.kind === 'channel-share-ack' || message.kind === 'channel-share-decline') {
      await processShareResponse(relationship, control, message);
    } else if (message.kind === 'channel-share-offer') {
      // Stage only — never auto-install. See relationshipChannelControl.ts's channel-share note.
      if (findPendingShareInviteByOfferMessageId(message.messageId, rootDoc)) return;
      const { payload, messageHash } = await receiveChannelShareOffer({ message, relationship, rootDoc });
      createPendingShareInvite({
        relationshipId: relationship.id,
        dappId: payload.dappId,
        shareId: payload.shareId,
        shareLabel: payload.shareLabel,
        instanceId: payload.instanceId,
        offerId: payload.offerId,
        dappMeta: payload.dappMeta,
        events: payload.events,
        actions: payload.actions,
        routes: payload.routes,
        definition: payload.definition,
        channel: payload.channel,
        offerMessageId: message.messageId,
        offerMessageHash: messageHash,
      }, rootDoc);
    } else {
      return;
    }
    await flushRelationshipControlOutbox(relationship, control);
  } catch (error) {
    processing.delete(message.messageId);
    console.error('Could not process relationship channel control message', error);
    // Retried on the next scans (a storage hiccup passes); a message that keeps failing is
    // consumed, or it would block every later message from this contact for good.
    const failures = (failedAttempts.get(message.messageId) ?? 0) + 1;
    failedAttempts.set(message.messageId, failures);
    if (failures >= MAX_CONTROL_MESSAGE_ATTEMPTS) {
      failedAttempts.delete(message.messageId);
      if (await consumeUnprocessableControlMessage(message, relationship, rootDoc).catch(() => false)) {
        console.warn(`Dropped a ${message.kind} message from a contact after ${failures} failed attempts — later messages are processed again`);
        await compactRootPersistence().catch(() => undefined);
      }
    }
  }
}

export function ensureRelationshipControl(relationshipId: string): RelationshipPairingRoomHandle {
  const relationship = requireRelationship(relationshipId);
  const control = openControl(relationship);
  if (!observedControls.has(relationship.id)) {
    const messages = relationshipChannelMessages(control.doc);
    let scanQueue = Promise.resolve();
    const scan = () => {
      scanQueue = scanQueue.then(async () => {
        const incoming = Array.from(messages.values())
          .filter((message) => message.recipientPublicKey === relationship.localIdentity.publicKey)
          .sort((left, right) => left.sequence - right.sequence);
        for (const message of incoming) await processIncomingMessage(relationship, control, message);
      }).catch((error: unknown) => console.error('Could not scan relationship control messages', error));
    };
    messages.observe(scan);
    observedControls.set(relationship.id, () => messages.unobserve(scan));
    void control.persistenceReady.then(async () => {
      await flushRelationshipControlOutbox(relationship, control);
      scan();
    });
  }
  return control;
}

function stopObservingControl(relationshipId: string): void {
  observedControls.get(relationshipId)?.();
  observedControls.delete(relationshipId);
}

export async function queueRemoteChannelPurge(
  descriptor: Pick<ChannelDescriptor, 'id' | 'relationshipId' | 'controlOfferMessageId'>,
  reason: PendingRemotePurge['reason'],
  existingIntent?: RemotePurgeIntent,
): Promise<PendingRemotePurge> {
  const knownChannel = getChannelDescriptorById(descriptor.id, rootDoc);
  const controlOfferMessageId = existingIntent?.controlOfferMessageId
    ?? descriptor.controlOfferMessageId ?? knownChannel?.controlOfferMessageId;
  const intent = existingIntent ?? persistRemotePurgeIntent({
    relationshipId: descriptor.relationshipId, channelId: descriptor.id, controlOfferMessageId, reason,
  }, rootDoc);
  try {
    const relationship = requireRelationship(descriptor.relationshipId);
    const control = ensureRelationshipControl(relationship.id);
    await control.persistenceReady;
    const alreadyQueued = listPendingRemotePurges(rootDoc).find((pending) =>
      pending.relationshipId === descriptor.relationshipId && pending.channelId === descriptor.id && pending.reason === reason);
    if (alreadyQueued) {
      relationshipChannelMessages(control.doc).set(alreadyQueued.requestMessage.messageId, alreadyQueued.requestMessage);
      await rooms.compact(control.descriptor.id);
      removeRemotePurgeIntent(intent.intentId, rootDoc);
      return alreadyQueued;
    }
    const recoveredMessage = getRelationshipControlOutboxMessage(relationship.id, intent.intentId, rootDoc);
    const prepared = recoveredMessage
      ? {
          requestId: intent.intentId, channelId: descriptor.id, reason,
          message: recoveredMessage,
          messageHash: await hashControlMessage(recoveredMessage),
        }
      : await sendChannelPurgeRequest({
          relationship,
          channelId: descriptor.id,
          reason,
          rootDoc,
          controlDoc: control.doc,
          publish: false,
          requestId: intent.intentId,
        });
    const queued = enqueueRemotePurge({
      requestId: prepared.requestId,
      relationshipId: relationship.id,
      channelId: prepared.channelId,
      controlOfferMessageId,
      reason: prepared.reason,
      requestMessage: prepared.message,
      requestMessageHash: prepared.messageHash,
    }, rootDoc);
    recordRemotePurgeAttempt(queued.requestId, rootDoc);
    await flushRelationshipControlOutbox(relationship, control);
    removeRemotePurgeIntent(intent.intentId, rootDoc);
    return queued;
  } catch (error) {
    recordRemotePurgeIntentFailure(intent.intentId, error, rootDoc);
    throw error;
  }
}

async function retryPendingRemotePurges(): Promise<void> {
  for (const intent of listRemotePurgeIntents(rootDoc)) {
    try {
      await queueRemoteChannelPurge(
        { id: intent.channelId, relationshipId: intent.relationshipId }, intent.reason, intent,
      );
    } catch (error) {
      console.error('Could not prepare remote channel purge intent', error);
    }
  }
  for (const pending of listPendingRemotePurges(rootDoc)) {
    try {
      const relationship = requireRelationship(pending.relationshipId);
      const control = ensureRelationshipControl(relationship.id);
      await control.persistenceReady;
      relationshipChannelMessages(control.doc).set(pending.requestMessage.messageId, pending.requestMessage);
      await rooms.compact(control.descriptor.id);
      recordRemotePurgeAttempt(pending.requestId, rootDoc);
      // Existing acknowledgements are scanned when the control room is opened/restored.
    } catch (error) {
      console.error('Could not retry remote channel purge', error);
    }
  }
}

let purgeRetryTimer: number | null = null;
let rootRelationshipObserversInstalled = false;

function scanActiveRelationshipControls(): void {
  for (const relationship of listRelationships(rootDoc)) {
    if (relationship.status === 'active' && relationship.controlCapabilityId) {
      try { ensureRelationshipControl(relationship.id); } catch (error) { console.error('Could not open relationship control room', error); }
    }
  }
}

/** Long-lived invites make onboarding asynchronous: send the code today, pair whenever the other side gets to it. */
const PAIRING_INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** Placeholder until the peer's signed, self-asserted name arrives with the pairing handshake. */
const PENDING_CONTACT_NAME = 'New contact';

function myPairingDisplayName(): string {
  try {
    return getIdentity()?.displayName?.trim() || 'Unknown';
  } catch {
    return 'Unknown';
  }
}

/**
 * Names the person after the peer's announced name — but only while the card
 * still carries the placeholder, so a name the user typed or edited wins.
 */
function adoptPeerDisplayName(relationshipId: string, peerDisplayName: string | undefined): void {
  const trimmed = (peerDisplayName ?? '').trim();
  if (!trimmed) return;
  try {
    const relationship = getRelationship(relationshipId, rootDoc);
    if (!relationship) return;
    const person = getPerson(relationship.personId, rootDoc);
    if (!person || person.displayName !== PENDING_CONTACT_NAME) return;
    updatePerson(relationship.personId, { displayName: trimmed }, rootDoc);
  } catch (error) {
    console.error('Could not adopt the paired contact name', error);
  }
}

/** Shared tail of every successful pairing: name the contact, then bring up its control room. */
function onPairingCompleted(result: CompletedRelationshipPairing): void {
  adoptPeerDisplayName(result.relationship.id, result.peerDisplayName);
  rooms.connect(result.control.descriptor.id);
  ensureRelationshipControl(result.relationship.id);
}

function observeSessionCompletion(sessionId: string): void {
  pairing.connectSession(sessionId);
  pairing.observeCompletion(sessionId, onPairingCompleted);
}

export function initializeBrowserRelationshipRuntime(): void {
  const start = () => {
    scanActiveRelationshipControls();
    if (!rootRelationshipObserversInstalled) {
      const rescan = () => scanActiveRelationshipControls();
      rootDoc.getMap('relationships').observe(rescan);
      rootDoc.getMap('relationshipControlCapabilities').observe(rescan);
      rootRelationshipObserversInstalled = true;
    }
    void retryPendingRemotePurges();
    void pairing.sweepCompletedPairingLobbies();
    // Reopen surviving pairings: hosted lobbies keep serving their invite, and
    // joining sessions keep watching for the inviter's approval.
    const resumed = pairing.resumePersistedPairings();
    for (const sessionId of resumed.joiningSessions) {
      try { observeSessionCompletion(sessionId); } catch (error) { console.error('Could not resume pairing session', error); }
    }
  };
  const persistence = getRootPersistence();
  if (persistence) void Promise.resolve(persistence.whenSynced).then(start);
  else start();
  if (purgeRetryTimer === null) purgeRetryTimer = window.setInterval(() => void retryPendingRemotePurges(), 30_000);
}

function ownsSharingState(relationshipId: string): boolean {
  return listChannelDescriptors(rootDoc).some((channel) => channel.relationshipId === relationshipId)
    || listAllChannelShares(rootDoc).some((share) => share.relationshipId === relationshipId)
    || listPendingShareInvites(rootDoc).some((invite) => invite.relationshipId === relationshipId)
    || listRemotePurgeIntents(rootDoc).some((purge) => purge.relationshipId === relationshipId)
    || listPendingRemotePurges(rootDoc).some((purge) => purge.relationshipId === relationshipId);
}

/** Root records go last, so a crash mid-teardown retries against a still-listed contact. */
async function deleteRelationshipRecords(relationship: Relationship, origin: string): Promise<void> {
  rootDoc.transact(() => {
    removeRelationshipControlCapability(relationship.id, rootDoc);
    deleteRelationship(relationship.id, rootDoc);
    if (!listRelationships(rootDoc).some((candidate) => candidate.personId === relationship.personId)) {
      deletePerson(relationship.personId, rootDoc);
    }
  }, origin);
  await compactRootPersistence();
}

export async function removePendingRelationship(relationshipId: string): Promise<void> {
  const relationship = getRelationship(relationshipId, rootDoc);
  if (!relationship) return;
  if (relationship.status !== 'pending') throw new Error('relationship runtime: Only incomplete pairings can be removed here');
  if (ownsSharingState(relationshipId)) {
    throw new Error('relationship runtime: Pending pairing still owns sharing state and cannot be removed locally');
  }

  await pairing.cancelRelationship(relationshipId);
  const currentRelationship = getRelationship(relationshipId, rootDoc);
  if (!currentRelationship) return;
  if (currentRelationship.status !== 'pending') throw new Error('relationship runtime: Pairing completed while removal was in progress');
  if (ownsSharingState(relationshipId)) {
    throw new Error('relationship runtime: Pairing acquired sharing state while removal was in progress');
  }
  stopObservingControl(relationshipId);
  await deleteRelationshipRecords(currentRelationship, 'remove-pending-relationship');
}

/**
 * Deletes a contact entirely: a best-effort signed erase request per isolated channel, then
 * local channel rooms/registry rows/share state, the encrypted control room, any pairing
 * lobby remnant, and finally the relationship + person records. P2P honesty: if the peer is
 * offline it keeps whatever already synced — there is no server to enforce remote deletion,
 * the purge requests only reach them while our control-room copy is still being served.
 */
export async function removeContact(relationshipId: string): Promise<void> {
  const relationship = getRelationship(relationshipId, rootDoc);
  if (!relationship) return;
  if (relationship.status !== 'active') return removePendingRelationship(relationshipId);

  const shares = listAllChannelShares(rootDoc).filter((share) => share.relationshipId === relationshipId);
  const invites = listPendingShareInvites(rootDoc).filter((invite) => invite.relationshipId === relationshipId);
  const descriptors = listChannelDescriptors(rootDoc).filter((channel) => channel.relationshipId === relationshipId);
  const channelIds = new Set<string>([
    ...descriptors.map((channel) => channel.id),
    ...shares.map((share) => share.channelId),
    ...invites.map((invite) => invite.channel.id),
  ]);

  // 1. Ask the peer to erase its side of every channel while the control room still exists.
  for (const channelId of channelIds) {
    try {
      await queueRemoteChannelPurge({ id: channelId, relationshipId }, 'grant-revoked');
    } catch (error) {
      console.error('Could not send a channel erase request while removing the contact', error);
    }
  }

  // 2. Local channel rooms, registry entries, share rows, invites, and staged offers.
  for (const channelId of channelIds) {
    await withChannelOperation(relationshipId, channelId, async () => {
      declinePendingShareInvitesByChannel(relationshipId, channelId, rootDoc);
      try {
        await purgeRelationshipChannelLocal(channelId, relationshipId, rootDoc);
      } catch (error) {
        if (!isUnknownChannelError(error)) console.error('Could not purge a relationship channel locally', error);
      }
    });
  }
  for (const share of shares) removeChannelShare(share.id, rootDoc);
  for (const invite of invites) {
    if (getPendingShareInvite(invite.id, rootDoc)?.status === 'pending') {
      setPendingShareInviteStatus(invite.id, 'declined', rootDoc);
    }
  }
  for (const map of [stagedShareOffers(), processedShareResponses()]) {
    for (const key of [...map.keys()]) {
      if (map.get(key)?.relationshipId === relationshipId) map.delete(key);
    }
  }

  // 3. Purge bookkeeping dies with the relationship.
  removeRemotePurgesForRelationship(relationshipId, rootDoc);

  // 4. Control room and its observers.
  stopObservingControl(relationshipId);
  const capability = getRelationshipControlCapability(relationshipId, rootDoc);
  if (capability) {
    try {
      await rooms.destroyControl(capability);
    } catch (error) {
      console.error('Could not destroy the relationship control room', error);
    }
  }

  // 5. Any leftover pairing lobby; also blocks a pairing racing this removal.
  await pairing.cancelRelationship(relationshipId);

  // 6. Root records last.
  await deleteRelationshipRecords(relationship, 'remove-contact');
}

/**
 * No name input: the contact card starts as a placeholder and takes the
 * peer's signed, self-announced name when their pairing request is approved.
 */
export async function hostRelationshipPairing(): Promise<HostedPairing> {
  const person = createPerson(PENDING_CONTACT_NAME, {}, rootDoc);
  const identity = await createRelationshipIdentity();
  const relationship = createRelationship(person.id, identity, {}, rootDoc);
  return reissueRelationshipInvite(relationship.id);
}

/** Rehydrates a stored hosted invite so the People page can show/copy it and approve requests any time. */
export function getHostedPairingInvite(relationshipId: string): { inviteId: string; uri: string; expiresAt: string; expired: boolean } | null {
  return pairing.resumeHostedInvite(relationshipId);
}

/** Which side of an incomplete pairing this device holds ('hosted' shows the invite, 'joining' waits for approval). */
export function getPendingPairingKind(relationshipId: string): 'hosted' | 'joining' | null {
  return pairing.pendingPairingKind(relationshipId);
}

/**
 * The safety number of a pairing that has NOT completed yet — the number both sides compare
 * before anyone approves. The hosting side passes the requester's key from the request it is
 * looking at; the joining side passes nothing (it knows the inviter's key from the signed,
 * code-gated announce). Null when this relationship is not a pending pairing.
 */
export async function pendingPairingSafetyNumber(relationshipId: string, peerPublicKey?: string): Promise<string | null> {
  const parties = pairing.pendingPairingParties(relationshipId);
  const peer = peerPublicKey ?? parties?.peerPublicKey;
  if (!parties || !peer) return null;
  return deriveRelationshipSafetyNumber(parties.localPublicKey, peer, parties.pairContextId);
}

/** Issues a fresh invite for a pending contact, replacing any expired or lost one. */
export async function reissueRelationshipInvite(relationshipId: string): Promise<HostedPairing> {
  const issued = await pairing.createInvite(relationshipId, { lifetimeMs: PAIRING_INVITE_LIFETIME_MS, displayName: myPairingDisplayName() });
  pairing.connectInvite(issued.invite.inviteId);
  return { relationshipId, inviteId: issued.invite.inviteId, uri: issued.uri, lobby: issued.lobby };
}

/**
 * No name input: the inviter's signed lobby announce carries their name, so
 * the contact is named the moment the invite is accepted.
 */
export async function joinRelationshipPairing(uri: string): Promise<{ relationshipId: string; sessionId: string; lobby: RelationshipPairingRoomHandle }> {
  const person = createPerson(PENDING_CONTACT_NAME, {}, rootDoc);
  let accepted;
  try {
    accepted = await pairing.acceptInvite(uri.trim(), person.id, { displayName: myPairingDisplayName() });
  } catch (error) {
    // A bad code or unreachable inviter must not strand a placeholder person.
    try { deletePerson(person.id, rootDoc); } catch { /* best effort */ }
    throw error;
  }
  adoptPeerDisplayName(accepted.relationship.id, accepted.inviterDisplayName);
  observeSessionCompletion(accepted.sessionId);
  return { relationshipId: accepted.relationship.id, sessionId: accepted.sessionId, lobby: accepted.lobby };
}

export async function listHostedPairingRequests(inviteId: string): Promise<RelationshipPairingRequestInfo[]> {
  return pairing.listRequests(inviteId);
}

export function observeHostedPairingRequests(inviteId: string, listener: (requests: RelationshipPairingRequestInfo[]) => void): () => void {
  return pairing.observeRequests(inviteId, listener);
}

export async function approveRelationshipPairing(inviteId: string, requestId: string): Promise<CompletedRelationshipPairing & { safetyNumber: string }> {
  const result = await pairing.approve(inviteId, requestId);
  const peerPublicKey = result.relationship.peerPublicKey;
  if (!peerPublicKey) throw new Error('relationship runtime: Approved relationship has no peer key');
  onPairingCompleted(result);
  const safetyNumber = await deriveRelationshipSafetyNumber(
    result.relationship.localIdentity.publicKey,
    peerPublicKey,
    result.relationship.pairContextId,
  );
  return { ...result, safetyNumber };
}

/**
 * Content-free push wake-up for the contact's devices, fired only after the
 * signed offer is durably published (docs/plans/2026-08-31-push-notifications.md).
 * Best-effort and non-blocking: share flows never depend on the relay.
 */
function tickleContactDevices(relationship: Relationship, control: RelationshipPairingRoomHandle): void {
  void import('./pushNotifications.ts')
    .then(({ sendShareTickle }) => sendShareTickle(relationship, control.doc))
    .catch(() => undefined);
}

// ───── Channel shares ($share.open) ─────

type ShareResponse =
  | { kind: 'accepted'; ack: RelationshipChannelControlMessage }
  | { kind: 'declined'; decline: RelationshipChannelControlMessage };

function waitForShareResponse(
  waiter: ReturnType<typeof registerAwaitedShareOffer>,
): Promise<ShareResponse> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error('sharing runtime: Timed out waiting for the recipient to respond to the channel share'));
    }, 600_000);
    void waiter.response.then((message) => {
      window.clearTimeout(timeout);
      resolve(message.kind === 'channel-share-ack' ? { kind: 'accepted', ack: message } : { kind: 'declined', decline: message });
    });
  });
}

interface CreateChannelShareInput {
  dappId: string;
  relationshipId: string;
  shareId: string;
  shareLabel: string;
  instanceId: string;
  dappMeta: { name: string; icon: string; color: string };
  events: CodeAppBindingDeclaration[];
  actions: CodeAppBindingDeclaration[];
  routes: CodeAppManifestShareRoute[];
  attachDefinition?: boolean;
  /**
   * false = return as soon as the signed offer and pending share row are durably
   * queued, without blocking on the recipient's accept. Activation then happens
   * through the late-response scan path (processShareResponse), which
   * already survives reloads. Default true preserves the blocking contract.
   */
  waitForResponse?: boolean;
}

interface ChannelShareResult {
  status: 'accepted' | 'declined' | 'pending';
  share?: ChannelShare;
  descriptor?: ChannelDescriptor;
}

/**
 * Sender side of $share.open — one call per participant. Creates one isolated channel for this
 * (relationship, instanceId) pair (invariant 3), sends the share offer, and waits for the
 * recipient's explicit accept or decline. Never auto-installs anything on either side.
 */
export async function createChannelShare(input: CreateChannelShareInput): Promise<ChannelShareResult> {
  const relationship = requireRelationship(input.relationshipId);
  if (relationship.status !== 'active' || !relationship.peerPublicKey) {
    throw new Error('sharing runtime: An active relationship is required');
  }
  const definition = input.attachDefinition
    ? await exportDefinitionBundle(input.dappId, relationship.localIdentity)
    : undefined;
  const control = ensureRelationshipControl(relationship.id);
  await control.persistenceReady;

  const tuple: ChannelTuple = { relationshipId: relationship.id, dappId: input.dappId, sensitiveShareId: input.instanceId };
  const operationKey = `${relationship.id}:${input.dappId}:${input.instanceId}`;
  if (outgoingShareCreations.has(operationKey)) throw new Error('sharing runtime: A share invite is already being created for this participant');
  const existing = listChannelSharesByInstance(input.dappId, input.instanceId, rootDoc)
    .find((share) => share.relationshipId === relationship.id && share.status !== 'revoked');
  if (existing) throw new Error(existing.status === 'pending'
    ? 'sharing runtime: This participant already has a pending invite'
    : 'sharing runtime: This participant already has access');
  let descriptor = getChannelDescriptor(tuple, rootDoc) ?? registerChannelDescriptor(tuple, rootDoc);
  if (descriptor.status === 'revoked') throw new Error('sharing runtime: Channel has been revoked');
  admitChannelDevice(tuple, relationship.localIdentity.publicKey, rootDoc);
  descriptor = admitChannelDevice(tuple, relationship.peerPublicKey, rootDoc);
  outgoingShareCreations.add(operationKey);

  const waitForAccept = input.waitForResponse !== false;
  let awaitingOfferId: string | null = null;
  let activeWaiter: ReturnType<typeof registerAwaitedShareOffer> | null = null;
  let pendingShare: ChannelShare | null = null;
  let offerRootCommitted = false;
  try {
    await sendChannelShareOffer({
      relationship, descriptor, dappId: input.dappId, shareId: input.shareId, shareLabel: input.shareLabel,
      instanceId: input.instanceId, dappMeta: input.dappMeta, events: input.events, actions: input.actions, routes: input.routes,
      definition,
      rootDoc, controlDoc: control.doc,
      beforePublish: (prepared) => {
        offerRootCommitted = true;
        if (waitForAccept) {
          // A registered waiter makes the response scan hand the message to us
          // instead of running the self-contained late-response activation — so
          // register one only when somebody is actually going to await it.
          awaitingOfferId = prepared.offerId;
          activeWaiter = registerAwaitedShareOffer(prepared.offerId);
        }
        descriptor = setChannelControlOfferMessage(descriptor.id, prepared.message.messageId, rootDoc);
        pendingShare = createChannelShareRecord({
          dappId: input.dappId, shareId: input.shareId, instanceId: input.instanceId, relationshipId: relationship.id,
          channelId: descriptor.id, eventIds: input.events.map((event) => event.id), actionIds: input.actions.map((action) => action.id),
          offerId: prepared.offerId, controlOfferMessageId: prepared.message.messageId, status: 'pending',
        }, rootDoc);
        // Survive control-room message loss: keep our signed offer verifiable for late acks.
        stagedShareOffers().set(prepared.offerId, { relationshipId: relationship.id, message: prepared.message });
      },
      persistBeforePublish: compactRootPersistence,
    });
    const durablePendingShare = pendingShare as ChannelShare | null;
    if (!durablePendingShare) throw new Error('sharing runtime: Pending invite was not persisted before publication');
    tickleContactDevices(relationship, control);
    if (!waitForAccept) {
      return { status: 'pending', share: durablePendingShare, descriptor };
    }
    const durableWaiter = activeWaiter as ReturnType<typeof registerAwaitedShareOffer> | null;
    if (!durableWaiter) throw new Error('sharing runtime: Pending invite was not persisted before publication');
    const response = await waitForShareResponse(durableWaiter);
    return await withChannelOperation(relationship.id, descriptor.id, async () => {
      await flushRelationshipControlOutbox(relationship, control);

      if (response.kind === 'declined') {
        await removeChannelShareLocally(durablePendingShare);
        return { status: 'declined' };
      }

      descriptor = activateChannelDescriptor(tuple, rootDoc);
      const share = setChannelShareStatus(durablePendingShare.id, 'active', rootDoc);
      await compactRootPersistence();
      return { status: 'accepted', share, descriptor };
    });
  } catch (error) {
    const unpublishedShare = pendingShare as ChannelShare | null;
    if (!offerRootCommitted && unpublishedShare) {
      try { await removeChannelShareLocally(unpublishedShare); } catch { removeChannelShare(unpublishedShare.id, rootDoc); }
    }
    throw error;
  } finally {
    if (awaitingOfferId) activelyAwaitedShareOffers.delete(awaitingOfferId);
    outgoingShareCreations.delete(operationKey);
  }
}

/** Re-derive the staged contract from the immutable encrypted/signed offer before any decision side effects. */
async function readOriginalPendingShareOffer(invite: PendingShareInvite, relationship: Relationship) {
  const control = ensureRelationshipControl(relationship.id);
  await control.persistenceReady;
  const offerMessage = relationshipChannelMessages(control.doc).get(invite.offerMessageId);
  if (!offerMessage) throw new Error('sharing runtime: The original offer message is no longer available');
  const inspected = await inspectChannelShareOffer({ message: offerMessage, relationship });
  if (inspected.messageHash !== invite.offerMessageHash || inspected.payload.offerId !== invite.offerId) {
    throw new Error('sharing runtime: Pending invite no longer matches its original signed offer');
  }
  return { control, offerMessage, ...inspected };
}

function requirePendingShareInvite(inviteId: string): PendingShareInvite {
  const invite = getPendingShareInvite(inviteId, rootDoc);
  if (!invite || invite.status !== 'pending') throw new Error('sharing runtime: Unknown or already-resolved share invite');
  return invite;
}

export async function inspectPendingShareDefinition(inviteId: string): Promise<RelationshipChannelShareOfferPayload['definition']> {
  const invite = requirePendingShareInvite(inviteId);
  const relationship = requireRelationship(invite.relationshipId);
  const { payload } = await readOriginalPendingShareOffer(invite, relationship);
  if (!payload.definition) throw new Error('sharing runtime: This share offer has no installable app definition');
  return payload.definition;
}

/**
 * Recipient side: optionally installs an attached signed definition as a fresh dapp, then installs
 * the channel. Both paths require this explicit call from the consent UI.
 */
export async function acceptPendingShareInvite(
  inviteId: string,
  requestedLocalDappId?: string,
  reviewedDefinitionSignature?: string,
): Promise<{ share: ChannelShare; descriptor: ChannelDescriptor }> {
  const invite = requirePendingShareInvite(inviteId);
  const relationship = requireRelationship(invite.relationshipId);
  const { control, offerMessage, payload, messageHash } = await readOriginalPendingShareOffer(invite, relationship);
  return withChannelOperation(relationship.id, payload.channel.id, async () => {
    const currentInvite = getPendingShareInvite(inviteId, rootDoc);
    if (!currentInvite || currentInvite.status !== 'pending') {
      throw new Error('sharing runtime: This invite was revoked or already resolved');
    }
    const signedInvite: PendingShareInvite = {
      ...currentInvite,
      dappId: payload.dappId,
      shareId: payload.shareId,
      shareLabel: payload.shareLabel,
      instanceId: payload.instanceId,
      offerId: payload.offerId,
      dappMeta: payload.dappMeta,
      events: payload.events,
      actions: payload.actions,
      routes: payload.routes,
      definition: payload.definition,
      channel: payload.channel,
    };

    let localDappId = requestedLocalDappId;
    if (localDappId) {
      const localManifest = parseCodeAppManifest(getCodeAppFile(localDappId, 'manifest.yaml'));
      if (localManifest.error || !isShareInviteCompatible(signedInvite, localManifest.manifest)) {
        throw new Error('sharing runtime: The selected Code App is not compatible with this share contract');
      }
    } else {
      if (!payload.definition) throw new Error('sharing runtime: This share offer has no installable app definition');
      if (!reviewedDefinitionSignature || reviewedDefinitionSignature !== payload.definition.signature) {
        throw new Error('sharing runtime: Review the original signed app definition before installing it');
      }
      const bundledManifest = parseCodeAppManifest(payload.definition.files['manifest.yaml']);
      if (bundledManifest.error || !isShareInviteCompatible(signedInvite, bundledManifest.manifest)) {
        throw new Error('sharing runtime: The attached app definition is not compatible with this share contract');
      }
      localDappId = await importDefinitionBundle(payload.definition);
    }

    const { descriptor } = await acceptChannelShareOffer({
      offerMessage, offerPayload: payload, offerMessageHash: messageHash, localDappId,
      relationship, rootDoc, controlDoc: control.doc,
    });
    const room = await openRelationshipChannel(descriptor, relationship);
    await room.persistenceReady;

    const share = createChannelShareRecord({
      dappId: localDappId, shareId: payload.shareId, instanceId: payload.instanceId, relationshipId: relationship.id,
      channelId: descriptor.id, eventIds: payload.events.map((event) => event.id), actionIds: payload.actions.map((action) => action.id),
      status: 'active',
    }, rootDoc);
    setPendingShareInviteStatus(invite.id, 'accepted', rootDoc);
    await flushRelationshipControlOutbox(relationship, control);
    await compactRootPersistence();
    return { share, descriptor };
  });
}

/** Recipient side: dismisses the invite locally and best-effort notifies the sender. */
export async function declinePendingShareInvite(inviteId: string): Promise<boolean> {
  const invite = requirePendingShareInvite(inviteId);
  let notified = false;
  try {
    const relationship = requireRelationship(invite.relationshipId);
    const { control, offerMessage, payload, messageHash } = await readOriginalPendingShareOffer(invite, relationship);
    await declineChannelShareOffer({
      offerMessage, offerPayload: payload, offerMessageHash: messageHash, relationship, rootDoc, controlDoc: control.doc,
    });
    await flushRelationshipControlOutbox(relationship, control);
    notified = true;
  } catch {
    // A stale invite may outlive its relationship or encrypted offer. Local dismissal must still work,
    // and the retained declined tombstone prevents the same control message from being staged again.
  }
  setPendingShareInviteStatus(invite.id, 'declined', rootDoc);
  await compactRootPersistence();
  return notified;
}

function validateCanonicalShare(input: ChannelShare): {
  share: ChannelShare;
  hasLiveSibling: boolean;
} {
  const share = getChannelShareById(input.id, rootDoc);
  if (!share) throw new Error('sharing runtime: This share entry no longer exists');
  if (share.channelId !== input.channelId || share.relationshipId !== input.relationshipId) {
    throw new Error('sharing runtime: The share entry changed; reload settings before removing it');
  }
  const descriptor = getChannelDescriptorById(share.channelId, rootDoc);
  if (descriptor && descriptor.relationshipId !== share.relationshipId) {
    throw new Error('sharing runtime: Refusing to remove a channel owned by another relationship');
  }
  const hasLiveSibling = listAllChannelShares(rootDoc).some((candidate) => candidate.id !== share.id
    && candidate.channelId === share.channelId && candidate.status !== 'revoked');
  return { share, hasLiveSibling };
}

/** Revokes one participant, queues the signed remote purge, and removes the resolved local list row. */
export async function revokeChannelShareParticipant(input: ChannelShare): Promise<PendingRemotePurge> {
  return withChannelOperation(input.relationshipId, input.channelId, async () => {
    const { share, hasLiveSibling } = validateCanonicalShare(input);
    if (hasLiveSibling) throw new Error('sharing runtime: This channel is still used by another pending or active share');
    const queued = await queueRemoteChannelPurge({ id: share.channelId, relationshipId: share.relationshipId }, 'grant-revoked');
    await removeChannelShareLocally(share);
    return queued;
  });
}

/** Explicit fallback for stale rows when the peer can no longer receive a signed purge. */
export async function removeChannelShareLocally(input: ChannelShare): Promise<void> {
  const { share, hasLiveSibling } = validateCanonicalShare(input);
  if (!hasLiveSibling) {
    try {
      await purgeRelationshipChannelLocal(share.channelId, share.relationshipId, rootDoc);
    } catch (error) {
      if (!isUnknownChannelError(error)) throw error;
    }
  }
  removeChannelShare(share.id, rootDoc);
  if (share.offerId) stagedShareOffers().delete(share.offerId);
  await compactRootPersistence();
}
