import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Relationship } from '../types.ts';
import { createRelationshipIdentity } from '../services/relationshipIdentity.ts';
import { hashRelationshipControl } from '../services/relationshipProtocol.ts';
import {
  consumeUnprocessableControlMessage, getRelationshipControlOutboxMessage, listRelationshipControlOutbox,
  receiveChannelPurgeAck, receiveChannelPurgeRequest, relationshipChannelMessages,
  sendChannelPurgeRequest,
} from '../services/relationshipChannelControl.ts';
import {
  acknowledgeRemotePurge,
  enqueueRemotePurge,
  listPendingRemotePurges, listRemotePurgeIntents, persistRemotePurgeIntent,
  recordRemotePurgeAttempt, recordRemotePurgeIntentFailure,
} from '../services/store/remotePurgeQueue.ts';

async function relationshipPair(): Promise<{ alice: Relationship; bob: Relationship }> {
  const aliceIdentity = await createRelationshipIdentity();
  const bobIdentity = await createRelationshipIdentity();
  const timestamp = '2026-08-15T00:00:00.000Z';
  return {
    alice: {
      id: 'alice-to-bob', schemaVersion: 1, personId: 'bob', status: 'active',
      localIdentity: aliceIdentity, peerPublicKey: bobIdentity.publicKey,
      peerEncPublicKey: bobIdentity.encPublicKey, pairContextId: 'pair-context',
      createdAt: timestamp, updatedAt: timestamp,
    },
    bob: {
      id: 'bob-to-alice', schemaVersion: 1, personId: 'alice', status: 'active',
      localIdentity: bobIdentity, peerPublicKey: aliceIdentity.publicKey,
      peerEncPublicKey: aliceIdentity.encPublicKey, pairContextId: 'pair-context',
      createdAt: timestamp, updatedAt: timestamp,
    },
  };
}

