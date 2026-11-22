import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { ChannelDescriptor, ChannelShare, CodeAppManifest, HybridEncryptedEnvelope, Relationship, StreamEvent } from '../types.ts';
import { createRelationshipIdentity } from '../services/relationshipIdentity.ts';
import { hybridDecrypt } from '../services/relationshipProtocol.ts';
import { signStreamEvent } from '../services/relationshipStream.ts';
import {
  CHANNEL_PAYLOAD_POLICY,
  ChannelBindingRuntime,
  MAX_CHANNEL_REPLAY_HISTORY,
  pruneChannelBindingMetadata,
  reserveChannelReplayCapacity,
  type ChannelActionDelivery,
  type ChannelBindingRuntimeDependencies,
} from '../services/channelBindingRuntime.ts';
import type { ChannelRoomHandle } from '../services/channelRoomManager.ts';
import { deriveAcceptedStreams, ingestStreamEvent } from '../services/projectionPublisher.ts';

// The real scan, wrapped so a test can count how many full scans a burst of changes costs.
vi.mock('../services/projectionPublisher.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/projectionPublisher.ts')>();
  return { ...original, deriveAcceptedStreams: vi.fn(original.deriveAcceptedStreams) };
});

const timestamp = '2026-08-20T12:00:00.000Z';

function manifest(): CodeAppManifest {
  return {
    routes: [{ path: '/', label: 'Game' }],
    bindings: {
      events: [{ id: 'game.move', label: 'Move', payload: [{ name: 'from', type: 'string', required: true }] }],
      actions: [{ id: 'game.move.apply', label: 'Apply move', payload: [{ name: 'origin', type: 'string', required: true }] }],
    },
    channels: {
      shares: [{
        id: 'match',
        label: 'Match',
        events: ['game.move'],
        actions: ['game.move.apply'],
        routes: [{ eventId: 'game.move', actionId: 'game.move.apply', fieldMap: { origin: 'from' } }],
        maxParticipants: 8,
      }],
    },
  };
}

async function fixture() {
  const aliceIdentity = await createRelationshipIdentity();
  const bobIdentity = await createRelationshipIdentity();
  const descriptor: ChannelDescriptor = {
    id: 'channel-alice-bob', schemaVersion: 1, relationshipId: 'relationship-alice-bob', dappId: 'game',
    sensitiveShareId: 'instance-1', roomId: 'room-alice-bob', roomPassword: 'secret',
    persistenceKey: 'relationship-channel-v1-channel-alice-bob',
    memberDeviceKeys: [aliceIdentity.publicKey, bobIdentity.publicKey], status: 'active', createdAt: timestamp, updatedAt: timestamp,
  };
  const share: ChannelShare = {
    id: 'share-row', schemaVersion: 1, dappId: 'game', shareId: 'match', instanceId: 'instance-1',
    relationshipId: descriptor.relationshipId, channelId: descriptor.id,
    eventIds: ['game.move'], actionIds: ['game.move.apply'], status: 'active', createdAt: timestamp, updatedAt: timestamp,
  };
  const aliceRelationship: Relationship = {
    id: descriptor.relationshipId, schemaVersion: 1, personId: 'bob', status: 'active', localIdentity: aliceIdentity,
    peerPublicKey: bobIdentity.publicKey, peerEncPublicKey: bobIdentity.encPublicKey, verifiedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
  };
  const bobRelationship: Relationship = {
    id: descriptor.relationshipId, schemaVersion: 1, personId: 'alice', status: 'active', localIdentity: bobIdentity,
    peerPublicKey: aliceIdentity.publicKey, peerEncPublicKey: aliceIdentity.encPublicKey, verifiedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
  };
  return { descriptor, share, aliceRelationship, bobRelationship };
}

