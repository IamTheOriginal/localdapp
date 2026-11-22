// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type {
  ChannelShare, Relationship, RelationshipChannelControlMessage,
} from '../types.ts';
import { createRelationshipIdentity } from '../services/relationshipIdentity.ts';
import {
  acceptChannelShareOffer, receiveChannelShareOffer, relationshipChannelMessages,
} from '../services/relationshipChannelControl.ts';

/**
 * End-to-end reproduction of the on-device shared-expenses flow: device A opens a
 * channel share ($share.open), device B accepts the staged invite, and B's signed
 * ack must flip A's pending row to active. Exercises the real browser runtime
 * scan/waiter path with real crypto — only the WebRTC transport is simulated by
 * sharing one control doc between both peers.
 */

const state = vi.hoisted(() => ({
  rootDoc: null as unknown as Y.Doc,
  controlDoc: null as unknown as Y.Doc,
}));

vi.mock('../services/store/docs.ts', () => ({
  getRootDoc: () => state.rootDoc,
  getRootPersistence: () => null,
  compactRootPersistence: () => Promise.resolve(),
  generateRoomPassword: () => Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((byte) => byte.toString(16).padStart(2, '0')).join(''),
}));

vi.mock('../services/relationshipPairingRoomManager.ts', () => ({
  createBrowserRelationshipPairingRoomManager: () => ({
    openControl: () => ({
      descriptor: { id: 'control-room' },
      doc: state.controlDoc,
      persistenceReady: Promise.resolve(),
      state: 'connected',
    }),
    connect: () => undefined,
    compact: () => Promise.resolve(),
    dispose: () => undefined,
  }),
}));

vi.mock('../services/relationshipPairingRuntime.ts', () => ({
  RelationshipPairingRuntime: class {},
}));

function seedRelationship(doc: Y.Doc, id: string, local: Awaited<ReturnType<typeof createRelationshipIdentity>>, peer: Awaited<ReturnType<typeof createRelationshipIdentity>>): void {
  const value = new Y.Map<unknown>();
  value.set('id', id);
  value.set('personId', 'peer-person');
  value.set('status', 'active');
  value.set('localIdentity', { ...local });
  value.set('peerPublicKey', peer.publicKey);
  value.set('peerEncPublicKey', peer.encPublicKey);
  value.set('pairContextId', 'pair-context-e2e');
  value.set('createdAt', new Date().toISOString());
  value.set('updatedAt', new Date().toISOString());
  doc.getMap('relationships').set(id, value);
}

async function waitFor<T>(probe: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('e2e harness: condition not met within timeout');
}

interface ShareRow {
  id: string;
  status?: string;
  offerId?: string;
  channelId: string;
}

function readShareRows(doc: Y.Doc): ShareRow[] {
  return Array.from(doc.getMap('channelShares').values()).map((row) => {
    const yrow = row as Y.Map<unknown>;
    return {
      id: String(yrow.get('id')),
      status: yrow.has('status') ? String(yrow.get('status')) : undefined,
      offerId: yrow.has('offerId') ? String(yrow.get('offerId')) : undefined,
      channelId: String(yrow.get('channelId')),
    };
  });
}

function readDescriptorStatuses(doc: Y.Doc): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const row of doc.getMap('channelDescriptors').values()) {
    const yrow = row as Y.Map<unknown>;
    statuses.set(String(yrow.get('id')), yrow.has('status') ? String(yrow.get('status')) : '');
  }
  return statuses;
}

