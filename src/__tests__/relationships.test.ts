import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createPerson, getPerson, listPeople, updatePerson } from '../services/store/people.ts';
import { createRelationship, listRelationships, setRelationshipPeer, setRelationshipVerified, updateRelationshipStatus } from '../services/store/relationships.ts';
import type { RelationshipIdentity } from '../types.ts';

const identity: RelationshipIdentity = {
  id: 'relationship-identity-1',
  schemaVersion: 1,
  publicKey: 'relationship-public-key',
  privateKey: 'relationship-private-key',
  encPublicKey: '{"kty":"RSA","n":"public"}',
  encPrivateKey: '{"kty":"RSA","n":"private"}',
  createdAt: '2026-08-12T00:00:00.000Z',
};

describe('local people and relationship stores', () => {
  it('round-trips people through a supplied local Y.Doc', () => {
    const doc = new Y.Doc();
    const bob = createPerson(' Bob ', { id: 'bob', notes: 'Training partner' }, doc);

    expect(bob.displayName).toBe('Bob');
    expect(getPerson('bob', doc)?.notes).toBe('Training partner');
    expect(listPeople(doc)).toHaveLength(1);

    const updated = updatePerson('bob', { displayName: 'Robert', notes: '' }, doc);
    expect(updated.displayName).toBe('Robert');
    expect(updated.notes).toBeUndefined();
  });

  it('stores relationship-private material only in the supplied root document', () => {
    const localDoc = new Y.Doc();
    const unrelatedDoc = new Y.Doc();
    const bob = createPerson('Bob', { id: 'bob' }, localDoc);
    const relationship = createRelationship(bob.id, identity, { id: 'alice-bob' }, localDoc);

    expect(relationship.localIdentity.publicKey).toBe('relationship-public-key');
    expect(localDoc.getMap('relationships').size).toBe(1);
    expect(unrelatedDoc.getMap('relationships').size).toBe(0);
    expect(listRelationships(localDoc)[0]?.status).toBe('pending');
    expect(updateRelationshipStatus('alice-bob', 'blocked', localDoc).status).toBe('blocked');
  });

  it('marks a contact verified only when the person says so, only once paired, and lets them take it back', () => {
    const localDoc = new Y.Doc();
    const bob = createPerson('Bob', { id: 'bob' }, localDoc);
    createRelationship(bob.id, identity, { id: 'alice-bob' }, localDoc);

    // Pairing alone never verifies anybody.
    expect(() => setRelationshipVerified('alice-bob', true, localDoc)).toThrow(/paired contact/);
    setRelationshipPeer('alice-bob', { publicKey: 'bob-key', encPublicKey: 'bob-enc' }, localDoc);
    updateRelationshipStatus('alice-bob', 'active', localDoc);
    expect(listRelationships(localDoc)[0]?.verifiedAt).toBeUndefined();

    expect(setRelationshipVerified('alice-bob', true, localDoc).verifiedAt).toMatch(/^[0-9]{4}-/);
    expect(setRelationshipVerified('alice-bob', false, localDoc).verifiedAt).toBeUndefined();
  });
});
