import type { DeviceIdentity } from '../types.ts';
import { bufferToHex, hexToBuffer } from '../lib/hex.ts';


const IDENTITY_KEY = 'dapp-builder-identity';

/**
 * Device identity and key custody.
 *
 * Public identity metadata (display name, public keys, device id) lives in
 * localStorage and stays synchronously readable via `getIdentity()`. Private
 * keys are held as **non-extractable WebCrypto `CryptoKey` objects** persisted
 * in IndexedDB: they can sign/decrypt but `exportKey` on them always throws,
 * so same-origin XSS can at worst *use* the keys while a tab is open — it can
 * never exfiltrate them for offline impersonation (see
 * docs/security/THREAT_MODEL.md).
 *
 * Because keys are non-extractable there is deliberately no identity export.
 * Legacy plaintext backups (and pre-migration localStorage identities) are
 * still accepted: their key material is imported into non-extractable storage
 * and the plaintext is destroyed after a verified IndexedDB round-trip.
 */

// ───── Non-extractable key storage (IndexedDB) ─────

const KEYS_DB = 'dapp-builder-keys';
const KEYS_STORE = 'keys';
const KEYS_RECORD = 'device';

interface StoredDeviceKeys {
  /** Public key of the identity these keys belong to — guards against a stale
   * key record surviving an identity change (import/re-create). */
  publicKey: string;
  signKey: CryptoKey;
  decKey: CryptoKey | null;
}

let cachedKeys: StoredDeviceKeys | null = null;
let migrationPromise: Promise<void> | null = null;

function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openKeysDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEYS_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(KEYS_STORE)) {
        request.result.createObjectStore(KEYS_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('identity: Failed to open key database'));
  });
}

async function idbRequest<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openKeysDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(KEYS_STORE, mode);
      const request = run(tx.objectStore(KEYS_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('identity: Key database request failed'));
    });
  } finally {
    db.close();
  }
}

async function loadStoredKeys(expectedPublicKey: string): Promise<StoredDeviceKeys | null> {
  if (cachedKeys?.publicKey === expectedPublicKey) return cachedKeys;
  if (!idbAvailable()) return null;
  try {
    const value = (await idbRequest('readonly', (store) => store.get(KEYS_RECORD))) as StoredDeviceKeys | undefined;
    if (value && value.signKey && value.publicKey === expectedPublicKey) {
      cachedKeys = { publicKey: value.publicKey, signKey: value.signKey, decKey: value.decKey ?? null };
      return cachedKeys;
    }
  } catch {
    // Treat an unreadable key store as absent; callers fall back to legacy material.
  }
  return null;
}

/** Persists the keys and verifies they can be read back before reporting success. */
async function storeKeysVerified(keys: StoredDeviceKeys): Promise<boolean> {
  if (!idbAvailable()) return false;
  try {
    await idbRequest('readwrite', (store) => store.put(keys, KEYS_RECORD));
    cachedKeys = null;
    const readBack = await loadStoredKeys(keys.publicKey);
    return readBack !== null;
  } catch {
    cachedKeys = null;
    return false;
  }
}

async function importLegacySignKey(privateKeyHex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    hexToBuffer(privateKeyHex),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
}

async function importLegacyDecKey(encPrivateKeyJwk: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    JSON.parse(encPrivateKeyJwk) as JsonWebKey,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['decrypt'],
  );
}

function stripPrivateMaterial(identity: DeviceIdentity): void {
  const publicOnly: DeviceIdentity = {
    displayName: identity.displayName,
    publicKey: identity.publicKey,
    deviceId: identity.deviceId,
    ...(identity.encPublicKey ? { encPublicKey: identity.encPublicKey } : {}),
  };
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(publicOnly));
}

/**
 * Migrates a legacy localStorage identity (plaintext private keys) into
 * non-extractable IndexedDB keys, destroying the plaintext only after a
 * verified round-trip. Idempotent; safe to call at every startup.
 */
export function ensureIdentityKeysReady(): Promise<void> {
  migrationPromise ??= (async () => {
    const identity = getIdentity();
    if (!identity) return;
    const legacyPrivateKey = identity.privateKey;
    const hasLegacyMaterial = Boolean(legacyPrivateKey);
    const stored = await loadStoredKeys(identity.publicKey);
    if (stored) {
      // Keys already migrated — make sure no plaintext copy lingers.
      if (hasLegacyMaterial) stripPrivateMaterial(identity);
      return;
    }
    if (!legacyPrivateKey) return;
    try {
      const signKey = await importLegacySignKey(legacyPrivateKey);
      const decKey = identity.encPrivateKey ? await importLegacyDecKey(identity.encPrivateKey) : null;
      if (await storeKeysVerified({ publicKey: identity.publicKey, signKey, decKey })) {
        stripPrivateMaterial(identity);
      }
      // If persistence failed we keep the legacy material — never brick the identity.
    } catch {
      // Malformed legacy material: leave it in place for diagnosis.
    }
  })().finally(() => {
    migrationPromise = null;
  });
  return migrationPromise;
}

/**
 * Resolves the device signing identity for record signing. Prefers the
 * non-extractable stored key; falls back to legacy plaintext material that has
 * not been migrated yet (or injected by tests).
 */
export async function getSigningIdentity(): Promise<{ publicKey: string; privateKey: CryptoKey | string }> {
  const identity = getIdentity();
  if (!identity) throw new Error('identity: No identity — cannot sign');
  const stored = await loadStoredKeys(identity.publicKey);
  if (stored?.signKey) return { publicKey: identity.publicKey, privateKey: stored.signKey };
  if (identity.privateKey) {
    void ensureIdentityKeysReady();
    return { publicKey: identity.publicKey, privateKey: identity.privateKey };
  }
  throw new Error('identity: No signing key available on this device');
}

