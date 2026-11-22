import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DeviceIdentity } from '../types.ts';
import { bufferToHex } from '../lib/hex.ts';
import { saveIdentity } from '../services/identity.ts';

/**
 * Headless device identity: the same Ed25519 + RSA-OAEP keypair as a browser
 * device, but with key custody in a file instead of non-extractable IndexedDB
 * keys (a server process holds its disk keys either way — protect the data
 * directory like any server credential).
 *
 * The identity is stored in `identity.json` in the legacy `DeviceIdentity`
 * format (pkcs8-hex signing key + JWK decryption key) that the whole store
 * stack still accepts, and is re-seeded into (volatile) localStorage at every
 * boot so `getIdentity()`/`getSigningIdentity()` work unchanged. The in-memory
 * key migration `getSigningIdentity` may kick off is harmless here: it only
 * strips the volatile localStorage copy, never `identity.json`.
 */

const IDENTITY_FILE = 'identity.json';

function isCompleteIdentity(value: unknown): value is DeviceIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Record<string, unknown>;
  return typeof identity.displayName === 'string'
    && typeof identity.publicKey === 'string'
    && typeof identity.privateKey === 'string'
    && typeof identity.deviceId === 'string'
    && typeof identity.encPublicKey === 'string'
    && typeof identity.encPrivateKey === 'string';
}

async function generateIdentity(displayName: string): Promise<DeviceIdentity> {
  const signPair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  const rsaPair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );
  return {
    displayName,
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', signPair.publicKey)),
    privateKey: bufferToHex(await crypto.subtle.exportKey('pkcs8', signPair.privateKey)),
    encPublicKey: JSON.stringify(await crypto.subtle.exportKey('jwk', rsaPair.publicKey)),
    encPrivateKey: JSON.stringify(await crypto.subtle.exportKey('jwk', rsaPair.privateKey)),
    deviceId: crypto.randomUUID(),
  };
}

/**
 * Load the identity from the data directory, creating it on first boot, and
 * seed it into localStorage for the store stack. A malformed or partial
 * identity file is an error, never silently regenerated — regenerating would
 * orphan the device's memberships.
 */
export async function loadOrCreateHeadlessIdentity(dataDir: string, displayName: string): Promise<DeviceIdentity> {
  const filePath = path.join(dataDir, IDENTITY_FILE);
  let identity: DeviceIdentity;
  const raw = await fs.readFile(filePath, 'utf8').catch(() => null); // null: first boot
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`headless identity: ${filePath} is not valid JSON`, { cause: error });
    }
    if (!isCompleteIdentity(parsed)) {
      throw new Error(`headless identity: ${filePath} is missing key material — refusing to regenerate over an existing identity`);
    }
    identity = parsed;
  } else {
    await fs.mkdir(dataDir, { recursive: true });
    identity = await generateIdentity(displayName);
    await fs.writeFile(filePath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  }
  saveIdentity(identity);
  return identity;
}