function makeRuntime(input: {
  rootDoc: Y.Doc;
  channelDoc: Y.Doc;
  descriptor: ChannelDescriptor;
  share: ChannelShare;
  relationship: Relationship;
  appManifest?: CodeAppManifest;
  displayName: string;
}) {
  let counter = 0;
  const dependencies: ChannelBindingRuntimeDependencies = {
    rootDoc: input.rootDoc,
    persistentRoot: false,
    listShares: () => [input.share],
    listSharesByInstance: () => [input.share],
    getDescriptor: () => input.descriptor,
    getRelationship: () => input.relationship,
    openRoom: () => Promise.resolve({
      descriptor: input.descriptor,
      doc: input.channelDoc,
      persistenceReady: Promise.resolve(),
      state: 'connected',
    } as ChannelRoomHandle),
    manifestFor: () => input.appManifest ?? manifest(),
    contactFor: () => Promise.resolve({ handle: `handle-${input.displayName}`, displayName: input.displayName, verified: true }),
    checkpoint: () => Promise.resolve(),
    now: () => timestamp,
    randomUUID: () => `${input.displayName}-${++counter}`,
  };
  return new ChannelBindingRuntime(dependencies);
}

function sync(source: Y.Doc, destination: Y.Doc): void {
  Y.applyUpdate(destination, Y.encodeStateAsUpdate(source));
}

function storedEvents(doc: Y.Doc): StreamEvent[] {
  return Array.from(doc.getMap<string>('relationshipStreamEventsV1').values()).map((value) => JSON.parse(value) as StreamEvent);
}

/** A delivery as builds before 2026-09-22 wrote it: plaintext envelope, local relationship id signed in. */
async function legacyPlaintextDelivery(
  descriptor: ChannelDescriptor, sender: Relationship, nonce: string, from: string,
): Promise<StreamEvent> {
  return signStreamEvent({
    protocol: 'relationship-stream', schemaVersion: 1, eventId: nonce, relationshipId: sender.id, channelId: descriptor.id,
    streamId: `channel-binding-delivery:${nonce}`, sequence: 0, previousEventHash: null, kind: 'action',
    signerPublicKey: sender.localIdentity.publicKey, createdAt: timestamp,
    payload: {
      protocol: 'channel-binding', schemaVersion: 1, type: 'delivery', instanceId: 'instance-1', eventId: 'game.move',
      actionId: 'game.move.apply', payload: { origin: from }, sentAt: timestamp, nonce,
    },
  }, sender.localIdentity.privateKey);
}

