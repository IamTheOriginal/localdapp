import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { must } from './helpers/must.ts';
import { createRelationshipIdentity } from '../services/relationshipIdentity.ts';
import { RelationshipPairingRuntime } from '../services/relationshipPairingRuntime.ts';
import {
  RelationshipPairingRoomManager, type RelationshipPairingProvider, type RelationshipPairingRoomDescriptor,
} from '../services/relationshipPairingRoomManager.ts';
import { createPerson } from '../services/store/people.ts';
import { createRelationship, getRelationshipControlCapability } from '../services/store/relationships.ts';
import { deriveRelationshipSafetyNumber } from '../services/relationshipProtocol.ts';

interface TestProvider extends RelationshipPairingProvider { fields: Map<string, unknown>; }
function networkHarness() {
  const connected = new Map<string, Set<Y.Doc>>();
  const providers: TestProvider[] = [];
  const persistences: Array<{ destroy: ReturnType<typeof vi.fn>; clearData: ReturnType<typeof vi.fn> }> = [];
  // Simulated per-device IndexedDB: destroy() snapshots the doc, a later create on the
  // same device restores it, clearData erases it.
  const stateStore = new Map<string, Uint8Array>();
  const makeManager = (device = 'device') => new RelationshipPairingRoomManager({
    createDoc: () => new Y.Doc(),
    createPersistence: (key: string, doc: Y.Doc) => {
      const storeKey = `${device}::${key}`;
      const saved = stateStore.get(storeKey);
      if (saved) Y.applyUpdate(doc, saved);
      const persistence = {
        whenSynced: Promise.resolve(),
        destroy: vi.fn(() => { stateStore.set(storeKey, Y.encodeStateAsUpdate(doc)); }),
        clearData: vi.fn(() => { stateStore.delete(storeKey); }),
      };
      persistences.push(persistence);
      return persistence;
    },
    createProvider: (descriptor: RelationshipPairingRoomDescriptor, doc: Y.Doc) => {
      const fields = new Map<string, unknown>(); const status = new Set<(value: { connected: boolean }) => void>();
      const key = `${descriptor.roomId}:${descriptor.roomPassword}`; let update: ((value: Uint8Array, origin: unknown) => void) | undefined;
      const provider: TestProvider = {
        fields, awareness: { setLocalStateField: (name, value) => fields.set(name, value) },
        connect: () => {
          const peers = connected.get(key) ?? new Set<Y.Doc>();
          peers.forEach((peer) => { Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), 'network'); Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc), 'network'); });
          peers.add(doc); connected.set(key, peers);
          update = (value, origin) => { if (origin !== 'network') peers.forEach((peer) => { if (peer !== doc) Y.applyUpdate(peer, value, 'network'); }); };
          doc.on('update', update); status.forEach((listener) => listener({ connected: true }));
        },
        disconnect: () => { connected.get(key)?.delete(doc); if (update) doc.off('update', update); status.forEach((listener) => listener({ connected: false })); },
        destroy: vi.fn(), on: (_name, listener) => status.add(listener), off: (_name, listener) => status.delete(listener),
      };
      providers.push(provider); return provider;
    },
  });
  return { makeManager, providers, persistences, stateStore };
}

function lobbyPersistenceKeys(harness: ReturnType<typeof networkHarness>): string[] {
  return [...harness.stateStore.keys()].filter((key) => key.includes('relationship-pairing-lobby'));
}

async function owner(root: Y.Doc, personName: string) {
  const person = createPerson(personName, {}, root); const identity = await createRelationshipIdentity();
  return createRelationship(person.id, identity, {}, root);
}

async function pair(inviter: RelationshipPairingRuntime, invitee: RelationshipPairingRuntime, inviterRelationshipId: string, inviteePersonId: string) {
  const issued = await inviter.createInvite(inviterRelationshipId, { displayName: 'Alice' });
  inviter.connectInvite(issued.invite.inviteId);
  const accepted = await invitee.acceptInvite(issued.uri, inviteePersonId, { displayName: 'Bob' });
  invitee.connectSession(accepted.sessionId);
  const listed = await inviter.listRequests(issued.invite.inviteId);
  const approved = await inviter.approve(issued.invite.inviteId, listed[0].request.requestId);
  const completed = await invitee.complete(accepted.sessionId);
  return { issued, accepted, approved, completed: must(completed) };
}

