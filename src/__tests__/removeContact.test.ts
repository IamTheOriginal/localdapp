// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createRelationshipIdentity } from '../services/relationshipIdentity.ts';
import { relationshipChannelMessages } from '../services/relationshipChannelControl.ts';
import { registerChannelDescriptor, admitChannelDevice } from '../services/store/channelRegistry.ts';
import { createChannelShare } from '../services/store/channelShares.ts';
import { persistRemotePurgeIntent, listRemotePurgeIntents, listRemotePurges } from '../services/store/remotePurgeQueue.ts';

/**
 * Full local teardown of an active contact: removeContact must send a signed erase
 * request per isolated channel, wipe every local trace (channel registry, share rows,
 * staged offers, purge queues, control capability), destroy the control
 * room, and finally delete the relationship and person records.
 */

const state = vi.hoisted(() => ({
  rootDoc: null as unknown as Y.Doc,
  controlDoc: null as unknown as Y.Doc,
  destroyedControls: [] as unknown[],
  cancelledPairings: [] as string[],
  dappDocs: new Map<string, unknown>(),
}));

vi.mock('../services/store/docs.ts', async () => {
  const YModule = await import('yjs');
  return {
    getRootDoc: () => state.rootDoc,
    getRootPersistence: () => null,
    compactRootPersistence: () => Promise.resolve(),
    clearIndexeddbDocument: () => Promise.resolve(),
    getDappDoc: (dappId: string) => {
      let doc = state.dappDocs.get(dappId);
      if (!doc) {
        doc = new YModule.Doc();
        state.dappDocs.set(dappId, doc);
      }
      return doc;
    },
    generateRoomPassword: () => Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
});

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
    destroyControl: (capability: unknown) => {
      state.destroyedControls.push(capability);
      return Promise.resolve();
    },
  }),
}));

vi.mock('../services/relationshipPairingRuntime.ts', () => ({
  RelationshipPairingRuntime: class {
    cancelRelationship(relationshipId: string): Promise<void> {
      state.cancelledPairings.push(relationshipId);
      return Promise.resolve();
    }

    sweepCompletedPairingLobbies(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

function seedRelationship(doc: Y.Doc, id: string, personId: string, local: Awaited<ReturnType<typeof createRelationshipIdentity>>, peer: Awaited<ReturnType<typeof createRelationshipIdentity>>): void {
  const value = new Y.Map<unknown>();
  value.set('id', id);
  value.set('personId', personId);
  value.set('status', 'active');
  value.set('localIdentity', { ...local });
  value.set('peerPublicKey', peer.publicKey);
  value.set('peerEncPublicKey', peer.encPublicKey);
  value.set('pairContextId', 'pair-context-remove');
  value.set('createdAt', new Date().toISOString());
  value.set('updatedAt', new Date().toISOString());
  doc.getMap('relationships').set(id, value);
}

describe('removeContact', () => {
  it('erases every local trace of the contact and asks the peer to purge its channels', async () => {
    const alice = await createRelationshipIdentity();
    const bob = await createRelationshipIdentity();
    const root = new Y.Doc();
    state.rootDoc = root;
    state.controlDoc = new Y.Doc();
    state.destroyedControls = [];
    state.cancelledPairings = [];
    state.dappDocs = new Map();

    const person = new Y.Map<unknown>();
    person.set('id', 'person-bob');
    person.set('displayName', 'Bob');
    root.getMap('people').set('person-bob', person);
    seedRelationship(root, 'rel-remove', 'person-bob', alice, bob);
    const capability = {
      protocol: 'relationship-control-capability', schemaVersion: 1,
      capabilityId: 'cap-remove', roomId: 'control-room-id', roomPassword: 'control-room-secret',
      pairContextId: 'pair-context-remove', createdAt: new Date().toISOString(),
    };
    root.getMap('relationshipControlCapabilities').set('rel-remove', capability);

    // One installed channel with an active share, plus loose per-relationship state.
    const tuple = { relationshipId: 'rel-remove', dappId: 'dapp-recipes', sensitiveShareId: 'instance-1' };
    registerChannelDescriptor(tuple, root);
    admitChannelDevice(tuple, alice.publicKey, root);
    const descriptor = admitChannelDevice(tuple, bob.publicKey, root);
    createChannelShare({
      dappId: 'dapp-recipes', shareId: 'share-1', instanceId: 'instance-1', relationshipId: 'rel-remove',
      channelId: descriptor.id, eventIds: [], actionIds: [], offerId: 'offer-1', status: 'active',
    }, root);
    root.getMap('stagedChannelShareOffers').set('offer-1', { relationshipId: 'rel-remove', message: { messageId: 'm1' } });
    persistRemotePurgeIntent({ relationshipId: 'rel-remove', channelId: 'stale-channel', reason: 'grant-revoked' }, root);

    vi.resetModules();
    const runtime = await import('../services/browserRelationshipRuntime.ts');
    await runtime.removeContact('rel-remove');

    // The peer got a signed erase request for the installed channel.
    const purgeRequests = Array.from(relationshipChannelMessages(state.controlDoc).values())
      .filter((message) => message.kind === 'channel-purge-request' && message.recipientPublicKey === bob.publicKey);
    expect(purgeRequests.length).toBeGreaterThanOrEqual(1);

    // Every local trace is gone.
    expect(root.getMap('relationships').has('rel-remove')).toBe(false);
    expect(root.getMap('people').has('person-bob')).toBe(false);
    expect(root.getMap('relationshipControlCapabilities').has('rel-remove')).toBe(false);
    expect(root.getMap('channelDescriptors').size).toBe(0);
    expect(root.getMap('channelShares').size).toBe(0);
    expect(root.getMap('stagedChannelShareOffers').size).toBe(0);
    expect(listRemotePurgeIntents(root)).toEqual([]);
    expect(listRemotePurges(root)).toEqual([]);

    // Control room and any pairing lobby remnants were torn down.
    expect(state.destroyedControls).toEqual([capability]);
    expect(state.cancelledPairings).toEqual(['rel-remove']);
  }, 20_000);

  it('delegates pending relationships to the pending-removal path', async () => {
    const alice = await createRelationshipIdentity();
    const root = new Y.Doc();
    state.rootDoc = root;
    state.controlDoc = new Y.Doc();
    state.destroyedControls = [];
    state.cancelledPairings = [];

    const person = new Y.Map<unknown>();
    person.set('id', 'person-pending');
    person.set('displayName', 'Pending');
    root.getMap('people').set('person-pending', person);
    const value = new Y.Map<unknown>();
    value.set('id', 'rel-pending');
    value.set('personId', 'person-pending');
    value.set('status', 'pending');
    value.set('localIdentity', { ...alice });
    value.set('createdAt', new Date().toISOString());
    value.set('updatedAt', new Date().toISOString());
    root.getMap('relationships').set('rel-pending', value);

    vi.resetModules();
    const runtime = await import('../services/browserRelationshipRuntime.ts');
    await runtime.removeContact('rel-pending');

    expect(root.getMap('relationships').has('rel-pending')).toBe(false);
    expect(root.getMap('people').has('person-pending')).toBe(false);
    expect(state.cancelledPairings).toEqual(['rel-pending']);
  }, 20_000);
});
