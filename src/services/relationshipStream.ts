import type { CanonicalJson, ChannelDescriptor, StreamEvent, UnsignedStreamEvent } from '../types.ts';
import { bufferToHex } from '../lib/hex.ts';

const encoder = new TextEncoder();

function strictHex(value: string, bytes?: number): ArrayBuffer {
  if (!/^[a-f0-9]+$/.test(value) || value.length % 2 !== 0 || (bytes !== undefined && value.length !== bytes * 2)) {
    throw new Error('relationship stream: Invalid hexadecimal value');
  }
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result.buffer;
}

function canonicalize(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error('relationship stream: Invalid JSON number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new Error('relationship stream: Value is not canonical JSON');
  if (seen.has(value)) throw new Error('relationship stream: Cyclic JSON is not supported');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error('relationship stream: Sparse arrays are not supported');
      }
      return `[${value.map((item) => canonicalize(item, seen)).join(',')}]`;
    }
    const prototype: object | null = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('relationship stream: Only plain JSON objects are supported');
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalizeJson(value: CanonicalJson): string {
  return canonicalize(value, new Set());
}

function validateUnsignedEvent(event: UnsignedStreamEvent): void {
  if (event.protocol !== 'relationship-stream' || event.schemaVersion !== 1) {
    throw new Error('relationship stream: Unsupported protocol version');
  }
  if (!event.eventId || !event.relationshipId || !event.channelId || !event.streamId || !event.createdAt) {
    throw new Error('relationship stream: Required event field is missing');
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
    throw new Error('relationship stream: Invalid sequence');
  }
  strictHex(event.signerPublicKey, 32);
  if (event.previousEventHash !== null) strictHex(event.previousEventHash, 32);
  canonicalizeJson(event.payload);
}

function unsignedSigningObject(event: UnsignedStreamEvent): CanonicalJson {
  return {
    protocol: event.protocol,
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    relationshipId: event.relationshipId,
    channelId: event.channelId,
    streamId: event.streamId,
    sequence: event.sequence,
    previousEventHash: event.previousEventHash,
    kind: event.kind,
    signerPublicKey: event.signerPublicKey,
    createdAt: event.createdAt,
    payload: event.payload,
  };
}

function streamEventSigningBytes(event: UnsignedStreamEvent): Uint8Array<ArrayBuffer> {
  validateUnsignedEvent(event);
  return encoder.encode(canonicalizeJson(unsignedSigningObject(event)));
}

export async function signStreamEvent(
  event: UnsignedStreamEvent,
  privateKeyPkcs8Hex: string,
): Promise<StreamEvent> {
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    strictHex(privateKeyPkcs8Hex),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    streamEventSigningBytes(event),
  );
  return { ...event, signature: bufferToHex(signature) };
}

export async function verifyStreamEvent(
  event: StreamEvent,
  descriptor: Pick<ChannelDescriptor, 'id' | 'relationshipId' | 'memberDeviceKeys' | 'status'>,
): Promise<boolean> {
  try {
    // relationshipId is local metadata and intentionally differs between paired devices.
    // The isolated channel ID plus its two pinned device keys are the shared wire identity.
    if (descriptor.status !== 'active'
      || event.channelId !== descriptor.id
      || !descriptor.memberDeviceKeys.includes(event.signerPublicKey)) return false;
    const publicKey = await crypto.subtle.importKey(
      'raw',
      strictHex(event.signerPublicKey, 32),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      strictHex(event.signature, 64),
      streamEventSigningBytes(event),
    );
  } catch {
    return false;
  }
}

/** Canonical serialization of a signed event — the stored form, and what its hash is computed over. */
export function canonicalSignedStreamEvent(event: StreamEvent): string {
  return canonicalizeJson({ ...(unsignedSigningObject(event) as Record<string, CanonicalJson>), signature: event.signature });
}

export async function hashStreamEvent(event: StreamEvent): Promise<string> {
  return bufferToHex(await crypto.subtle.digest('SHA-256', encoder.encode(canonicalSignedStreamEvent(event))));
}
