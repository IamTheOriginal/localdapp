import { bufferToHex } from '../lib/hex.ts';
import type { RelationshipIdentity } from '../types.ts';

async function generateSigningKeypair(): Promise<{ publicKey: string; privateKey: string }> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  );

  return {
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', keyPair.publicKey)),
    privateKey: bufferToHex(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)),
  };
}

async function generateEncryptionKeypair(): Promise<{ encPublicKey: string; encPrivateKey: string }> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt'],
  );

  return {
    encPublicKey: JSON.stringify(await crypto.subtle.exportKey('jwk', keyPair.publicKey)),
    encPrivateKey: JSON.stringify(await crypto.subtle.exportKey('jwk', keyPair.privateKey)),
  };
}

/**
 * Create an unlinkable identity for one relationship.
 * These keys are deliberately distinct from the device-wide identity.
 */
export async function createRelationshipIdentity(): Promise<RelationshipIdentity> {
  const [signing, encryption] = await Promise.all([
    generateSigningKeypair(),
    generateEncryptionKeypair(),
  ]);

  return {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    ...signing,
    ...encryption,
    createdAt: new Date().toISOString(),
  };
}
