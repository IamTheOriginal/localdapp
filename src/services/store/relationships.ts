import * as Y from 'yjs';
import { getRootDoc } from './docs.ts';
import { getPerson } from './people.ts';
import type { Relationship, RelationshipControlCapability, RelationshipIdentity, RelationshipStatus } from '../../types.ts';

function relationshipsMap(doc: Y.Doc = getRootDoc()): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>('relationships');
}

function toRelationship(value: Y.Map<unknown>): Relationship {
  return {
    id: String(value.get('id')),
    schemaVersion: 1,
    personId: String(value.get('personId')),
    status: value.get('status') as RelationshipStatus,
    localIdentity: value.get('localIdentity') as RelationshipIdentity,
    peerPublicKey: value.get('peerPublicKey') ? String(value.get('peerPublicKey')) : undefined,
    peerEncPublicKey: value.get('peerEncPublicKey') ? String(value.get('peerEncPublicKey')) : undefined,
    pairContextId: value.get('pairContextId') ? String(value.get('pairContextId')) : undefined,
    controlCapabilityId: value.get('controlCapabilityId') ? String(value.get('controlCapabilityId')) : undefined,
    pairingTranscriptHash: value.get('pairingTranscriptHash') ? String(value.get('pairingTranscriptHash')) : undefined,
    verifiedAt: value.get('verifiedAt') ? String(value.get('verifiedAt')) : undefined,
    createdAt: String(value.get('createdAt')),
    updatedAt: String(value.get('updatedAt')),
  };
}