describe('RelationshipPairingRuntime', () => {
  it('runs signed two-stage pairing, pins peers, installs capability, and rejects replay', async () => {
    const network = networkHarness(); const aliceDoc = new Y.Doc(); const bobDoc = new Y.Doc();
    const aliceRelationship = await owner(aliceDoc, 'Bob'); const bobPerson = createPerson('Alice', {}, bobDoc);
    const aliceRooms = network.makeManager(); const bobRooms = network.makeManager();
    const alice = new RelationshipPairingRuntime({ rootDoc: aliceDoc, rooms: aliceRooms });
    const bob = new RelationshipPairingRuntime({ rootDoc: bobDoc, rooms: bobRooms });
    const result = await pair(alice, bob, aliceRelationship.id, bobPerson.id);

    expect(result.approved.relationship.peerPublicKey).toBe(result.accepted.relationship.localIdentity.publicKey);
    expect(result.completed.relationship.peerPublicKey).toBe(aliceRelationship.localIdentity.publicKey);
    // Each side learns the peer's self-announced name from the signed handshake.
    expect(result.accepted.inviterDisplayName).toBe('Alice');
    expect(result.approved.peerDisplayName).toBe('Bob');
    expect(result.completed.peerDisplayName).toBe('Alice');
    expect(result.completed.capability).toEqual(result.approved.capability);
    expect(getRelationshipControlCapability(aliceRelationship.id, aliceDoc)).toEqual(result.approved.capability);
    expect(getRelationshipControlCapability(result.accepted.relationship.id, bobDoc)).toEqual(result.approved.capability);
    await expect(alice.approve(result.issued.invite.inviteId, result.accepted.request.requestId)).rejects.toThrow(/consumed/);
    await expect(bob.complete(result.accepted.sessionId)).rejects.toThrow(/replay/);
    await expect(bob.acceptInvite(result.issued.uri, bobPerson.id)).rejects.toThrow(/replay/);
  }, 20_000);

  it('gives both sides the same safety number BEFORE the pairing is approved', async () => {
    const network = networkHarness(); const aliceDoc = new Y.Doc(); const bobDoc = new Y.Doc();
    const aliceRelationship = await owner(aliceDoc, 'Bob'); const bobPerson = createPerson('Alice', {}, bobDoc);
    const alice = new RelationshipPairingRuntime({ rootDoc: aliceDoc, rooms: network.makeManager() });
    const bob = new RelationshipPairingRuntime({ rootDoc: bobDoc, rooms: network.makeManager() });

    const issued = await alice.createInvite(aliceRelationship.id, { displayName: 'Alice' });
    alice.connectInvite(issued.invite.inviteId);
    const accepted = await bob.acceptInvite(issued.uri, bobPerson.id, { displayName: 'Bob' });
    bob.connectSession(accepted.sessionId);
    const [listed] = await alice.listRequests(issued.invite.inviteId);

    // Alice hosts: she knows the requester's key only from the request in front of her.
    const hosting = must(alice.pendingPairingParties(aliceRelationship.id));
    expect(hosting.peerPublicKey).toBeNull();
    const aliceNumber = await deriveRelationshipSafetyNumber(
      hosting.localPublicKey, listed.request.requesterPublicKey, hosting.pairContextId,
    );
    // Bob waits: he already knows Alice's key from the signed, code-gated announce.
    const joining = must(bob.pendingPairingParties(accepted.relationship.id));
    const bobNumber = await deriveRelationshipSafetyNumber(
      joining.localPublicKey, must(joining.peerPublicKey), joining.pairContextId,
    );

    expect(aliceNumber).toBe(bobNumber);
    expect(aliceNumber).toMatch(/^[\d ]+$/);

    // …and it is the number the finished contact carries on both devices.
    await alice.approve(issued.invite.inviteId, listed.request.requestId);
    const completed = must(await bob.complete(accepted.sessionId));
    const afterwards = await deriveRelationshipSafetyNumber(
      completed.relationship.localIdentity.publicKey,
      must(completed.relationship.peerPublicKey),
      completed.relationship.pairContextId,
    );
    expect(afterwards).toBe(aliceNumber);
    // Nothing to derive once the pairing is no longer pending.
    expect(bob.pendingPairingParties(accepted.relationship.id)).toBeNull();
  }, 20_000);

  it('cancels a stale pending relationship and destroys its active lobby', async () => {
    const network = networkHarness(); const root = new Y.Doc();
    const relationship = await owner(root, 'Stale laptop');
    const rooms = network.makeManager();
    const runtime = new RelationshipPairingRuntime({ rootDoc: root, rooms });
    const issued = await runtime.createInvite(relationship.id);
    runtime.connectInvite(issued.invite.inviteId);

    await runtime.cancelRelationship(relationship.id);

    expect(rooms.get(issued.lobby.descriptor.id)).toBeNull();
    await expect(runtime.listRequests(issued.invite.inviteId)).rejects.toThrow(/Unknown hosted invite/);
  });

  it('prevents an in-flight approval from activating a cancelled relationship', async () => {
    let releaseSync!: () => void;
    const persistenceReady = new Promise<void>((resolve) => { releaseSync = resolve; });
    const root = new Y.Doc(); const relationship = await owner(root, 'Cancelled laptop');
    const rooms = new RelationshipPairingRoomManager({
      createDoc: () => new Y.Doc(),
      createPersistence: () => ({ whenSynced: persistenceReady, destroy: vi.fn(), clearData: vi.fn() }),
      createProvider: () => ({
        awareness: { setLocalStateField: vi.fn() }, connect: vi.fn(), disconnect: vi.fn(), destroy: vi.fn(), on: vi.fn(), off: vi.fn(),
      }),
    });
    const runtime = new RelationshipPairingRuntime({ rootDoc: root, rooms });
    const issued = await runtime.createInvite(relationship.id);
    const approving = runtime.approve(issued.invite.inviteId, 'request-that-must-not-run');
    await runtime.cancelRelationship(relationship.id);
    releaseSync();

    await expect(approving).rejects.toThrow(/cancelled/);
    expect(getRelationshipControlCapability(relationship.id, root)).toBeNull();
  });

  it('clears an indexed stale lobby after a runtime restart', async () => {
    const network = networkHarness(); const root = new Y.Doc();
    const relationship = await owner(root, 'Restart-stale laptop');
    const originalRooms = network.makeManager();
    const originalRuntime = new RelationshipPairingRuntime({ rootDoc: root, rooms: originalRooms });
    await originalRuntime.createInvite(relationship.id);
    await originalRooms.destroyAll();

    const restartedRooms = network.makeManager();
    const restartedRuntime = new RelationshipPairingRuntime({ rootDoc: root, rooms: restartedRooms });
    await restartedRuntime.cancelRelationship(relationship.id);

    expect(network.persistences.at(-1)?.clearData).toHaveBeenCalledOnce();
    expect(root.getMap('relationshipPairingLobbyIndex').has(relationship.id)).toBe(false);
  });

  it('releases both pairing lobbies once the joiner acknowledges completion', async () => {
    const network = networkHarness(); const aliceDoc = new Y.Doc(); const bobDoc = new Y.Doc();
    const aliceRelationship = await owner(aliceDoc, 'Bob'); const bobPerson = createPerson('Alice', {}, bobDoc);
    const aliceRooms = network.makeManager(); const bobRooms = network.makeManager();
    const alice = new RelationshipPairingRuntime({ rootDoc: aliceDoc, rooms: aliceRooms, lobbyReleaseGraceMs: 0 });
    const bob = new RelationshipPairingRuntime({ rootDoc: bobDoc, rooms: bobRooms, lobbyReleaseGraceMs: 0 });
    const result = await pair(alice, bob, aliceRelationship.id, bobPerson.id);

    await bob.settleLobbyReleases();
    await alice.settleLobbyReleases();

    expect(aliceRooms.get(result.issued.lobby.descriptor.id)).toBeNull();
    expect(bobRooms.get(result.accepted.lobby.descriptor.id)).toBeNull();
    expect(aliceDoc.getMap('relationshipPairingLobbyIndex').size).toBe(0);
    expect(bobDoc.getMap('relationshipPairingLobbyIndex').size).toBe(0);
    // Control rooms survive — only the one-time lobbies are gone.
    expect(aliceRooms.get(result.approved.control.descriptor.id)).not.toBeNull();
    expect(bobRooms.get(result.completed.control.descriptor.id)).not.toBeNull();
  }, 20_000);

  it('sweeps completed pairing lobbies after a restart on both sides', async () => {
    const network = networkHarness(); const aliceDoc = new Y.Doc(); const bobDoc = new Y.Doc();
    const aliceRelationship = await owner(aliceDoc, 'Bob'); const bobPerson = createPerson('Alice', {}, bobDoc);
    const aliceRooms = network.makeManager('alice'); const bobRooms = network.makeManager('bob');
    const alice = new RelationshipPairingRuntime({ rootDoc: aliceDoc, rooms: aliceRooms, lobbyReleaseGraceMs: 600_000 });
    const bob = new RelationshipPairingRuntime({ rootDoc: bobDoc, rooms: bobRooms, lobbyReleaseGraceMs: 600_000 });

    const issued = await alice.createInvite(aliceRelationship.id);
    alice.connectInvite(issued.invite.inviteId);
    const accepted = await bob.acceptInvite(issued.uri, bobPerson.id);
    bob.connectSession(accepted.sessionId);
    const listed = await alice.listRequests(issued.invite.inviteId);
    await alice.approve(issued.invite.inviteId, listed[0].request.requestId);
    aliceRooms.disconnect(issued.lobby.descriptor.id); // inviter goes offline before the ack arrives
    expect(await bob.complete(accepted.sessionId)).not.toBeNull();

    // Both apps shut down before any release grace timer fires.
    alice.disposeScheduledLobbyReleases(); bob.disposeScheduledLobbyReleases();
    await aliceRooms.destroyAll(); await bobRooms.destroyAll();
    expect(lobbyPersistenceKeys(network).length).toBe(2);

    const alice2 = new RelationshipPairingRuntime({ rootDoc: aliceDoc, rooms: network.makeManager('alice'), lobbyReleaseGraceMs: 0 });
    const bob2 = new RelationshipPairingRuntime({ rootDoc: bobDoc, rooms: network.makeManager('bob'), lobbyReleaseGraceMs: 0 });
    await alice2.sweepCompletedPairingLobbies(); // inviter reconnects and waits for the joiner's ack
    await bob2.sweepCompletedPairingLobbies(); // joiner re-writes its durable ack and lets go
    await bob2.settleLobbyReleases();
    await alice2.settleLobbyReleases();

    expect(aliceDoc.getMap('relationshipPairingLobbyIndex').size).toBe(0);
    expect(bobDoc.getMap('relationshipPairingLobbyIndex').size).toBe(0);
    expect(lobbyPersistenceKeys(network)).toEqual([]);
  }, 20_000);

  it('completes a pairing that was interrupted by restarting both apps before approval', async () => {
    const network = networkHarness();
    const aliceDoc = new Y.Doc(); const bobDoc = new Y.Doc();
    const aliceRelationship = await owner(aliceDoc, 'Bob'); const bobPerson = createPerson('Alice', {}, bobDoc);
    const aliceRooms = network.makeManager('alice'); const bobRooms = network.makeManager('bob');
    const alice = new RelationshipPairingRuntime({ rootDoc: aliceDoc, rooms: aliceRooms, lobbyReleaseGraceMs: 0 });
    const bob = new RelationshipPairingRuntime({ rootDoc: bobDoc, rooms: bobRooms, lobbyReleaseGraceMs: 0 });
    const issued = await alice.createInvite(aliceRelationship.id);
    expect(issued.uri.length).toBeLessThan(120); // compact code, not a kilobyte of JSON
    alice.connectInvite(issued.invite.inviteId);
    const accepted = await bob.acceptInvite(issued.uri, bobPerson.id);
    bob.connectSession(accepted.sessionId);

    // Both sides close their apps before anything is approved.
    await aliceRooms.destroyAll(); await bobRooms.destroyAll();

    const alice2 = new RelationshipPairingRuntime({ rootDoc: aliceDoc, rooms: network.makeManager('alice'), lobbyReleaseGraceMs: 0 });
    const bob2 = new RelationshipPairingRuntime({ rootDoc: bobDoc, rooms: network.makeManager('bob'), lobbyReleaseGraceMs: 0 });
    alice2.resumePersistedPairings();
    const resumedJoin = bob2.resumePersistedPairings();
    expect(resumedJoin.joiningSessions).toEqual([accepted.sessionId]);
    bob2.connectSession(accepted.sessionId);

    const info = alice2.resumeHostedInvite(aliceRelationship.id);
    expect(info).toMatchObject({ inviteId: issued.invite.inviteId, uri: issued.uri, expired: false });
    if (!info) throw new Error('hosted invite was not resumed');
    const listed = await alice2.listRequests(info.inviteId);
    expect(listed).toHaveLength(1);
    expect(listed[0].valid).toBe(true);
    const approved = await alice2.approve(info.inviteId, listed[0].request.requestId);
    const completed = await bob2.complete(accepted.sessionId);
    expect(completed?.relationship.peerPublicKey).toBe(aliceRelationship.localIdentity.publicKey);
    expect(approved.relationship.peerPublicKey).toBe(completed?.relationship.localIdentity.publicKey);

    await bob2.settleLobbyReleases();
    await alice2.settleLobbyReleases();
    expect(aliceDoc.getMap('relationshipPairingHostedInvites').size).toBe(0);
    expect(bobDoc.getMap('relationshipPairingJoiningSessions').size).toBe(0);
    expect(lobbyPersistenceKeys(network)).toEqual([]);
  }, 20_000);

  it('sweeps a lobby remnant whose relationship no longer exists', async () => {
    const network = networkHarness(); const root = new Y.Doc();
    const relationship = await owner(root, 'Ghost');
    const rooms = network.makeManager();
    const runtime = new RelationshipPairingRuntime({ rootDoc: root, rooms });
    await runtime.createInvite(relationship.id);
    await rooms.destroyAll();
    root.getMap('relationships').delete(relationship.id);

    const restarted = new RelationshipPairingRuntime({ rootDoc: root, rooms: network.makeManager() });
    await restarted.sweepCompletedPairingLobbies();

    expect(root.getMap('relationshipPairingLobbyIndex').size).toBe(0);
    expect(lobbyPersistenceKeys(network)).toEqual([]);
  });

  it('isolates Bob and Carol rooms and emits no global identity awareness', async () => {
    const network = networkHarness(); const aliceDoc = new Y.Doc();
    const bobRelationship = await owner(aliceDoc, 'Bob'); const carolRelationship = await owner(aliceDoc, 'Carol');
    const bobDoc = new Y.Doc(); const carolDoc = new Y.Doc();
    const bobPerson = createPerson('Alice', {}, bobDoc); const carolPerson = createPerson('Alice', {}, carolDoc);
    const aliceRooms = network.makeManager(); const alice = new RelationshipPairingRuntime({ rootDoc: aliceDoc, rooms: aliceRooms });
    const bobRooms = network.makeManager(); const bob = new RelationshipPairingRuntime({ rootDoc: bobDoc, rooms: bobRooms });
    const carolRooms = network.makeManager(); const carol = new RelationshipPairingRuntime({ rootDoc: carolDoc, rooms: carolRooms });
    const bobPair = await pair(alice, bob, bobRelationship.id, bobPerson.id);
    const carolPair = await pair(alice, carol, carolRelationship.id, carolPerson.id);

    expect(bobPair.approved.capability.roomId).not.toBe(carolPair.approved.capability.roomId);
    expect(bobPair.approved.control.doc).not.toBe(carolPair.approved.control.doc);
    aliceRooms.connect(bobPair.approved.control.descriptor.id); aliceRooms.connect(carolPair.approved.control.descriptor.id);
    bobRooms.connect(bobPair.completed.control.descriptor.id); carolRooms.connect(carolPair.completed.control.descriptor.id);
    const awareness = network.providers.map((provider) => provider.fields);
    expect(awareness.every((fields) => !fields.has('deviceId') && !fields.has('displayName') && !fields.has('identity'))).toBe(true);
    expect(awareness.filter((fields) => fields.has('relationship')).map((fields) => fields.get('relationship'))).toEqual(expect.arrayContaining([
      expect.objectContaining({ publicKey: bobRelationship.localIdentity.publicKey }),
      expect.objectContaining({ publicKey: carolRelationship.localIdentity.publicKey }),
    ]));
    // Lobby providers have no awareness at all.
    expect(awareness.some((fields) => fields.size === 0)).toBe(true);
  }, 30_000);
});