describe('ChannelBindingRuntime', () => {
  it('delivers a routed signed action, includes opaque sender context, and prunes after the signed ack', async () => {
    const { descriptor, share, aliceRelationship, bobRelationship } = await fixture();
    const bobDescriptor = { ...descriptor, relationshipId: 'relationship-bob-alice' };
    const bobShare = { ...share, relationshipId: bobDescriptor.relationshipId };
    const bobLocalRelationship = { ...bobRelationship, id: bobDescriptor.relationshipId };
    const aliceDoc = new Y.Doc(); const bobDoc = new Y.Doc();
    const alice = makeRuntime({ rootDoc: new Y.Doc(), channelDoc: aliceDoc, descriptor, share, relationship: aliceRelationship, displayName: 'Alice' });
    const bob = makeRuntime({
      rootDoc: new Y.Doc(), channelDoc: bobDoc, descriptor: bobDescriptor,
      share: bobShare, relationship: bobLocalRelationship, displayName: 'RemoteAlice',
    });
    await alice.initialize(); await bob.initialize();
    const handler = vi.fn((delivery: ChannelActionDelivery) => { void delivery; return Promise.resolve(); });
    bob.registerActionRuntime('game', 'bob-frame', 'game.move.apply', handler);

    const published = await alice.publishChannelEvent('game', 'game.move', { from: 'e2' }, 'instance-1');
    expect(published.deliveryIds).toHaveLength(1);
    sync(aliceDoc, bobDoc);
    await bob.scanChannel(descriptor.id);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      id: published.deliveryIds[0], actionId: 'game.move.apply', payload: { origin: 'e2' },
      from: { handle: 'handle-RemoteAlice', displayName: 'RemoteAlice', verified: true }, instanceId: 'instance-1',
    });

    sync(bobDoc, aliceDoc);
    await alice.scanChannel(descriptor.id);
    expect(storedEvents(aliceDoc).some((event) => event.streamId.startsWith('channel-binding-delivery:'))).toBe(false);
    alice.dispose(); bob.dispose();
  }, 20_000);

  it('covers a burst of channel changes with one queued scan instead of one scan per change', async () => {
    const { descriptor, share, aliceRelationship, bobRelationship } = await fixture();
    const aliceDoc = new Y.Doc(); const bobDoc = new Y.Doc();
    const alice = makeRuntime({ rootDoc: new Y.Doc(), channelDoc: aliceDoc, descriptor, share, relationship: aliceRelationship, displayName: 'Alice' });
    const bob = makeRuntime({ rootDoc: new Y.Doc(), channelDoc: bobDoc, descriptor, share, relationship: bobRelationship, displayName: 'RemoteAlice' });
    await alice.initialize(); await bob.initialize();
    const handler = vi.fn(() => Promise.resolve());
    bob.registerActionRuntime('game', 'bob-frame', 'game.move.apply', handler);
    await bob.scanChannel(descriptor.id);

    // Five deliveries arrive as five separate updates within one tick.
    const updates: Uint8Array[] = [];
    aliceDoc.on('update', (update: Uint8Array) => updates.push(update));
    for (const from of ['a2', 'b2', 'c2', 'd2', 'e2']) await alice.publishChannelEvent('game', 'game.move', { from }, 'instance-1');
    expect(updates.length).toBeGreaterThanOrEqual(5);
    vi.mocked(deriveAcceptedStreams).mockClear();
    updates.forEach((update) => Y.applyUpdate(bobDoc, update));

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(5));
    await bob.scanChannel(descriptor.id);
    const bobScans = vi.mocked(deriveAcceptedStreams).mock.calls.filter(([doc]) => doc === bobDoc).length;
    // One scan for the burst, one for the acks it wrote, one requested above —
    // formerly one per arriving update plus one per ack.
    expect(bobScans).toBeLessThanOrEqual(3);
    alice.dispose(); bob.dispose();
  }, 20_000);

  it('does not redeliver a replayed nonce, including after the original queue entry is removed', async () => {
    const { descriptor, share, aliceRelationship, bobRelationship } = await fixture();
    const aliceDoc = new Y.Doc(); const bobDoc = new Y.Doc(); const bobRoot = new Y.Doc();
    const alice = makeRuntime({ rootDoc: new Y.Doc(), channelDoc: aliceDoc, descriptor, share, relationship: aliceRelationship, displayName: 'Bob' });
    const bob = makeRuntime({ rootDoc: bobRoot, channelDoc: bobDoc, descriptor, share, relationship: bobRelationship, displayName: 'Alice' });
    await alice.initialize(); await bob.initialize();
    const handler = vi.fn((delivery: ChannelActionDelivery) => { void delivery; return Promise.resolve(); });
    bob.registerActionRuntime('game', 'bob-frame', 'game.move.apply', handler);
    await alice.publishChannelEvent('game', 'game.move', { from: 'a1' }, 'instance-1');
    const original = Y.encodeStateAsUpdate(aliceDoc);
    Y.applyUpdate(bobDoc, original);
    await bob.scanChannel(descriptor.id);
    await bob.scanChannel(descriptor.id);
    Y.applyUpdate(bobDoc, original);
    await bob.scanChannel(descriptor.id);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(bobRoot.getMap('channelBindingReplayV1').size).toBe(1);
    alice.dispose(); bob.dispose();
  }, 20_000);

  it('drops an unapproved action and records a bounded diagnostic instead of invoking app code', async () => {
    const { descriptor, share, aliceRelationship, bobRelationship } = await fixture();
    const aliceDoc = new Y.Doc(); const bobDoc = new Y.Doc(); const bobRoot = new Y.Doc();
    const alice = makeRuntime({ rootDoc: new Y.Doc(), channelDoc: aliceDoc, descriptor, share, relationship: aliceRelationship, displayName: 'Bob' });
    const receiverShare = { ...share, actionIds: [] };
    const bob = makeRuntime({ rootDoc: bobRoot, channelDoc: bobDoc, descriptor, share: receiverShare, relationship: bobRelationship, displayName: 'Alice' });
    await alice.initialize(); await bob.initialize();
    const handler = vi.fn((delivery: ChannelActionDelivery) => { void delivery; return Promise.resolve(); });
    bob.registerActionRuntime('game', 'bob-frame', 'game.move.apply', handler);
    await alice.publishChannelEvent('game', 'game.move', { from: 'a1' }, 'instance-1');
    sync(aliceDoc, bobDoc);
    await bob.scanChannel(descriptor.id);
    expect(handler).not.toHaveBeenCalled();
    expect(Array.from(bobRoot.getMap<string>('channelBindingDiagnosticsV1').values()).join('')).toContain('action-not-approved');
    alice.dispose(); bob.dispose();
  }, 20_000);

  it('drops an event that was not in the participant immutable event allowlist', async () => {
    const { descriptor, share, aliceRelationship, bobRelationship } = await fixture();
    const aliceDoc = new Y.Doc(); const bobDoc = new Y.Doc(); const bobRoot = new Y.Doc();
    const alice = makeRuntime({ rootDoc: new Y.Doc(), channelDoc: aliceDoc, descriptor, share, relationship: aliceRelationship, displayName: 'Bob' });
    const bob = makeRuntime({ rootDoc: bobRoot, channelDoc: bobDoc, descriptor, share: { ...share, eventIds: [] }, relationship: bobRelationship, displayName: 'Alice' });
    await alice.initialize(); await bob.initialize();
    const handler = vi.fn((delivery: ChannelActionDelivery) => { void delivery; return Promise.resolve(); });
    bob.registerActionRuntime('game', 'bob-frame', 'game.move.apply', handler);
    await alice.publishChannelEvent('game', 'game.move', { from: 'a1' }, 'instance-1');
    sync(aliceDoc, bobDoc);
    await bob.scanChannel(descriptor.id);
    expect(handler).not.toHaveBeenCalled();
    expect(Array.from(bobRoot.getMap<string>('channelBindingDiagnosticsV1').values()).join('')).toContain('event-not-approved');
    alice.dispose(); bob.dispose();
  }, 20_000);

  it('retains only the newest bounded replay or rejection metadata rows', () => {
    const doc = new Y.Doc();
    const metadata = doc.getMap<string>('metadata');
    for (let index = 0; index < 8; index += 1) {
      metadata.set(`row-${index}`, JSON.stringify({ processedAt: `2026-08-20T12:00:0${index}.000Z` }));
    }
    pruneChannelBindingMetadata(metadata, 3);
    expect(Array.from(metadata.keys()).sort()).toEqual(['row-5', 'row-6', 'row-7']);
  });

  it('keeps a channel working past the replay history size, and still refuses what it no longer remembers', () => {
    const doc = new Y.Doc();
    const replay = doc.getMap<string>('replay');
    const sentAt = (index: number) => new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
    doc.transact(() => {
      for (let index = 0; index < MAX_CHANNEL_REPLAY_HISTORY - 1; index += 1) {
        replay.set(`channel\u0000peer\u0000nonce-${index}`, JSON.stringify({ sentAt: sentAt(index), processedAt: sentAt(index) }));
      }
      replay.set('channel\u0000other-peer\u0000nonce-x', JSON.stringify({ sentAt: sentAt(0), processedAt: sentAt(0) }));
    });

    // The next delivery is accepted: the oldest fifth of the history makes room.
    expect(reserveChannelReplayCapacity(replay, 'channel', 'peer', sentAt(MAX_CHANNEL_REPLAY_HISTORY))).toBe(true);
    expect(replay.has('channel\u0000peer\u0000nonce-0')).toBe(false);
    expect(replay.has(`channel\u0000peer\u0000nonce-${MAX_CHANNEL_REPLAY_HISTORY - 2}`)).toBe(true);
    expect(replay.has('channel\u0000other-peer\u0000nonce-x')).toBe(true);

    // A forgotten delivery put back by someone holding the channel credentials is not fresh again…
    expect(reserveChannelReplayCapacity(replay, 'channel', 'peer', sentAt(0))).toBe(false);
    expect(reserveChannelReplayCapacity(replay, 'channel', 'peer', sentAt(999))).toBe(false);
    // …while everything newer than the dropped part still goes through, for the other signer as well.
    expect(reserveChannelReplayCapacity(replay, 'channel', 'peer', sentAt(1000))).toBe(true);
    expect(reserveChannelReplayCapacity(replay, 'channel', 'other-peer', sentAt(1))).toBe(true);
  });

  it('revives a channel that an earlier build had switched off at the old hard cap', () => {
    const doc = new Y.Doc();
    const replay = doc.getMap<string>('replay');
    replay.set('channel\u0000peer\u0000__capacity-saturated__', JSON.stringify({ saturatedAt: timestamp }));
    expect(reserveChannelReplayCapacity(replay, 'channel', 'peer', timestamp)).toBe(true);
    expect(replay.size).toBe(0);
  });

  it('queues an event published before the recipient accepts and delivers it after activation', async () => {
    const { descriptor, share, aliceRelationship, bobRelationship } = await fixture();
    // Sender side: the offer is out but not yet accepted — share pending, channel prepared.
    const pendingDescriptor = { ...descriptor, status: 'prepared' as const };
    const pendingShare = { ...share, status: 'pending' as const };
    const aliceDoc = new Y.Doc(); const bobDoc = new Y.Doc();
    const alice = makeRuntime({
      rootDoc: new Y.Doc(), channelDoc: aliceDoc, descriptor: pendingDescriptor,
      share: pendingShare, relationship: aliceRelationship, displayName: 'Alice',
    });
    await alice.initialize();

    // Publishing while pending succeeds and lands durably in the channel doc.
    const published = await alice.publishChannelEvent('game', 'game.move', { from: 'd4' }, 'instance-1');
    expect(published.deliveryIds).toHaveLength(1);
    expect(published.failures).toEqual([]);

    // Recipient accepts later: their share/channel are active, the doc syncs over.
    const bobDescriptor = { ...descriptor, relationshipId: 'relationship-bob-alice' };
    const bobShare = { ...share, relationshipId: bobDescriptor.relationshipId };
    const bob = makeRuntime({
      rootDoc: new Y.Doc(), channelDoc: bobDoc, descriptor: bobDescriptor,
      share: bobShare, relationship: { ...bobRelationship, id: bobDescriptor.relationshipId }, displayName: 'RemoteAlice',
    });
    await bob.initialize();
    const handler = vi.fn((delivery: ChannelActionDelivery) => { void delivery; return Promise.resolve(); });
    bob.registerActionRuntime('game', 'bob-frame', 'game.move.apply', handler);
    sync(aliceDoc, bobDoc);
    await bob.scanChannel(descriptor.id);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ payload: { origin: 'd4' } });
  });

  it('leaves a delivery that arrives before local activation queued instead of rejecting it', async () => {
    const { descriptor, share, aliceRelationship, bobRelationship } = await fixture();
    const aliceDoc = new Y.Doc(); const bobDoc = new Y.Doc();
    const alice = makeRuntime({ rootDoc: new Y.Doc(), channelDoc: aliceDoc, descriptor, share, relationship: aliceRelationship, displayName: 'Alice' });
    await alice.initialize();
    await alice.publishChannelEvent('game', 'game.move', { from: 'c3' }, 'instance-1');

    // Recipient still pending locally: the delivery must stay queued, not be acked away.
    const bobInput = {
      rootDoc: new Y.Doc(), channelDoc: bobDoc,
      descriptor: { ...descriptor, relationshipId: 'relationship-bob-alice', status: 'prepared' as ChannelDescriptor['status'] },
      share: { ...share, relationshipId: 'relationship-bob-alice', status: 'pending' as ChannelShare['status'] },
      relationship: { ...bobRelationship, id: 'relationship-bob-alice' }, displayName: 'RemoteAlice',
    };
    const bob = makeRuntime(bobInput);
    await bob.initialize();
    const handler = vi.fn(() => Promise.resolve());
    bob.registerActionRuntime('game', 'bob-frame', 'game.move.apply', handler);
    sync(aliceDoc, bobDoc);
    await bob.reconcileShares();
    expect(handler).not.toHaveBeenCalled();

    // Activation flips both rows; the reconcile transition triggers the catch-up scan.
    bobInput.descriptor = { ...bobInput.descriptor, status: 'active' };
    bobInput.share = { ...bobInput.share, status: 'active' };
    await bob.reconcileShares();
    await bob.scanChannel(descriptor.id);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('retains an offline delivery and dispatches it after the recipient restores the channel document', async () => {
    const { descriptor, share, aliceRelationship, bobRelationship } = await fixture();
    const aliceDoc = new Y.Doc();
    const alice = makeRuntime({ rootDoc: new Y.Doc(), channelDoc: aliceDoc, descriptor, share, relationship: aliceRelationship, displayName: 'Bob' });
    await alice.initialize();
    await alice.publishChannelEvent('game', 'game.move', { from: 'offline-square' }, 'instance-1');

    const restoredBobDoc = new Y.Doc();
    sync(aliceDoc, restoredBobDoc);
    const bob = makeRuntime({ rootDoc: new Y.Doc(), channelDoc: restoredBobDoc, descriptor, share, relationship: bobRelationship, displayName: 'Alice' });
    const handler = vi.fn((delivery: ChannelActionDelivery) => { void delivery; return Promise.resolve(); });
    bob.registerActionRuntime('game', 'bob-frame', 'game.move.apply', handler);
    await bob.initialize();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].payload).toEqual({ origin: 'offline-square' });
    alice.dispose(); bob.dispose();
  }, 20_000);

  it('keeps Alice-to-Bob delivery bytes absent from the independent Alice-to-Carol room', async () => {
    const { descriptor, share, aliceRelationship } = await fixture();
    const bobDoc = new Y.Doc(); const carolDoc = new Y.Doc();
    const alice = makeRuntime({ rootDoc: new Y.Doc(), channelDoc: bobDoc, descriptor, share, relationship: aliceRelationship, displayName: 'Bob' });
    await alice.initialize();
    await alice.publishChannelEvent('game', 'game.move', { from: 'bob-only-secret-marker' }, 'instance-1');
    const decode = (doc: Y.Doc) => new TextDecoder().decode(Y.encodeStateAsUpdate(doc));
    expect(storedEvents(bobDoc)).toHaveLength(1);
    expect(decode(carolDoc)).not.toContain('bob-only-secret-marker');
    expect(storedEvents(carolDoc)).toHaveLength(0);
    alice.dispose();
  }, 20_000);

  describe('payload confidentiality (review item 6.5)', () => {
    it('shows a leaked-credential observer only ciphertext and no local relationship ids, while the peers round-trip', async () => {
      const { descriptor, share, aliceRelationship, bobRelationship } = await fixture();
      const bobDescriptor = { ...descriptor, relationshipId: 'relationship-bob-local-id' };
      const bobShare = { ...share, relationshipId: bobDescriptor.relationshipId };
      const aliceDoc = new Y.Doc(); const bobDoc = new Y.Doc();
      // Whoever holds the room id + password gets every byte of the channel doc.
      const observerDoc = new Y.Doc();
      const alice = makeRuntime({ rootDoc: new Y.Doc(), channelDoc: aliceDoc, descriptor, share, relationship: aliceRelationship, displayName: 'Alice' });
      const bob = makeRuntime({
        rootDoc: new Y.Doc(), channelDoc: bobDoc, descriptor: bobDescriptor, share: bobShare,
        relationship: { ...bobRelationship, id: bobDescriptor.relationshipId }, displayName: 'RemoteAlice',
      });
      await alice.initialize(); await bob.initialize();
      const handler = vi.fn((delivery: ChannelActionDelivery) => { void delivery; return Promise.resolve(); });
      bob.registerActionRuntime('game', 'bob-frame', 'game.move.apply', handler);

      await alice.publishChannelEvent('game', 'game.move', { from: 'leak-canary-square' }, 'instance-1');
      sync(aliceDoc, bobDoc);
      await bob.scanChannel(descriptor.id);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].payload).toEqual({ origin: 'leak-canary-square' });
      // Bob's ack is in the doc now, next to Alice's delivery: the observer gets both.
      sync(bobDoc, observerDoc);

      const bytes = new TextDecoder().decode(Y.encodeStateAsUpdate(observerDoc));
      for (const secret of ['leak-canary-square', 'game.move', 'instance-1', '"outcome"', 'deliveryHash',
        aliceRelationship.id, bobDescriptor.relationshipId]) {
        expect(bytes).not.toContain(secret);
      }
      const events = storedEvents(observerDoc);
      expect(events.map((event) => event.streamId.split(':')[0]).sort()).toEqual(['channel-binding-ack', 'channel-binding-delivery']);
      for (const event of events) {
        expect(event.relationshipId).toBe(descriptor.id);
        const payload = event.payload as unknown as { protocol: string; encrypted: HybridEncryptedEnvelope };
        expect(payload.protocol).toBe('channel-binding-sealed');
        // A third key cannot open it.
        const outsider = await createRelationshipIdentity();
        await expect(hybridDecrypt(payload.encrypted, outsider.encPrivateKey, {})).rejects.toThrow();
      }

      // The ack still reaches Alice and prunes her queued delivery.
      sync(bobDoc, aliceDoc);
      await alice.scanChannel(descriptor.id);
      expect(storedEvents(aliceDoc).some((event) => event.streamId.startsWith('channel-binding-delivery:'))).toBe(false);
      alice.dispose(); bob.dispose();
    }, 30_000);

    it('does not open a sealed payload lifted into another event, even one the same peer signed', async () => {
      const { descriptor, share, aliceRelationship, bobRelationship } = await fixture();
      const aliceDoc = new Y.Doc(); const bobDoc = new Y.Doc();
      const alice = makeRuntime({ rootDoc: new Y.Doc(), channelDoc: aliceDoc, descriptor, share, relationship: aliceRelationship, displayName: 'Alice' });
      await alice.initialize();
      await alice.publishChannelEvent('game', 'game.move', { from: 'original' }, 'instance-1');
      const [original] = storedEvents(aliceDoc);
      const lifted = await signStreamEvent({
        ...original, eventId: 'other-nonce', streamId: 'channel-binding-delivery:other-nonce',
      }, aliceRelationship.localIdentity.privateKey);
      const bob = makeRuntime({ rootDoc: new Y.Doc(), channelDoc: bobDoc, descriptor, share, relationship: bobRelationship, displayName: 'RemoteAlice' });
      await bob.initialize();
      const handler = vi.fn(() => Promise.resolve());
      bob.registerActionRuntime('game', 'bob-frame', 'game.move.apply', handler);
      expect((await ingestStreamEvent(bobDoc, descriptor, lifted)).status).toBe('stored');
      await bob.scanChannel(descriptor.id);
      expect(handler).not.toHaveBeenCalled();
      alice.dispose(); bob.dispose();
    }, 20_000);

    it('refuses to queue a delivery for a contact without an encryption key instead of writing plaintext', async () => {
      const { descriptor, share, aliceRelationship } = await fixture();
      const aliceDoc = new Y.Doc();
      const alice = makeRuntime({
        rootDoc: new Y.Doc(), channelDoc: aliceDoc, descriptor, share,
        relationship: { ...aliceRelationship, peerEncPublicKey: undefined }, displayName: 'Alice',
      });
      await alice.initialize();
      await expect(alice.publishChannelEvent('game', 'game.move', { from: 'a1' }, 'instance-1')).rejects.toThrow('encryption key');
      expect(storedEvents(aliceDoc)).toHaveLength(0);
      alice.dispose();
    }, 20_000);

    for (const acceptPlaintext of [true, false]) {
      it(`${acceptPlaintext ? 'accepts' : 'ignores'} a legacy plaintext delivery with acceptPlaintext = ${String(acceptPlaintext)}`, async () => {
        const { descriptor, share, aliceRelationship, bobRelationship } = await fixture();
        const bobDoc = new Y.Doc();
        const bob = makeRuntime({ rootDoc: new Y.Doc(), channelDoc: bobDoc, descriptor, share, relationship: bobRelationship, displayName: 'RemoteAlice' });
        const handler = vi.fn((delivery: ChannelActionDelivery) => { void delivery; return Promise.resolve(); });
        const policy = CHANNEL_PAYLOAD_POLICY.acceptPlaintext;
        CHANNEL_PAYLOAD_POLICY.acceptPlaintext = acceptPlaintext;
        try {
          await bob.initialize();
          bob.registerActionRuntime('game', 'bob-frame', 'game.move.apply', handler);
          const legacy = await legacyPlaintextDelivery(descriptor, aliceRelationship, 'legacy-nonce', 'old-build');
          expect((await ingestStreamEvent(bobDoc, descriptor, legacy)).status).toBe('stored');
          await bob.scanChannel(descriptor.id);
          if (acceptPlaintext) {
            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler.mock.calls[0][0]).toMatchObject({ id: 'legacy-nonce', payload: { origin: 'old-build' } });
            // The ack Bob writes back is sealed like any new write.
            // (the scan the registration queued may still be writing it).
            const ack = await vi.waitFor(() => {
              const found = storedEvents(bobDoc).find((event) => event.streamId.startsWith('channel-binding-ack:'));
              if (!found) throw new Error('no ack yet');
              return found;
            });
            expect((ack.payload as { protocol?: string }).protocol).toBe('channel-binding-sealed');
          } else {
            expect(handler).not.toHaveBeenCalled();
            expect(storedEvents(bobDoc).some((event) => event.streamId.startsWith('channel-binding-ack:'))).toBe(false);
          }
        } finally {
          CHANNEL_PAYLOAD_POLICY.acceptPlaintext = policy;
          bob.dispose();
        }
      }, 20_000);
    }

    for (const acceptPlaintext of [true, false]) {
      it(`${acceptPlaintext ? 'honours' : 'ignores'} a legacy plaintext ack with acceptPlaintext = ${String(acceptPlaintext)}`, async () => {
        const { descriptor, share, aliceRelationship, bobRelationship } = await fixture();
        const aliceDoc = new Y.Doc();
        const alice = makeRuntime({ rootDoc: new Y.Doc(), channelDoc: aliceDoc, descriptor, share, relationship: aliceRelationship, displayName: 'Alice' });
        const policy = CHANNEL_PAYLOAD_POLICY.acceptPlaintext;
        CHANNEL_PAYLOAD_POLICY.acceptPlaintext = acceptPlaintext;
        try {
          await alice.initialize();
          const [nonce] = (await alice.publishChannelEvent('game', 'game.move', { from: 'a1' }, 'instance-1')).deliveryIds;
          const delivery = storedEvents(aliceDoc)[0];
          const deliveryHash = Array.from(aliceDoc.getMap<string>('relationshipStreamEventsV1').keys())[0];
          // An old build on Bob's side acknowledges in plaintext.
          const ack = await signStreamEvent({
            protocol: 'relationship-stream', schemaVersion: 1, eventId: 'legacy-ack', relationshipId: bobRelationship.id,
            channelId: descriptor.id, streamId: 'channel-binding-ack:legacy-ack', sequence: 0, previousEventHash: null, kind: 'action',
            signerPublicKey: bobRelationship.localIdentity.publicKey, createdAt: timestamp,
            payload: {
              protocol: 'channel-binding', schemaVersion: 1, type: 'ack', instanceId: 'instance-1', deliveryNonce: nonce,
              deliveryHash, outcome: 'delivered', acknowledgedAt: timestamp,
            },
          }, bobRelationship.localIdentity.privateKey);
          expect(delivery.eventId).toBe(nonce);
          expect((await ingestStreamEvent(aliceDoc, descriptor, ack)).status).toBe('stored');
          await alice.scanChannel(descriptor.id);
          const deliveryLeft = storedEvents(aliceDoc).some((event) => event.streamId.startsWith('channel-binding-delivery:'));
          expect(deliveryLeft).toBe(!acceptPlaintext);
        } finally {
          CHANNEL_PAYLOAD_POLICY.acceptPlaintext = policy;
          alice.dispose();
        }
      }, 20_000);
    }
  });
});
