import { describe, expect, it } from 'vitest';
import type { CanonicalJson, UnsignedStreamEvent } from '../types.ts';
import { createRelationshipIdentity } from '../services/relationshipIdentity.ts';
import { createChannelDescriptor } from '../services/store/channelRegistry.ts';
import {
  canonicalizeJson,
  hashStreamEvent,
  signStreamEvent,
  verifyStreamEvent,
} from '../services/relationshipStream.ts';

function event(publicKey: string, payload: CanonicalJson = { repetitions: 20 }): UnsignedStreamEvent {
  return {
    protocol: 'relationship-stream',
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    relationshipId: 'bob',
    channelId: 'channel-bob-habits',
    streamId: 'push-ups',
    sequence: 0,
    previousEventHash: null,
    kind: 'snapshot',
    signerPublicKey: publicKey,
    createdAt: '2026-08-12T10:00:00.000Z',
    payload,
  };
}

describe('relationship stream signatures', () => {
  it('canonicalizes nested objects independently of insertion order', () => {
    expect(canonicalizeJson({ z: 1, a: { y: true, x: 'value' } })).toBe(
      canonicalizeJson({ a: { x: 'value', y: true }, z: 1 }),
    );
  });

  it('rejects values that are not strict canonical JSON', () => {
    expect(() => canonicalizeJson({ value: Number.NaN })).toThrow();
    expect(() => canonicalizeJson({ value: new Date() } as unknown as CanonicalJson)).toThrow();
    const sparse = Array<CanonicalJson>(1);
    expect(() => canonicalizeJson(sparse)).toThrow(/Sparse/);
  });

  it('accepts an admitted signer and rejects tampering or a different channel', async () => {
    const identity = await createRelationshipIdentity();
    const unsigned = event(identity.publicKey);
    const signed = await signStreamEvent(unsigned, identity.privateKey);
    const descriptor = {
      ...createChannelDescriptor({ relationshipId: 'bob', dappId: 'habits' }),
      id: unsigned.channelId,
      memberDeviceKeys: [identity.publicKey],
      status: 'active' as const,
    };

    expect(await verifyStreamEvent(signed, descriptor)).toBe(true);
    expect(await verifyStreamEvent({ ...signed, payload: { repetitions: 21 } }, descriptor)).toBe(false);
    expect(await verifyStreamEvent(signed, { ...descriptor, id: 'carol-channel' })).toBe(false);
    expect(await verifyStreamEvent(signed, { ...descriptor, memberDeviceKeys: [] })).toBe(false);
    expect(await verifyStreamEvent(signed, { ...descriptor, status: 'revoked' })).toBe(false);
    expect(await hashStreamEvent(signed)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('ignores device-local relationship IDs but rejects malformed signatures', async () => {
    const identity = await createRelationshipIdentity();
    const unsigned = event(identity.publicKey);
    const signed = await signStreamEvent(unsigned, identity.privateKey);
    const descriptor = {
      ...createChannelDescriptor({ relationshipId: 'carol-local-id', dappId: 'habits' }),
      id: unsigned.channelId,
      memberDeviceKeys: [identity.publicKey],
      status: 'active' as const,
    };

    expect(await verifyStreamEvent(signed, descriptor)).toBe(true);
    expect(await verifyStreamEvent({ ...signed, signature: 'zz' }, descriptor)).toBe(false);
  });
});