describe('relationship channel purge lifecycle', () => {
  it('requires peer-authenticated local purge before acknowledging deletion', async () => {
    const { alice, bob } = await relationshipPair();
    const aliceRoot = new Y.Doc();
    const bobRoot = new Y.Doc();
    const controlDoc = new Y.Doc();
    const prepared = await sendChannelPurgeRequest({
      relationship: alice,
      channelId: 'channel-one',
      reason: 'grant-revoked',
      rootDoc: aliceRoot,
      controlDoc,
      now: new Date('2026-08-15T01:00:00.000Z'),
    });
    const purged: string[] = [];
    const received = await receiveChannelPurgeRequest({
      message: prepared.message,
      relationship: bob,
      rootDoc: bobRoot,
      controlDoc,
      purgeLocal: (channelId) => {
        purged.push(channelId);
        return Promise.resolve();
      },
      now: new Date('2026-08-15T01:01:00.000Z'),
    });
    expect(purged).toEqual(['channel-one']);
    expect(received.payload.reason).toBe('grant-revoked');
    const ack = await receiveChannelPurgeAck({
      message: received.ack,
      relationship: alice,
      rootDoc: aliceRoot,
      pending: prepared,
    });
    expect(ack.requestId).toBe(prepared.requestId);
    expect(ack.channelId).toBe('channel-one');
    expect(ack.requestMessageHash).toBe(prepared.messageHash);
  }, 20_000);

  it('does not acknowledge when local erasure fails', async () => {
    const { alice, bob } = await relationshipPair();
    const prepared = await sendChannelPurgeRequest({
      relationship: alice,
      channelId: 'channel-failure',
      reason: 'dapp-deleted',
      rootDoc: new Y.Doc(),
      controlDoc: new Y.Doc(),
    });
    const controlDoc = new Y.Doc();
    await expect(receiveChannelPurgeRequest({
      message: prepared.message,
      relationship: bob,
      rootDoc: new Y.Doc(),
      controlDoc,
      purgeLocal: () => Promise.reject(new Error('IndexedDB deletion blocked')),
    })).rejects.toThrow(/deletion blocked/);
    expect(controlDoc.getMap('relationshipChannelControlMessages').size).toBe(0);
  }, 20_000);

  it('a message that cannot be processed is given up on, so the contact is not blocked for good', async () => {
    const { alice, bob } = await relationshipPair();
    const aliceRoot = new Y.Doc();
    const bobRoot = new Y.Doc();
    const controlDoc = new Y.Doc();
    const send = (channelId: string) => sendChannelPurgeRequest({ relationship: alice, channelId, reason: 'grant-revoked', rootDoc: aliceRoot, controlDoc });
    const first = await send('channel-broken');
    const second = await send('channel-fine');
    const receive = (message: typeof first.message, purgeLocal: () => Promise<void>) =>
      receiveChannelPurgeRequest({ message, relationship: bob, rootDoc: bobRoot, controlDoc, purgeLocal });

    // The first one fails for good; while it holds the chain position, the second is refused.
    await expect(receive(first.message, () => Promise.reject(new Error('cannot purge')))).rejects.toThrow(/cannot purge/);
    await expect(receive(second.message, () => Promise.resolve())).rejects.toThrow(/broken message chain/);

    // A message that is not the peer's next one never moves the chain…
    expect(await consumeUnprocessableControlMessage(second.message, bob, bobRoot)).toBe(false);
    const forged = { ...first.message, signature: second.message.signature };
    expect(await consumeUnprocessableControlMessage(forged, bob, bobRoot)).toBe(false);
    // …the genuine next one can be dropped, and then the contact works again.
    expect(await consumeUnprocessableControlMessage(first.message, bob, bobRoot)).toBe(true);
    expect(await consumeUnprocessableControlMessage(first.message, bob, bobRoot)).toBe(false);
    const received = await receive(second.message, () => Promise.resolve());
    expect(received.payload.channelId).toBe('channel-fine');
  }, 20_000);

  it('serializes concurrent outgoing messages and durably recovers an unpublished request', async () => {
    const { alice } = await relationshipPair();
    const rootDoc = new Y.Doc();
    const controlDoc = new Y.Doc();
    const [first, second] = await Promise.all([
      sendChannelPurgeRequest({
        relationship: alice, channelId: 'channel-a', reason: 'grant-revoked',
        requestId: 'crash-recoverable-request', rootDoc, controlDoc, publish: false,
      }),
      sendChannelPurgeRequest({
        relationship: alice, channelId: 'channel-b', reason: 'dapp-deleted',
        rootDoc, controlDoc, publish: false,
      }),
    ]);
    const ordered = [first.message, second.message].sort((left, right) => left.sequence - right.sequence);
    expect(ordered.map((message) => message.sequence)).toEqual([0, 1]);
    expect(ordered[1].previousMessageHash).toBe(await hashRelationshipControl(ordered[0] as unknown as import('../types.ts').CanonicalJson));
    expect(getRelationshipControlOutboxMessage(alice.id, 'crash-recoverable-request', rootDoc)?.messageId)
      .toBe(first.message.messageId);
    expect(listRelationshipControlOutbox(alice.id, rootDoc)).toHaveLength(2);
    expect(relationshipChannelMessages(controlDoc).size).toBe(0);
  });

  it('retains offer cleanup metadata when purge preparation fails', () => {
    const rootDoc = new Y.Doc();
    const intent = persistRemotePurgeIntent({
      relationshipId: 'relationship-1', channelId: 'channel-1',
      controlOfferMessageId: 'credential-offer-message', reason: 'dapp-deleted',
    }, rootDoc);
    recordRemotePurgeIntentFailure(intent.intentId, new Error('control persistence blocked'), rootDoc);
    expect(listRemotePurgeIntents(rootDoc)[0]).toMatchObject({
      controlOfferMessageId: 'credential-offer-message', attempts: 1,
    });
  });

  it('persists retry attempts and terminal acknowledgement status', async () => {
    const { alice } = await relationshipPair();
    const rootDoc = new Y.Doc();
    const controlDoc = new Y.Doc();
    const prepared = await sendChannelPurgeRequest({
      relationship: alice,
      channelId: 'channel-queued',
      reason: 'dapp-deleted',
      rootDoc,
      controlDoc,
      publish: false,
    });
    expect(relationshipChannelMessages(controlDoc).size).toBe(0);
    const queued = enqueueRemotePurge({
      requestId: prepared.requestId,
      relationshipId: alice.id,
      channelId: prepared.channelId,
      reason: prepared.reason,
      requestMessage: prepared.message,
      requestMessageHash: prepared.messageHash,
    }, rootDoc);
    expect(listPendingRemotePurges(rootDoc)).toEqual([queued]);
    relationshipChannelMessages(controlDoc).set(prepared.message.messageId, prepared.message);
    expect(relationshipChannelMessages(controlDoc).size).toBe(1);
    expect(recordRemotePurgeAttempt(queued.requestId, rootDoc).attempts).toBe(1);
    expect(acknowledgeRemotePurge(queued.requestId, '2026-08-15T02:00:00.000Z', rootDoc).status).toBe('acknowledged');
    expect(listPendingRemotePurges(rootDoc)).toEqual([]);
  }, 20_000);
});
