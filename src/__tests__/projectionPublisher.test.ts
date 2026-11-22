import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { StreamEvent, UnsignedStreamEvent } from '../types.ts';
import { createRelationshipIdentity } from '../services/relationshipIdentity.ts';

// The real verification, wrapped so tests can count how often it runs.
vi.mock('../services/relationshipStream.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/relationshipStream.ts')>();
  return { ...original, verifyStreamEvent: vi.fn(original.verifyStreamEvent) };
});

import { deriveAcceptedStreams, ingestStreamEvent, RELATIONSHIP_STREAM_EVENTS_MAP } from '../services/projectionPublisher.ts';
import { canonicalSignedStreamEvent, hashStreamEvent, signStreamEvent, verifyStreamEvent } from '../services/relationshipStream.ts';

type Identity = Awaited<ReturnType<typeof createRelationshipIdentity>>;

function unsignedEvent(identity: Identity, overrides: Partial<UnsignedStreamEvent>): UnsignedStreamEvent {
  return {
    protocol: 'relationship-stream',
    schemaVersion: 1,
    eventId: 'event',
    relationshipId: 'bob',
    channelId: 'channel',
    streamId: 'stream',
    sequence: 0,
    previousEventHash: null,
    kind: 'snapshot',
    signerPublicKey: identity.publicKey,
    createdAt: '2026-08-12T00:00:00.000Z',
    payload: { value: 1 },
    ...overrides,
  };
}

/** Signs an event and stores it the way a peer's synced write would arrive: straight into the map. */
async function storeSigned(doc: Y.Doc, identity: Identity, overrides: Partial<UnsignedStreamEvent>): Promise<{ hash: string; serialized: string; event: StreamEvent }> {
  const event = await signStreamEvent(unsignedEvent(identity, overrides), identity.privateKey);
  const hash = await hashStreamEvent(event);
  const serialized = canonicalSignedStreamEvent(event);
  doc.getMap<string>(RELATIONSHIP_STREAM_EVENTS_MAP).set(hash, serialized);
  return { hash, serialized, event };
}

const verifiedEventIds = () => vi.mocked(verifyStreamEvent).mock.calls.map(([event]) => event.eventId);

