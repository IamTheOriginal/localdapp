import { describe, expect, it } from 'vitest';
import { createRelationshipIdentity } from '../services/relationshipIdentity.ts';

describe('relationship identity', () => {
  it('creates fresh unlinkable signing and encryption identities', async () => {
    const first = await createRelationshipIdentity();
    const second = await createRelationshipIdentity();

    expect(first.schemaVersion).toBe(1);
    expect(first.publicKey).toMatch(/^[a-f0-9]{64}$/);
    expect(first.privateKey).not.toBe(second.privateKey);
    expect(first.publicKey).not.toBe(second.publicKey);
    expect(first.encPublicKey).not.toBe(second.encPublicKey);
    expect(first.encPrivateKey).not.toBe(second.encPrivateKey);
  });
});
