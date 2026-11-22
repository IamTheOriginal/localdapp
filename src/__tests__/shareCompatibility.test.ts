import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { ChannelDescriptor, CodeAppManifest, PendingShareInvite, Relationship, RelationshipChannelShareOfferPayload } from '../types.ts';
import { isShareInviteCompatible } from '../services/shareCompatibility.ts';
import {
  acceptChannelShareOffer, inspectChannelShareOffer, isValidChannelShareOfferPayload, listRelationshipControlOutbox, receiveChannelShareOffer,
  receiveChannelShareResponse, relationshipChannelMessages, sendChannelShareOffer, verifyOutgoingRelationshipControlEnvelope,
  verifyRelationshipControlEnvelope,
} from '../services/relationshipChannelControl.ts';
import { createRelationshipIdentity } from '../services/relationshipIdentity.ts';
import { signRelationshipControl } from '../services/relationshipProtocol.ts';
import { computeDefinitionManifestVersion } from '../services/store/definitionBundle.ts';

const event = { id: 'game.move', label: 'Move', payload: [{ name: 'from', type: 'string' as const, required: true }] };
const action = { id: 'game.move.apply', label: 'Apply', payload: [{ name: 'origin', type: 'string' as const, required: true }] };
const route = { eventId: event.id, actionId: action.id, fieldMap: { origin: 'from' } };

function manifest(): CodeAppManifest {
  return {
    routes: [{ path: '/', label: 'Game' }],
    bindings: { events: [event], actions: [action] },
    channels: { shares: [{ id: 'match', label: 'Match', events: [event.id], actions: [action.id], routes: [route], maxParticipants: 8 }] },
  };
}

function invite(): PendingShareInvite {
  return {
    id: 'invite-1', schemaVersion: 1, relationshipId: 'relationship-1', dappId: 'remote-game',
    shareId: 'match', shareLabel: 'Match', instanceId: 'instance-1', offerId: 'offer-1',
    dappMeta: { name: 'Game', icon: '🎮', color: '#123456' }, events: [event], actions: [action], routes: [route],
    channel: { id: 'channel-1', schemaVersion: 1, roomId: 'room-1', roomPassword: 'secret', memberDeviceKeys: ['a', 'b'], createdAt: '2026-08-20T12:00:00.000Z' },
    offerMessageId: 'message-1', offerMessageHash: 'a'.repeat(64), receivedAt: '2026-08-20T12:00:00.000Z', status: 'pending',
  };
}

function offer(): RelationshipChannelShareOfferPayload {
  const pending = invite();
  return {
    protocol: 'relationship-channel-share-offer', schemaVersion: 1, offerId: pending.offerId,
    dappId: pending.dappId, shareId: pending.shareId, shareLabel: pending.shareLabel, instanceId: pending.instanceId,
    dappMeta: pending.dappMeta, events: pending.events, actions: pending.actions, routes: pending.routes, channel: pending.channel,
  };
}