/**
 * Sign a short-lived Ed25519 device proof for `/ice` quota attribution
 * (`ice:<origin>:<timestamp>`). Returns null if the device has no identity yet.
 */
export async function signIceRequest(
  url: string,
  timestamp: string,
): Promise<{ publicKey: string; signature: string } | null> {
  try {
    const signing = await getSigningIdentity();
    const origin = new URL(url).origin;
    const key = typeof signing.privateKey === 'string'
      ? await importLegacySignKey(signing.privateKey)
      : signing.privateKey;
    const message = new TextEncoder().encode(`ice:${origin}:${timestamp}`);
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, key, message);
    return { publicKey: signing.publicKey, signature: bufferToHex(signature) };
  } catch {
    return null;
  }
}

// ───── Key generation ─────

function unsupportedEd25519(err: unknown): Error {
  return new Error(
    'Ed25519 is not supported in this browser. ' +
    'Please upgrade to a modern browser (Chrome 90+, Firefox 91+, Safari 15+, Edge 90+).',
    { cause: err },
  );
}

/** Load identity from localStorage */
export function getIdentity(): DeviceIdentity | null {
  const raw = localStorage.getItem(IDENTITY_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DeviceIdentity;
  } catch {
    return null;
  }
}

/** Save identity to localStorage */
export function saveIdentity(identity: DeviceIdentity): void {
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
}

/**
 * Create a new device identity. Signing/decryption keys are generated
 * non-extractable and persisted in IndexedDB; only public metadata reaches
 * localStorage. If IndexedDB persistence is unavailable (private browsing
 * edge cases), falls back to the legacy plaintext format so the identity
 * still works — migration retries at every startup.
 */
export async function createIdentity(displayName: string): Promise<DeviceIdentity> {
  let signPair: CryptoKeyPair;
  try {
    signPair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  } catch (err) {
    throw unsupportedEd25519(err);
  }
  const rsaPair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );

  const publicKey = bufferToHex(await crypto.subtle.exportKey('raw', signPair.publicKey));
  const encPublicKey = JSON.stringify(await crypto.subtle.exportKey('jwk', rsaPair.publicKey));

  // Re-import the private material as non-extractable working keys, then drop
  // the extractable originals. (Generated extractable because a CryptoKey
  // cannot be downgraded in place — the non-extractable import is the only
  // copy that gets persisted.)
  const privatePkcs8 = await crypto.subtle.exportKey('pkcs8', signPair.privateKey);
  const privateHex = bufferToHex(privatePkcs8);
  const encPrivateJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', rsaPair.privateKey));
  const signKey = await importLegacySignKey(privateHex);
  const decKey = await importLegacyDecKey(encPrivateJwk);

  const identity: DeviceIdentity = {
    displayName,
    publicKey,
    encPublicKey,
    deviceId: crypto.randomUUID(),
  };

  if (await storeKeysVerified({ publicKey, signKey, decKey })) {
    saveIdentity(identity);
  } else {
    // Persistence fallback: keep the legacy plaintext format rather than
    // creating an identity that vanishes with the tab.
    saveIdentity({ ...identity, privateKey: privateHex, encPrivateKey: encPrivateJwk });
  }
  const saved = getIdentity();
  if (!saved) throw new Error('identity was saved but could not be reloaded');
  return saved;
}

/** Update display name */
export function updateDisplayName(newName: string): DeviceIdentity | null {
  const identity = getIdentity();
  if (!identity) return null;
  identity.displayName = newName;
  saveIdentity(identity);
  return identity;
}

/**
 * Encrypt a message using the recipient's public RSA-OAEP key (JWK string).
 */
export async function encryptMessage(recipientEncPublicKey: string, message: string): Promise<string> {
  const pubKey = await crypto.subtle.importKey(
    'jwk',
    JSON.parse(recipientEncPublicKey) as JsonWebKey,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const encodedMsg = new TextEncoder().encode(message);
  const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pubKey, encodedMsg);
  return bufferToHex(encrypted);
}

/**
 * Decrypt a message using the local device's private RSA-OAEP key.
 */
export async function decryptMessage(encryptedHex: string): Promise<string> {
  const identity = getIdentity();
  const stored = identity ? await loadStoredKeys(identity.publicKey) : null;
  let privKey = stored?.decKey ?? null;
  if (!privKey) {
    if (!identity?.encPrivateKey) throw new Error('No encryption private key found');
    privKey = await importLegacyDecKey(identity.encPrivateKey);
  }
  const encryptedBuffer = hexToBuffer(encryptedHex);
  const decrypted = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privKey, encryptedBuffer);
  return new TextDecoder().decode(decrypted);
}

/**
 * Import a legacy identity backup (plaintext JSON). Key material is moved into
 * non-extractable IndexedDB storage; only public metadata stays in
 * localStorage. Returns true on success.
 */
export async function importIdentity(jsonStr: string): Promise<boolean> {
  let identity: DeviceIdentity;
  try {
    identity = JSON.parse(jsonStr) as DeviceIdentity;
  } catch {
    return false;
  }
  if (!identity.publicKey || !identity.privateKey || !identity.deviceId || !identity.displayName) {
    return false;
  }
  try {
    const signKey = await importLegacySignKey(identity.privateKey);
    const decKey = identity.encPrivateKey ? await importLegacyDecKey(identity.encPrivateKey) : null;
    if (await storeKeysVerified({ publicKey: identity.publicKey, signKey, decKey })) {
      stripPrivateMaterial(identity);
    } else {
      saveIdentity(identity); // persistence fallback, as in createIdentity
    }
    return true;
  } catch {
    return false;
  }
}