describe('stream event log', () => {
  beforeEach(() => {
    vi.mocked(verifyStreamEvent).mockClear();
  });

  it('derives one deterministic branch and keeps descendants pending until predecessor arrives', async () => {
    const identity = await createRelationshipIdentity();
    const descriptor = { id: 'channel', relationshipId: 'bob', memberDeviceKeys: [identity.publicKey], status: 'active' as const };
    const doc = new Y.Doc();
    const genesis: UnsignedStreamEvent = { protocol: 'relationship-stream', schemaVersion: 1, eventId: 'genesis', relationshipId: 'bob', channelId: 'channel', streamId: 'stream', sequence: 0, previousEventHash: null, kind: 'snapshot', signerPublicKey: identity.publicKey, createdAt: '2026-08-12T00:00:00.000Z', payload: { value: 1 } };
    const signedGenesis = await signStreamEvent(genesis, identity.privateKey);
    expect((await ingestStreamEvent(doc, descriptor, signedGenesis)).status).toBe('stored');
    expect((await ingestStreamEvent(doc, descriptor, signedGenesis)).status).toBe('duplicate');
    expect((await deriveAcceptedStreams(doc, descriptor)).get('stream')?.events).toHaveLength(1);
  });

  it('walks chains, resolves forks by hash, and rejects duplicate event ids and foreign successors', async () => {
    const alice = await createRelationshipIdentity();
    const bob = await createRelationshipIdentity();
    const descriptor = { id: 'channel', relationshipId: 'bob', memberDeviceKeys: [alice.publicKey, bob.publicKey], status: 'active' as const };
    const doc = new Y.Doc();

    // A three-event chain whose last link is still missing its predecessor.
    const first = await storeSigned(doc, alice, { eventId: 'c0', streamId: 'chain' });
    const second = await storeSigned(doc, alice, { eventId: 'c1', streamId: 'chain', sequence: 1, previousEventHash: first.hash });
    await storeSigned(doc, alice, { eventId: 'c3', streamId: 'chain', sequence: 3, previousEventHash: second.hash });
    // A successor signed by the other member does not continue the chain.
    await storeSigned(doc, bob, { eventId: 'c2-bob', streamId: 'chain', sequence: 2, previousEventHash: second.hash });
    // Two competing genesis events: the smaller hash wins.
    const forkA = await storeSigned(doc, alice, { eventId: 'f-a', streamId: 'fork', payload: { value: 'a' } });
    const forkB = await storeSigned(doc, bob, { eventId: 'f-b', streamId: 'fork', payload: { value: 'b' } });
    // The same event id under two hashes: both are rejected.
    await storeSigned(doc, alice, { eventId: 'dup', streamId: 'dup-1' });
    await storeSigned(doc, alice, { eventId: 'dup', streamId: 'dup-2' });

    for (let scan = 0; scan < 2; scan++) {
      const accepted = await deriveAcceptedStreams(doc, descriptor);
      expect([...accepted.keys()].sort()).toEqual(['chain', 'fork']);
      expect(accepted.get('chain')?.hashes).toEqual([first.hash, second.hash]);
      expect(accepted.get('fork')?.hashes).toEqual([[forkA.hash, forkB.hash].sort()[0]]);
    }
  });

  it('verifies an unchanged entry once, and verifies it again when its bytes change', async () => {
    const identity = await createRelationshipIdentity();
    const descriptor = { id: 'channel', relationshipId: 'bob', memberDeviceKeys: [identity.publicKey], status: 'active' as const };
    const doc = new Y.Doc();
    const map = doc.getMap<string>(RELATIONSHIP_STREAM_EVENTS_MAP);
    const kept = await storeSigned(doc, identity, { eventId: 'kept', streamId: 'kept' });
    const tampered = await storeSigned(doc, identity, { eventId: 'tampered', streamId: 'tampered' });

    expect([...(await deriveAcceptedStreams(doc, descriptor)).keys()].sort()).toEqual(['kept', 'tampered']);
    expect(verifiedEventIds().sort()).toEqual(['kept', 'tampered']);

    // Nothing changed: no signature is checked again, the result is the same.
    vi.mocked(verifyStreamEvent).mockClear();
    const again = await deriveAcceptedStreams(doc, descriptor);
    expect([...again.keys()].sort()).toEqual(['kept', 'tampered']);
    expect(again.get('kept')?.events[0]).toEqual(kept.event);
    expect(verifyStreamEvent).not.toHaveBeenCalled();

    // A new entry is verified; the known ones are not.
    await storeSigned(doc, identity, { eventId: 'added', streamId: 'added' });
    expect([...(await deriveAcceptedStreams(doc, descriptor)).keys()].sort()).toEqual(['added', 'kept', 'tampered']);
    expect(verifiedEventIds()).toEqual(['added']);

    // Same map key, different bytes: verified again — and rejected.
    vi.mocked(verifyStreamEvent).mockClear();
    map.set(tampered.hash, canonicalSignedStreamEvent({ ...tampered.event, payload: { value: 2 } }));
    expect([...(await deriveAcceptedStreams(doc, descriptor)).keys()].sort()).toEqual(['added', 'kept']);
    expect(verifiedEventIds()).toEqual(['tampered']);

    // The rejection is remembered for those bytes …
    vi.mocked(verifyStreamEvent).mockClear();
    expect((await deriveAcceptedStreams(doc, descriptor)).has('tampered')).toBe(false);
    expect(verifyStreamEvent).not.toHaveBeenCalled();

    // … and restoring the signed bytes is a change again.
    map.set(tampered.hash, tampered.serialized);
    expect((await deriveAcceptedStreams(doc, descriptor)).has('tampered')).toBe(true);
    expect(verifiedEventIds()).toEqual(['tampered']);
  });

  it('never reuses a verdict under a different descriptor', async () => {
    const identity = await createRelationshipIdentity();
    const stranger = await createRelationshipIdentity();
    const descriptor = { id: 'channel', relationshipId: 'bob', memberDeviceKeys: [identity.publicKey], status: 'active' as const };
    const doc = new Y.Doc();
    await storeSigned(doc, identity, { eventId: 'one' });

    expect((await deriveAcceptedStreams(doc, descriptor)).size).toBe(1);
    expect((await deriveAcceptedStreams(doc, { ...descriptor, status: 'revoked' })).size).toBe(0);
    expect((await deriveAcceptedStreams(doc, { ...descriptor, memberDeviceKeys: [stranger.publicKey] })).size).toBe(0);
    expect((await deriveAcceptedStreams(doc, { ...descriptor, id: 'other-channel' })).size).toBe(0);
    expect((await deriveAcceptedStreams(doc, descriptor)).size).toBe(1);

    // Rejected while the channel was only prepared, accepted once it is active.
    const pendingDoc = new Y.Doc();
    await storeSigned(pendingDoc, identity, { eventId: 'queued' });
    expect((await deriveAcceptedStreams(pendingDoc, { ...descriptor, status: 'prepared' })).size).toBe(0);
    expect((await deriveAcceptedStreams(pendingDoc, descriptor)).size).toBe(1);
  });

  it('keeps verdicts per doc', async () => {
    const identity = await createRelationshipIdentity();
    const descriptor = { id: 'channel', relationshipId: 'bob', memberDeviceKeys: [identity.publicKey], status: 'active' as const };
    const doc = new Y.Doc();
    const stored = await storeSigned(doc, identity, { eventId: 'one' });
    await deriveAcceptedStreams(doc, descriptor);

    // Another doc holding other bytes under the same key gets its own verification.
    const other = new Y.Doc();
    other.getMap<string>(RELATIONSHIP_STREAM_EVENTS_MAP).set(stored.hash, canonicalSignedStreamEvent({ ...stored.event, payload: { value: 'forged' } }));
    expect((await deriveAcceptedStreams(other, descriptor)).size).toBe(0);
  });

  it('caps the verified entries considered per signer without letting junk or a partial view change a verdict', async () => {
    const alice = await createRelationshipIdentity();
    const bob = await createRelationshipIdentity();
    const descriptor = { id: 'channel', relationshipId: 'bob', memberDeviceKeys: [alice.publicKey, bob.publicKey], status: 'active' as const };
    const doc = new Y.Doc();
    const map = doc.getMap<string>(RELATIONSHIP_STREAM_EVENTS_MAP);

    const flood = await Promise.all(['s1', 's2', 's3'].map((streamId) => storeSigned(doc, alice, { eventId: streamId, streamId })));
    const bobs = await storeSigned(doc, bob, { eventId: 'bob-1', streamId: 'bob-1' });
    // Unverifiable entries that merely claim bob's key do not count against bob.
    for (let index = 0; index < 5; index++) {
      const junk = { ...bobs.event, eventId: `junk-${index}`, streamId: `junk-${index}` };
      map.set(await hashStreamEvent(junk), canonicalSignedStreamEvent(junk));
    }

    expect([...(await deriveAcceptedStreams(doc, descriptor)).keys()].sort()).toEqual(['bob-1', 's1', 's2', 's3']);

    const kept = flood.slice().sort((left, right) => left.hash.localeCompare(right.hash)).slice(0, 2).map(({ event }) => event.streamId);
    expect([...(await deriveAcceptedStreams(doc, descriptor, { maxEntriesPerSigner: 2 })).keys()].sort()).toEqual(['bob-1', ...kept].sort());

    // A stream that lost an entry to the cap is left out entirely rather than
    // derived from a partial view: bob's fork must not win by default.
    const forkDoc = new Y.Doc();
    const aliceFork = await storeSigned(forkDoc, alice, { eventId: 'fork-alice', streamId: 'fork' });
    const bobFork = await storeSigned(forkDoc, bob, { eventId: 'fork-bob', streamId: 'fork' });
    const fillerStream = (index: number) => `filler-${index}`;
    const fillers: Array<{ hash: string }> = [];
    for (let index = 0; fillers.filter(({ hash }) => hash < aliceFork.hash).length < 1; index++) {
      fillers.push(await storeSigned(forkDoc, alice, { eventId: fillerStream(index), streamId: fillerStream(index) }));
    }
    const full = await deriveAcceptedStreams(forkDoc, descriptor);
    expect(full.get('fork')?.hashes).toEqual([[aliceFork.hash, bobFork.hash].sort()[0]]);
    // With room for one entry, alice's fork entry falls out (a filler sorts first).
    const capped = await deriveAcceptedStreams(forkDoc, descriptor, { maxEntriesPerSigner: 1 });
    expect(capped.has('fork')).toBe(false);
  });
});