export function listRelationships(doc: Y.Doc = getRootDoc()): Relationship[] {
  return Array.from(relationshipsMap(doc).values())
    .map(toRelationship)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function getRelationship(relationshipId: string, doc: Y.Doc = getRootDoc()): Relationship | null {
  const value = relationshipsMap(doc).get(relationshipId);
  return value ? toRelationship(value) : null;
}

export function createRelationship(
  personId: string,
  localIdentity: RelationshipIdentity,
  options: { id?: string; status?: RelationshipStatus } = {},
  doc: Y.Doc = getRootDoc(),
): Relationship {
  if (!getPerson(personId, doc)) throw new Error(`relationships: Unknown person ${personId}`);

  const id = options.id ?? crypto.randomUUID();
  const map = relationshipsMap(doc);
  if (map.has(id)) throw new Error(`relationships: Relationship ${id} already exists`);

  const now = new Date().toISOString();
  const value = new Y.Map<unknown>();
  value.set('id', id);
  value.set('schemaVersion', 1);
  value.set('personId', personId);
  value.set('status', options.status ?? 'pending');
  value.set('localIdentity', localIdentity);
  value.set('createdAt', now);
  value.set('updatedAt', now);
  map.set(id, value);
  return toRelationship(value);
}

export function updateRelationshipStatus(
  relationshipId: string,
  status: RelationshipStatus,
  doc: Y.Doc = getRootDoc(),
): Relationship {
  const value = relationshipsMap(doc).get(relationshipId);
  if (!value) throw new Error(`relationships: Unknown relationship ${relationshipId}`);
  value.set('status', status);
  value.set('updatedAt', new Date().toISOString());
  return toRelationship(value);
}

export function setRelationshipPeer(
  relationshipId: string,
  peer: { publicKey: string; encPublicKey: string; verified?: boolean },
  doc: Y.Doc = getRootDoc(),
): Relationship {
  const value = relationshipsMap(doc).get(relationshipId);
  if (!value) throw new Error(`relationships: Unknown relationship ${relationshipId}`);
  const pinnedPublicKey = value.get('peerPublicKey');
  const pinnedEncPublicKey = value.get('peerEncPublicKey');
  if ((pinnedPublicKey && pinnedPublicKey !== peer.publicKey) || (pinnedEncPublicKey && pinnedEncPublicKey !== peer.encPublicKey)) {
    throw new Error('relationships: Peer keys are pinned and cannot be replaced');
  }
  value.set('peerPublicKey', peer.publicKey);
  value.set('peerEncPublicKey', peer.encPublicKey);
  value.set('status', peer.verified ? 'active' : 'pending');
  if (peer.verified) value.set('verifiedAt', new Date().toISOString());
  value.set('updatedAt', new Date().toISOString());
  return toRelationship(value);
}

/**
 * The person compared the safety number with their contact over another channel (call, in
 * person) and it matched — or takes that back. Pairing alone proves nothing about WHO holds
 * the other key: the invite code is the only gate, and whoever gets hold of it can pair.
 * Until this is set the contact counts as unverified everywhere (`$contacts`, share consent).
 */
export function setRelationshipVerified(relationshipId: string, verified: boolean, doc: Y.Doc = getRootDoc()): Relationship {
  const value = relationshipsMap(doc).get(relationshipId);
  if (!value) throw new Error(`relationships: Unknown relationship ${relationshipId}`);
  if (verified && (value.get('status') !== 'active' || !value.get('peerPublicKey'))) {
    throw new Error('relationships: Only a paired contact can be verified');
  }
  if (verified) value.set('verifiedAt', new Date().toISOString());
  else value.delete('verifiedAt');
  value.set('updatedAt', new Date().toISOString());
  return toRelationship(value);
}

export function completeRelationshipPairing(
  relationshipId: string,
  pairing: { publicKey: string; encPublicKey: string; pairContextId: string; controlCapabilityId: string; transcriptHash: string },
  doc: Y.Doc = getRootDoc(),
): Relationship {
  const value = relationshipsMap(doc).get(relationshipId);
  if (!value) throw new Error(`relationships: Unknown relationship ${relationshipId}`);
  const fields = ['peerPublicKey', 'peerEncPublicKey', 'pairContextId', 'controlCapabilityId', 'pairingTranscriptHash'] as const;
  const incoming = [pairing.publicKey, pairing.encPublicKey, pairing.pairContextId, pairing.controlCapabilityId, pairing.transcriptHash];
  fields.forEach((field, index) => {
    const current = value.get(field);
    if (current && current !== incoming[index]) throw new Error('relationships: Pairing state is pinned and cannot be replaced');
  });
  value.set('peerPublicKey', pairing.publicKey);
  value.set('peerEncPublicKey', pairing.encPublicKey);
  value.set('pairContextId', pairing.pairContextId);
  value.set('controlCapabilityId', pairing.controlCapabilityId);
  value.set('pairingTranscriptHash', pairing.transcriptHash);
  value.set('status', 'active');
  value.set('updatedAt', new Date().toISOString());
  return toRelationship(value);
}

export function deleteRelationship(relationshipId: string, doc: Y.Doc = getRootDoc()): boolean {
  const map = relationshipsMap(doc);
  if (!map.has(relationshipId)) return false;
  map.delete(relationshipId);
  return true;
}

// ───── Control capability (the pairing control room's credentials, one per relationship) ─────

function controlMap(doc: Y.Doc): Y.Map<RelationshipControlCapability> {
  return doc.getMap<RelationshipControlCapability>('relationshipControlCapabilities');
}

export function getRelationshipControlCapability(relationshipId: string, doc: Y.Doc = getRootDoc()): RelationshipControlCapability | null {
  return controlMap(doc).get(relationshipId) ?? null;
}

export function removeRelationshipControlCapability(relationshipId: string, doc: Y.Doc = getRootDoc()): boolean {
  const map = controlMap(doc);
  if (!map.has(relationshipId)) return false;
  map.delete(relationshipId);
  return true;
}

/** Compare-and-set: expected is null for first install, or the current ID for an intentional rotation. */
export function compareAndSetRelationshipControlCapability(
  relationshipId: string,
  expectedCapabilityId: string | null,
  capability: RelationshipControlCapability,
  doc: Y.Doc = getRootDoc(),
): RelationshipControlCapability {
  if (!relationshipId.trim() || capability.protocol !== 'relationship-control-capability' || capability.schemaVersion !== 1
    || !capability.capabilityId || !capability.roomId || !capability.roomPassword) throw new Error('relationship capabilities: Malformed control capability');
  const map = controlMap(doc);
  const current = map.get(relationshipId);
  if ((current?.capabilityId ?? null) !== expectedCapabilityId) throw new Error('relationship capabilities: Control capability compare-and-set failed');
  if (current?.capabilityId === capability.capabilityId) throw new Error('relationship capabilities: Control capability replay rejected');
  map.set(relationshipId, Object.freeze({ ...capability }));
  return capability;
}