describe('channel share contract validation', () => {
  it('requires exact route pairs, field maps, and payload schemas', () => {
    expect(isShareInviteCompatible(invite(), manifest())).toBe(true);
    expect(isShareInviteCompatible({ ...invite(), routes: [{ ...route, actionId: 'game.other' }] }, manifest())).toBe(false);
    expect(isShareInviteCompatible({ ...invite(), routes: [{ ...route, fieldMap: { origin: 'other' } }] }, manifest())).toBe(false);
    expect(isShareInviteCompatible({ ...invite(), actions: [{ ...action, payload: [{ name: 'origin', type: 'number', required: true }] }] }, manifest())).toBe(false);
  });

  it('compares payload fields semantically after encrypted canonical JSON reorders object keys', () => {
    const reorderedEvent = {
      id: event.id,
      label: event.label,
      payload: [{ name: 'from', required: true, type: 'string' as const }],
    };
    const reorderedAction = {
      id: action.id,
      label: action.label,
      payload: [{ name: 'origin', required: true, type: 'string' as const }],
    };

    expect(isShareInviteCompatible({
      ...invite(),
      events: [reorderedEvent],
      actions: [reorderedAction],
    }, manifest())).toBe(true);
  });

  it('rejects malformed non-array offer contracts without throwing', () => {
    expect(isValidChannelShareOfferPayload(offer())).toBe(true);
    expect(() => isValidChannelShareOfferPayload({ ...offer(), events: null })).not.toThrow();
    expect(isValidChannelShareOfferPayload({ ...offer(), events: null })).toBe(false);
    expect(isValidChannelShareOfferPayload({ ...offer(), actions: { bad: true } })).toBe(false);
    expect(isValidChannelShareOfferPayload({ ...offer(), routes: 'bad' })).toBe(false);
    expect(isValidChannelShareOfferPayload({ ...offer(), channel: { ...offer().channel, memberDeviceKeys: null } })).toBe(false);
  });

  it('signs an offer-specific response correlation id for concurrent waiter routing', async () => {
    const aliceIdentity = await createRelationshipIdentity();
    const bobIdentity = await createRelationshipIdentity();
    const relationship = (localIdentity: typeof aliceIdentity, peer: typeof bobIdentity, id: string): Relationship => ({
      id, schemaVersion: 1, personId: 'peer', status: 'active', localIdentity,
      peerPublicKey: peer.publicKey, peerEncPublicKey: peer.encPublicKey, pairContextId: 'pair-context',
      createdAt: '2026-08-20T12:00:00.000Z', updatedAt: '2026-08-20T12:00:00.000Z',
    });
    const alice = relationship(aliceIdentity, bobIdentity, 'alice-bob');
    const bob = relationship(bobIdentity, aliceIdentity, 'bob-alice');
    const descriptor: ChannelDescriptor = {
      id: 'channel-1', schemaVersion: 1, relationshipId: alice.id, dappId: 'game', sensitiveShareId: 'instance-1',
      roomId: 'room-1', roomPassword: 'secret', persistenceKey: 'channel-1',
      memberDeviceKeys: [aliceIdentity.publicKey, bobIdentity.publicKey], status: 'prepared',
      createdAt: '2026-08-20T12:00:00.000Z', updatedAt: '2026-08-20T12:00:00.000Z',
    };
    const controlDoc = new Y.Doc(); const aliceRoot = new Y.Doc(); const bobRoot = new Y.Doc();
    const failedRoot = new Y.Doc(); const failedControl = new Y.Doc();
    await expect(sendChannelShareOffer({
      relationship: alice, descriptor, dappId: 'game', shareId: 'match', shareLabel: 'Match', instanceId: 'failed-instance',
      dappMeta: { name: 'Game', icon: '🎮', color: '#123456' }, events: [event], actions: [action], routes: [route],
      rootDoc: failedRoot, controlDoc: failedControl,
      persistBeforePublish: () => Promise.reject(new Error('pending row persistence failed')),
    })).rejects.toThrow('pending row persistence failed');
    expect(listRelationshipControlOutbox(alice.id, failedRoot)).toHaveLength(1);
    expect([...relationshipChannelMessages(failedControl).values()]).toHaveLength(0);
    const recoveredFirst = await sendChannelShareOffer({
      relationship: alice, descriptor, dappId: 'game', shareId: 'match', shareLabel: 'Match', instanceId: 'recovered-instance',
      dappMeta: { name: 'Game', icon: '🎮', color: '#123456' }, events: [event], actions: [action], routes: [route],
      rootDoc: failedRoot, controlDoc: failedControl,
    });
    expect(recoveredFirst.message.sequence).toBe(1);

    const prepared = await sendChannelShareOffer({
      relationship: alice, descriptor, dappId: 'game', shareId: 'match', shareLabel: 'Match', instanceId: 'instance-1',
      dappMeta: { name: 'Game', icon: '🎮', color: '#123456' }, events: [event], actions: [action], routes: [route],
      rootDoc: aliceRoot, controlDoc,
      beforePublish: (candidate) => {
        expect(relationshipChannelMessages(controlDoc).has(candidate.message.messageId)).toBe(false);
        expect(listRelationshipControlOutbox(alice.id, aliceRoot).map((entry) => entry.message.messageId)).toContain(candidate.message.messageId);
      },
    });
    await expect(verifyOutgoingRelationshipControlEnvelope(prepared.message, alice)).resolves.toBe(true);
    expect(listRelationshipControlOutbox(alice.id, aliceRoot).map((entry) => entry.message.messageId)).toContain(prepared.message.messageId);
    const received = await receiveChannelShareOffer({ message: prepared.message, relationship: bob, rootDoc: bobRoot });
    expect(isShareInviteCompatible({ ...invite(), ...received.payload }, manifest())).toBe(true);
    const accepted = await acceptChannelShareOffer({
      offerMessage: prepared.message, offerPayload: received.payload, offerMessageHash: received.messageHash,
      localDappId: 'local-game', relationship: bob, rootDoc: bobRoot, controlDoc,
    });
    expect(accepted.ack.correlationId).toBe(`share-ack:${prepared.offerId}`);
    await expect(verifyRelationshipControlEnvelope(accepted.ack, alice)).resolves.toBe(true);
    await expect(verifyRelationshipControlEnvelope({ ...accepted.ack, correlationId: 'share-ack:other' }, alice)).resolves.toBe(false);

    const recovered = await receiveChannelShareResponse({
      message: accepted.ack, relationship: alice, rootDoc: aliceRoot,
      expectedOfferId: prepared.offerId, expectedOfferMessageHash: received.messageHash,
    });
    expect(recovered).toMatchObject({ kind: 'accepted', payload: { channelId: descriptor.id } });

    // A later Bob→Alice offer depends on Alice having consumed the late ack in Bob's directional chain.
    const reverseDescriptor = { ...descriptor, id: 'channel-2', relationshipId: bob.id, sensitiveShareId: 'instance-2' };
    const later = await sendChannelShareOffer({
      relationship: bob, descriptor: reverseDescriptor, dappId: 'game', shareId: 'match', shareLabel: 'Match', instanceId: 'instance-2',
      dappMeta: { name: 'Game', icon: '🎮', color: '#123456' }, events: [event], actions: [action], routes: [route],
      rootDoc: bobRoot, controlDoc,
    });
    await expect(receiveChannelShareOffer({ message: later.message, relationship: alice, rootDoc: aliceRoot })).resolves.toBeTruthy();
  }, 20_000);

  it('verifies attached definitions and re-derives staged data from the original signed offer', async () => {
    const aliceIdentity = await createRelationshipIdentity();
    const bobIdentity = await createRelationshipIdentity();
    const timestamp = '2026-08-20T12:00:00.000Z';
    const alice: Relationship = {
      id: 'alice-bob-definition', schemaVersion: 1, personId: 'bob', status: 'active', localIdentity: aliceIdentity,
      peerPublicKey: bobIdentity.publicKey, peerEncPublicKey: bobIdentity.encPublicKey, pairContextId: 'definition-pair',
      createdAt: timestamp, updatedAt: timestamp,
    };
    const bob: Relationship = {
      id: 'bob-alice-definition', schemaVersion: 1, personId: 'alice', status: 'active', localIdentity: bobIdentity,
      peerPublicKey: aliceIdentity.publicKey, peerEncPublicKey: aliceIdentity.encPublicKey, pairContextId: 'definition-pair',
      createdAt: timestamp, updatedAt: timestamp,
    };
    const descriptor: ChannelDescriptor = {
      id: 'definition-channel', schemaVersion: 1, relationshipId: alice.id, dappId: 'game', sensitiveShareId: 'definition-instance',
      roomId: 'definition-room', roomPassword: 'definition-secret', persistenceKey: 'definition-channel',
      memberDeviceKeys: [aliceIdentity.publicKey, bobIdentity.publicKey], status: 'prepared', createdAt: timestamp, updatedAt: timestamp,
    };
    const files = {
      'index.html': '<main>Original signed source</main>',
      'manifest.yaml': JSON.stringify(manifest()),
    };
    const unsignedDefinition = {
      protocol: 'code-app-definition' as const,
      schemaVersion: 1 as const,
      name: 'Game', icon: '🎮', color: '#123456', files,
      manifestVersion: computeDefinitionManifestVersion(files), createdAt: timestamp,
      authorPublicKey: aliceIdentity.publicKey,
    };
    const definition = {
      ...unsignedDefinition,
      signature: await signRelationshipControl(
        unsignedDefinition,
        aliceIdentity.privateKey,
      ),
    };
    const aliceRoot = new Y.Doc();
    const bobRoot = new Y.Doc();
    const controlDoc = new Y.Doc();
    const prepared = await sendChannelShareOffer({
      relationship: alice, descriptor, dappId: 'game', shareId: 'match', shareLabel: 'Match', instanceId: 'definition-instance',
      dappMeta: { name: 'Game', icon: '🎮', color: '#123456' }, events: [event], actions: [action], routes: [route], definition,
      rootDoc: aliceRoot, controlDoc,
    });
    const received = await receiveChannelShareOffer({ message: prepared.message, relationship: bob, rootDoc: bobRoot });
    expect(received.payload.definition?.files['index.html']).toContain('Original signed source');

    if (!received.payload.definition) throw new Error('Expected attached definition');
    received.payload.definition.files['index.html'] = '<main>Mutable staged replacement</main>';
    const inspected = await inspectChannelShareOffer({ message: prepared.message, relationship: bob });
    expect(inspected.payload.definition?.files['index.html']).toContain('Original signed source');
    expect(inspected.payload.definition?.files['index.html']).not.toContain('Mutable staged replacement');

    await expect(sendChannelShareOffer({
      relationship: alice, descriptor, dappId: 'game', shareId: 'match', shareLabel: 'Match', instanceId: 'definition-instance-2',
      dappMeta: { name: 'Game', icon: '🎮', color: '#123456' }, events: [event], actions: [action], routes: [route],
      definition: { ...definition, signature: '0'.repeat(128) }, rootDoc: aliceRoot, controlDoc,
    })).rejects.toThrow(/signature/i);

    const next = await sendChannelShareOffer({
      relationship: alice, descriptor, dappId: 'game', shareId: 'match', shareLabel: 'Match', instanceId: 'definition-instance-3',
      dappMeta: { name: 'Game', icon: '🎮', color: '#123456' }, events: [event], actions: [action], routes: [route],
      definition, rootDoc: aliceRoot, controlDoc,
    });
    await expect(receiveChannelShareOffer({ message: next.message, relationship: bob, rootDoc: bobRoot })).resolves.toBeDefined();
  }, 20_000);
});
