import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createPerson } from '../services/store/people.ts';
import {
  compareAndSetRelationshipControlCapability, createRelationship, getRelationshipControlCapability, setRelationshipPeer,
} from '../services/store/relationships.ts';
import type { RelationshipControlCapability, RelationshipIdentity } from '../types.ts';

const identity: RelationshipIdentity = {
  id: 'local', schemaVersion: 1, publicKey: 'a'.repeat(64), privateKey: 'private',
  encPublicKey: '{"kty":"RSA"}', encPrivateKey: '{"kty":"RSA"}', createdAt: '2026-08-12T00:00:00.000Z',
};
function control(id: string): RelationshipControlCapability {
  return { protocol: 'relationship-control-capability', schemaVersion: 1, capabilityId: id, pairContextId: 'pair-context', roomId: `room-${id}`, roomPassword: `password-${id}`, createdAt: '2026-08-12T00:00:00.000Z' };
}

describe('immutable relationship install stores', () => {
  it('pins peer signing and encryption keys immutably', () => {
    const doc = new Y.Doc();
    createPerson('Bob', { id: 'bob' }, doc);
    createRelationship('bob', identity, { id: 'alice-bob' }, doc);
    const pinned = { publicKey: 'b'.repeat(64), encPublicKey: 'rsa-bob', verified: true };
    expect(setRelationshipPeer('alice-bob', pinned, doc).status).toBe('active');
    expect(setRelationshipPeer('alice-bob', pinned, doc).peerPublicKey).toBe(pinned.publicKey);
    expect(() => setRelationshipPeer('alice-bob', { ...pinned, publicKey: 'c'.repeat(64) }, doc)).toThrow(/pinned/);
    expect(() => setRelationshipPeer('alice-bob', { ...pinned, encPublicKey: 'replacement' }, doc)).toThrow(/pinned/);
  });

  it('installs and rotates control capabilities only with compare-and-set', () => {
    const doc = new Y.Doc();
    compareAndSetRelationshipControlCapability('alice-bob', null, control('one'), doc);
    expect(getRelationshipControlCapability('alice-bob', doc)).toEqual(control('one'));
    expect(() => compareAndSetRelationshipControlCapability('alice-bob', null, control('two'), doc)).toThrow(/compare-and-set/);
    expect(() => compareAndSetRelationshipControlCapability('alice-bob', 'one', control('one'), doc)).toThrow(/replay/);
    compareAndSetRelationshipControlCapability('alice-bob', 'one', control('two'), doc);
    expect(getRelationshipControlCapability('alice-bob', doc)?.capabilityId).toBe('two');
  });

});
