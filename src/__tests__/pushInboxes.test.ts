import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Relationship, RelationshipIdentity } from '../types.ts';
import { createRelationshipIdentity } from '../services/relationshipIdentity.ts';
import { pushInboxEntries, readContactPushInbox, writePushInboxEntry } from '../services/store/pushInboxes.ts';
import { sendShareTickle } from '../services/pushNotifications.ts';

const INBOX_A = 'a'.repeat(32);
const INBOX_B = 'b'.repeat(32);

let aliceIdentity: RelationshipIdentity;
let bobIdentity: RelationshipIdentity;
let alice: Relationship;
let bob: Relationship;

/** One side of a pinned, active pair. */
function relationshipView(local: RelationshipIdentity, peer: RelationshipIdentity): Relationship {
  return {
    id: 'rel-1',
    schemaVersion: 1,
    personId: 'person-1',
    status: 'active',
    localIdentity: local,
    peerPublicKey: peer.publicKey,
    peerEncPublicKey: peer.encPublicKey,
    createdAt: 'now',
    updatedAt: 'now',
  };
}

beforeAll(async () => {
  [aliceIdentity, bobIdentity] = await Promise.all([createRelationshipIdentity(), createRelationshipIdentity()]);
  alice = relationshipView(aliceIdentity, bobIdentity);
  bob = relationshipView(bobIdentity, aliceIdentity);
});

describe('push inbox distribution', () => {
  it('round-trips an encrypted, signed address through the shared control doc', async () => {
    const controlDoc = new Y.Doc();
    await writePushInboxEntry({ relationship: alice, controlDoc, relayUrl: 'https://relay.example.org/push', inboxes: [INBOX_A, INBOX_B] });
    await expect(readContactPushInbox(bob, controlDoc)).resolves.toEqual({
      relayUrl: 'https://relay.example.org/push',
      inboxes: [INBOX_A, INBOX_B],
    });
    // The writer does not see its own entry as a contact address.
    await expect(readContactPushInbox(alice, controlDoc)).resolves.toBeNull();
  });

  it('an empty inbox list announces push disabled and replaces the old entry', async () => {
    const controlDoc = new Y.Doc();
    await writePushInboxEntry({ relationship: alice, controlDoc, relayUrl: 'https://relay.example.org', inboxes: [INBOX_A] });
    await writePushInboxEntry({ relationship: alice, controlDoc, relayUrl: 'https://relay.example.org', inboxes: [] });
    await expect(readContactPushInbox(bob, controlDoc)).resolves.toEqual({ relayUrl: 'https://relay.example.org', inboxes: [] });
  });

  it('rejects invalid relay URLs and inbox ids at write time', async () => {
    const controlDoc = new Y.Doc();
    await expect(writePushInboxEntry({ relationship: alice, controlDoc, relayUrl: 'http://insecure', inboxes: [] })).rejects.toThrow();
    await expect(writePushInboxEntry({ relationship: alice, controlDoc, relayUrl: 'https://relay.example.org/', inboxes: [] })).rejects.toThrow();
    await expect(writePushInboxEntry({ relationship: alice, controlDoc, relayUrl: 'https://relay.example.org', inboxes: ['not-hex'] })).rejects.toThrow();
  });

  it('verify-on-read rejects tampered, forged, and misattributed entries', async () => {
    const controlDoc = new Y.Doc();
    const entry = await writePushInboxEntry({ relationship: alice, controlDoc, relayUrl: 'https://relay.example.org', inboxes: [INBOX_A] });

    // Tampered routing after signing → signature check fails.
    pushInboxEntries(controlDoc).set(alice.localIdentity.publicKey, { ...entry, updatedAt: new Date(0).toISOString() });
    await expect(readContactPushInbox(bob, controlDoc)).resolves.toBeNull();

    // Entry stored under Alice's key but claiming another sender → inert.
    pushInboxEntries(controlDoc).set(alice.localIdentity.publicKey, { ...entry, from: 'mallory' });
    await expect(readContactPushInbox(bob, controlDoc)).resolves.toBeNull();

    // Entry signed by the wrong key entirely (Bob forging Alice's slot) → inert.
    const forged = await writePushInboxEntry({ relationship: bob, controlDoc: new Y.Doc(), relayUrl: 'https://evil.example.org', inboxes: [INBOX_B] });
    pushInboxEntries(controlDoc).set(alice.localIdentity.publicKey, { ...forged, from: alice.localIdentity.publicKey, to: bob.localIdentity.publicKey });
    await expect(readContactPushInbox(bob, controlDoc)).resolves.toBeNull();

    // Intact entry still reads fine afterwards.
    pushInboxEntries(controlDoc).set(alice.localIdentity.publicKey, entry);
    await expect(readContactPushInbox(bob, controlDoc)).resolves.toEqual({ relayUrl: 'https://relay.example.org', inboxes: [INBOX_A] });
  });

  it('requires an active pinned relationship', async () => {
    const controlDoc = new Y.Doc();
    const pending: Relationship = { ...alice, status: 'pending' };
    await expect(writePushInboxEntry({ relationship: pending, controlDoc, relayUrl: 'https://r.example.org', inboxes: [] })).rejects.toThrow();
    await expect(readContactPushInbox(pending, controlDoc)).rejects.toThrow();
  });
});

describe('share tickle', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends one signed, relay-verifiable tickle per registered contact inbox', async () => {
    const controlDoc = new Y.Doc();
    await writePushInboxEntry({ relationship: alice, controlDoc, relayUrl: 'https://relay.example.org/push', inboxes: [INBOX_A, INBOX_B] });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendShareTickle(bob, controlDoc);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as Array<[string, { body: string }]>;
    expect(calls.map(([url]) => url).sort()).toEqual([
      `https://relay.example.org/push/notify/${INBOX_A}`,
      `https://relay.example.org/push/notify/${INBOX_B}`,
    ]);

    // The browser-signed tickle must verify with the relay's Node-side check.
    const relayModulePath = '../../server/push-relay.mjs';
    const { canonicalizeJson, verifyTickleSignature } = await import(/* @vite-ignore */ relayModulePath) as {
      canonicalizeJson: (value: unknown) => string;
      verifyTickleSignature: (payload: unknown, signature: string, publicKey: string) => boolean;
    };
    for (const [url, init] of calls) {
      const body = JSON.parse(init.body) as { payload: Record<string, unknown>; senderPublicKey: string; signature: string };
      expect(body.senderPublicKey).toBe(bob.localIdentity.publicKey);
      expect(body.payload.protocol).toBe('push-tickle');
      expect(body.payload.inboxId).toBe(url.split('/').at(-1));
      expect(Object.keys(body.payload)).toHaveLength(5);
      expect(canonicalizeJson(body.payload)).toContain('"push-tickle"');
      expect(verifyTickleSignature(body.payload, body.signature, body.senderPublicKey)).toBe(true);
    }
  });

  it('does nothing without a published address and swallows relay failures', async () => {
    const controlDoc = new Y.Doc();
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    await sendShareTickle(bob, controlDoc);
    expect(fetchMock).not.toHaveBeenCalled();

    await writePushInboxEntry({ relationship: alice, controlDoc, relayUrl: 'https://relay.example.org', inboxes: [INBOX_A] });
    await expect(sendShareTickle(bob, controlDoc)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