describe('channel share handshake end-to-end (A invites → B accepts → A activates)', () => {
  it('flips the sender pending share to active when the live accept arrives', async () => {
    const alice = await createRelationshipIdentity();
    const bob = await createRelationshipIdentity();
    const aliceRoot = new Y.Doc();
    const bobRoot = new Y.Doc();
    const control = new Y.Doc();
    state.rootDoc = aliceRoot;
    state.controlDoc = control;

    seedRelationship(aliceRoot, 'rel-1', alice, bob);
    seedRelationship(bobRoot, 'rel-1', bob, alice);
    aliceRoot.getMap('relationshipControlCapabilities').set('rel-1', {
      protocol: 'relationship-control-capability', schemaVersion: 1,
      capabilityId: 'cap-1', roomId: 'control-room-id', roomPassword: 'control-room-secret',
    });

    // Import the runtime AFTER the docs are bound so module-level getRootDoc() picks up aliceRoot.
    vi.resetModules();
    const runtime = await import('../services/browserRelationshipRuntime.ts');

    const event = { id: 'expense.shared', label: 'Expense shared', payload: [{ name: 'expenseId', type: 'string' as const, required: true }] };
    const action = { id: 'expense.receive', label: 'Receive expense', payload: [{ name: 'expenseId', type: 'string' as const, required: true }] };
    const route = { eventId: event.id, actionId: action.id, fieldMap: { expenseId: 'expenseId' } };

    const sharePromise = runtime.createChannelShare({
      dappId: 'dapp-expenses',
      relationshipId: 'rel-1',
      shareId: 'expense-settlement',
      shareLabel: 'Expense settlement',
      instanceId: 'instance-1',
      dappMeta: { name: 'Shared Expenses', icon: '🧾', color: '#0d8f78' },
      events: [event],
      actions: [action],
      routes: [route],
    }).then((result) => result as { status: string; share?: ChannelShare });

    // Wait for A's signed offer to land in the shared control room.
    const offerMessage = await waitFor<RelationshipChannelControlMessage>(() => {
      const found = Array.from(relationshipChannelMessages(control).values())
        .find((message) => message.kind === 'channel-share-offer'
          && message.recipientPublicKey === bob.publicKey);
      return found;
    });

    // A must have durably staged its pending row before publication.
    const pendingRow = await waitFor<ShareRow>(() => readShareRows(aliceRoot).find((share) => share.status === 'pending'));

    // Device B: stage the offer, then accept through the real consent path.
    const bobRelationship = {
      id: 'rel-1', schemaVersion: 1 as const, personId: 'alice-person', status: 'active' as const,
      localIdentity: { ...bob }, peerPublicKey: alice.publicKey, peerEncPublicKey: alice.encPublicKey,
      pairContextId: 'pair-context-e2e',
    } as Relationship;
    const received = await receiveChannelShareOffer({ message: offerMessage, relationship: bobRelationship, rootDoc: bobRoot });
    await acceptChannelShareOffer({
      offerMessage, offerPayload: received.payload, offerMessageHash: received.messageHash,
      localDappId: 'bob-expenses', relationship: bobRelationship, rootDoc: bobRoot, controlDoc: control,
    });

    // B's ack now syncs into the control room; A's observer must resolve the waiter and activate.
    const result = await sharePromise;
    expect(result.status).toBe('accepted');

    const activated = await waitFor<ShareRow | undefined>(() => readShareRows(aliceRoot)
      .find((share) => share.id === pendingRow.id && share.status === 'active'));
    expect(activated?.offerId).toBe(pendingRow.offerId);

    expect(readDescriptorStatuses(aliceRoot).get(pendingRow.channelId)).toBe('active');
  });

  it('activates via the late-response path when A reloads before B accepts', async () => {
    const alice = await createRelationshipIdentity();
    const bob = await createRelationshipIdentity();
    const aliceRoot = new Y.Doc();
    const bobRoot = new Y.Doc();
    const control = new Y.Doc();
    state.rootDoc = aliceRoot;
    state.controlDoc = control;

    seedRelationship(aliceRoot, 'rel-2', alice, bob);
    seedRelationship(bobRoot, 'rel-2', bob, alice);
    aliceRoot.getMap('relationshipControlCapabilities').set('rel-2', {
      protocol: 'relationship-control-capability', schemaVersion: 1,
      capabilityId: 'cap-2', roomId: 'control-room-id', roomPassword: 'control-room-secret',
    });

    vi.resetModules();
    const runtime = await import('../services/browserRelationshipRuntime.ts');
    const channelControl = await import('../services/relationshipChannelControl.ts');
    const channelShares = await import('../services/store/channelShares.ts');
    const channelRegistry = await import('../services/store/channelRegistry.ts');

    const event = { id: 'expense.shared', label: 'Expense shared', payload: [{ name: 'expenseId', type: 'string' as const, required: true }] };
    const action = { id: 'expense.receive', label: 'Receive expense', payload: [{ name: 'expenseId', type: 'string' as const, required: true }] };
    const route = { eventId: event.id, actionId: action.id, fieldMap: { expenseId: 'expenseId' } };

    // Attach A's control-room observers (as the app does on startup).
    runtime.ensureRelationshipControl('rel-2');

    // Previous session: registered channel, published offer, staged pending row — then reloaded.
    const tuple = { relationshipId: 'rel-2', dappId: 'dapp-expenses', sensitiveShareId: 'instance-2' };
    channelRegistry.registerChannelDescriptor(tuple);
    channelRegistry.admitChannelDevice(tuple, alice.publicKey);
    const descriptor = channelRegistry.admitChannelDevice(tuple, bob.publicKey);
    const prepared = await channelControl.sendChannelShareOffer({
      relationship: requireRelationshipFixture(alice, bob),
      descriptor,
      dappId: 'dapp-expenses', shareId: 'expense-settlement', shareLabel: 'Expense settlement', instanceId: 'instance-2',
      dappMeta: { name: 'Shared Expenses', icon: '🧾', color: '#0d8f78' },
      events: [event], actions: [action], routes: [route],
      rootDoc: aliceRoot, controlDoc: control,
    });
    channelRegistry.setChannelControlOfferMessage(descriptor.id, prepared.message.messageId, aliceRoot);
    channelShares.createChannelShare({
      dappId: 'dapp-expenses', shareId: 'expense-settlement', instanceId: 'instance-2', relationshipId: 'rel-2',
      channelId: descriptor.id, eventIds: [event.id], actionIds: [action.id],
      offerId: prepared.offerId, controlOfferMessageId: prepared.message.messageId, status: 'pending',
    }, aliceRoot);

    const offerMessage = await waitFor<RelationshipChannelControlMessage>(() => Array.from(relationshipChannelMessages(control).values())
      .find((message) => message.kind === 'channel-share-offer' && message.recipientPublicKey === bob.publicKey));
    const pendingRow = await waitFor<ShareRow>(() => readShareRows(aliceRoot).find((share) => share.status === 'pending'));

    // Device B accepts after A's reload — no in-memory waiter exists anymore.
    const bobRelationship = {
      id: 'rel-2', schemaVersion: 1 as const, personId: 'alice-person', status: 'active' as const,
      localIdentity: { ...bob }, peerPublicKey: alice.publicKey, peerEncPublicKey: alice.encPublicKey,
      pairContextId: 'pair-context-e2e',
    } as Relationship;
    const received = await receiveChannelShareOffer({ message: offerMessage, relationship: bobRelationship, rootDoc: bobRoot });
    await acceptChannelShareOffer({
      offerMessage, offerPayload: received.payload, offerMessageHash: received.messageHash,
      localDappId: 'bob-expenses', relationship: bobRelationship, rootDoc: bobRoot, controlDoc: control,
    });

    await waitFor<ShareRow | undefined>(() => readShareRows(aliceRoot)
      .find((share) => share.id === pendingRow.id && share.status === 'active'));
    expect(readDescriptorStatuses(aliceRoot).get(pendingRow.channelId)).toBe('active');
  });

  it('still activates when the control room lost the original offer copy', async () => {
    const alice = await createRelationshipIdentity();
    const bob = await createRelationshipIdentity();
    const aliceRoot = new Y.Doc();
    const bobRoot = new Y.Doc();
    const control = new Y.Doc();
    state.rootDoc = aliceRoot;
    state.controlDoc = control;

    seedRelationship(aliceRoot, 'rel-3', alice, bob);
    seedRelationship(bobRoot, 'rel-3', bob, alice);
    aliceRoot.getMap('relationshipControlCapabilities').set('rel-3', {
      protocol: 'relationship-control-capability', schemaVersion: 1,
      capabilityId: 'cap-3', roomId: 'control-room-id', roomPassword: 'control-room-secret',
    });

    vi.resetModules();
    const runtime = await import('../services/browserRelationshipRuntime.ts');

    const event = { id: 'expense.shared', label: 'Expense shared', payload: [{ name: 'expenseId', type: 'string' as const, required: true }] };
    const action = { id: 'expense.receive', label: 'Receive expense', payload: [{ name: 'expenseId', type: 'string' as const, required: true }] };
    const route = { eventId: event.id, actionId: action.id, fieldMap: { expenseId: 'expenseId' } };

    const sharePromise = runtime.createChannelShare({
      dappId: 'dapp-expenses',
      relationshipId: 'rel-3',
      shareId: 'expense-settlement',
      shareLabel: 'Expense settlement',
      instanceId: 'instance-3',
      dappMeta: { name: 'Shared Expenses', icon: '🧾', color: '#0d8f78' },
      events: [event],
      actions: [action],
      routes: [route],
    }).then((result) => result as { status: string });

    const offerMessage = await waitFor<RelationshipChannelControlMessage>(() => Array.from(relationshipChannelMessages(control).values())
      .find((message) => message.kind === 'channel-share-offer' && message.recipientPublicKey === bob.publicKey));
    const pendingRow = await waitFor<ShareRow>(() => readShareRows(aliceRoot).find((share) => share.status === 'pending'));

    // Storage loss on A: the shared control room no longer holds the signed offer.
    relationshipChannelMessages(control).delete(offerMessage.messageId);
    expect(Array.from(relationshipChannelMessages(control).values()).some((message) => message.kind === 'channel-share-offer')).toBe(false);

    // Device B accepts anyway.
    const bobRelationship = {
      id: 'rel-3', schemaVersion: 1 as const, personId: 'alice-person', status: 'active' as const,
      localIdentity: { ...bob }, peerPublicKey: alice.publicKey, peerEncPublicKey: alice.encPublicKey,
      pairContextId: 'pair-context-e2e',
    } as Relationship;
    const received = await receiveChannelShareOffer({ message: offerMessage, relationship: bobRelationship, rootDoc: bobRoot });
    await acceptChannelShareOffer({
      offerMessage, offerPayload: received.payload, offerMessageHash: received.messageHash,
      localDappId: 'bob-expenses', relationship: bobRelationship, rootDoc: bobRoot, controlDoc: control,
    });

    const result = await sharePromise;
    expect(result.status).toBe('accepted');
    await waitFor<ShareRow | undefined>(() => readShareRows(aliceRoot)
      .find((share) => share.id === pendingRow.id && share.status === 'active'));
    expect(readDescriptorStatuses(aliceRoot).get(pendingRow.channelId)).toBe('active');

    // The staged offer copy is consumed once the response is applied.
    expect(aliceRoot.getMap('stagedChannelShareOffers').size).toBe(0);
  });
});

function requireRelationshipFixture(
  local: Awaited<ReturnType<typeof createRelationshipIdentity>>,
  peer: Awaited<ReturnType<typeof createRelationshipIdentity>>,
): Relationship {
  return {
    id: 'rel-2', schemaVersion: 1, personId: 'peer-person', status: 'active',
    localIdentity: { ...local }, peerPublicKey: peer.publicKey, peerEncPublicKey: peer.encPublicKey,
    pairContextId: 'pair-context-e2e',
  } as Relationship;
}
