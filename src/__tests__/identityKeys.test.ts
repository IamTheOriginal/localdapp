/**
 * Device key custody: non-extractable working keys in IndexedDB, migration of
 * legacy plaintext localStorage identities, and the signing fallback chain.
 */
import { must } from './helpers/must.ts';
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { bufferToHex } from '../lib/hex.ts';
import {
  createIdentity,
  decryptMessage,
  encryptMessage,
  ensureIdentityKeysReady,
  getIdentity,
  getSigningIdentity,
  importIdentity,
  saveIdentity,
} from '../services/identity.ts';
import { signWithIdentity, verifySignature } from '../services/store/protocolCore.ts';

async function makeLegacyIdentity() {
  const signPair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  const rsaPair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );
  return {
    displayName: 'Legacy',
    deviceId: 'legacy-device',
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', signPair.publicKey)),
    privateKey: bufferToHex(await crypto.subtle.exportKey('pkcs8', signPair.privateKey)),
    encPublicKey: JSON.stringify(await crypto.subtle.exportKey('jwk', rsaPair.publicKey)),
    encPrivateKey: JSON.stringify(await crypto.subtle.exportKey('jwk', rsaPair.privateKey)),
  };
}

describe('device key custody', () => {
  beforeEach(() => {
    localStorage.clear();
    // Fresh IndexedDB per test — also resets the module's DB contents.
    indexedDB = new IDBFactory();
  });

  it('creates identities with no private material in localStorage', async () => {
    const identity = await createIdentity('Fresh');
    expect(identity.privateKey).toBeUndefined();
    expect(identity.encPrivateKey).toBeUndefined();
    const raw = must(localStorage.getItem('dapp-builder-identity'));
    expect(raw).not.toContain('privateKey');
    expect(raw).toContain(identity.publicKey);
  });

  it('signs with a non-extractable stored key that verifies and cannot be exported', async () => {
    const identity = await createIdentity('Signer');
    const signer = await getSigningIdentity();
    expect(typeof signer.privateKey).not.toBe('string');
    const key = signer.privateKey as CryptoKey;
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', key)).rejects.toThrow();

    const record = { id: 'r1', title: 'hello' };
    const sig = await signWithIdentity(signer, record);
    expect(sig._signedBy).toBe(identity.publicKey);
    expect(await verifySignature({ ...record, ...sig }, identity.publicKey)).toBe(true);
  });

  it('round-trips RSA messages through the non-extractable decryption key', async () => {
    const identity = await createIdentity('Crypter');
    const ciphertext = await encryptMessage(must(identity.encPublicKey), 'secret payload');
    expect(await decryptMessage(ciphertext)).toBe('secret payload');
  });

  it('migrates a legacy plaintext identity and strips localStorage', async () => {
    const legacy = await makeLegacyIdentity();
    saveIdentity(legacy);
    await ensureIdentityKeysReady();

    const migrated = must(getIdentity());
    expect(migrated.privateKey).toBeUndefined();
    expect(migrated.encPrivateKey).toBeUndefined();
    expect(migrated.publicKey).toBe(legacy.publicKey);
    expect(migrated.encPublicKey).toBe(legacy.encPublicKey);

    // Signatures still verify against the pre-migration public key.
    const signer = await getSigningIdentity();
    const sig = await signWithIdentity(signer, { id: 'x' });
    expect(await verifySignature({ id: 'x', ...sig }, legacy.publicKey)).toBe(true);

    // RSA decryption still works post-migration.
    const ciphertext = await encryptMessage(legacy.encPublicKey, 'after migration');
    expect(await decryptMessage(ciphertext)).toBe('after migration');
  });

  it('falls back to legacy plaintext material when keys are not yet migrated', async () => {
    const legacy = await makeLegacyIdentity();
    saveIdentity(legacy);
    const signer = await getSigningIdentity();
    const sig = await signWithIdentity(signer, { id: 'y' });
    expect(await verifySignature({ id: 'y', ...sig }, legacy.publicKey)).toBe(true);
  });

  it('imports a legacy backup into non-extractable storage', async () => {
    const legacy = await makeLegacyIdentity();
    expect(await importIdentity(JSON.stringify(legacy))).toBe(true);
    const restored = must(getIdentity());
    expect(restored.publicKey).toBe(legacy.publicKey);
    expect(restored.privateKey).toBeUndefined();
    const signer = await getSigningIdentity();
    expect((signer.privateKey as CryptoKey).extractable).toBe(false);
  });

  it('rejects malformed backups', async () => {
    expect(await importIdentity('not json')).toBe(false);
    expect(await importIdentity(JSON.stringify({ displayName: 'x' }))).toBe(false);
    expect(await importIdentity(JSON.stringify({ displayName: 'x', publicKey: 'a', privateKey: 'zz-not-hex', deviceId: 'd' }))).toBe(false);
  });
});
