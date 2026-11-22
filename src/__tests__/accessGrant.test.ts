import { describe, expect, it } from 'vitest';
import { formatAccessGrant, parseAccessGrant } from '../services/store/accessGrant.ts';

const OWNER_KEY = 'ab'.repeat(32);
const ROOM_ID = 'dapp-123e4567-e89b-42d3-a456-426614174000';
const ROOM_PASSWORD = 'cd'.repeat(32);

describe('access grant payload', () => {
  it('round-trips credentials, epoch and the granting owner key', () => {
    const payload = formatAccessGrant({ roomId: ROOM_ID, roomPassword: ROOM_PASSWORD, epoch: 7, grantedBy: OWNER_KEY });
    expect(parseAccessGrant(payload)).toEqual({ roomId: ROOM_ID, roomPassword: ROOM_PASSWORD, epoch: '7', grantedBy: OWNER_KEY });
  });

  it('still reads grants from older builds (no granter, no epoch)', () => {
    expect(parseAccessGrant(`${ROOM_ID}:${ROOM_PASSWORD}:3`)).toEqual({ roomId: ROOM_ID, roomPassword: ROOM_PASSWORD, epoch: '3' });
    expect(parseAccessGrant(`${ROOM_ID}:${ROOM_PASSWORD}`)).toEqual({ roomId: ROOM_ID, roomPassword: ROOM_PASSWORD });
  });

  it('drops a malformed granter key or epoch instead of pinning garbage', () => {
    expect(parseAccessGrant(`${ROOM_ID}:${ROOM_PASSWORD}:x:not-a-key`)).toEqual({ roomId: ROOM_ID, roomPassword: ROOM_PASSWORD });
  });

  it('rejects payloads without room credentials', () => {
    expect(parseAccessGrant('')).toBeNull();
    expect(parseAccessGrant(`${ROOM_ID}:`)).toBeNull();
  });

  it('omits the granter segment when the approver has no identity', () => {
    expect(formatAccessGrant({ roomId: 'r', roomPassword: 'p', epoch: 1 })).toBe('r:p:1');
  });

  it('fits the raw RSA-OAEP limit the grant is encrypted under', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      false,
      ['encrypt', 'decrypt'],
    );
    // A generous epoch: rotation counts stay far below this.
    const payload = formatAccessGrant({ roomId: ROOM_ID, roomPassword: ROOM_PASSWORD, epoch: 999_999_999, grantedBy: OWNER_KEY });
    const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pair.publicKey, new TextEncoder().encode(payload));
    const decrypted = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, pair.privateKey, encrypted));
    expect(parseAccessGrant(decrypted)?.grantedBy).toBe(OWNER_KEY);
  });
});
