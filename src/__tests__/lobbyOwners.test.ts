import { beforeAll, describe, expect, it } from 'vitest';
import { bufferToHex } from '../lib/hex.ts';
import { deriveConnectionCode } from '../services/connectionCode.ts';
import { deriveLobbyOwnerCodes } from '../services/lobbyOwners.ts';
import { signLobbyAnnounce } from '../services/store/lobbyAnnounce.ts';

const LOBBY = 'dapp-lobby-test';

interface Device { publicKey: string; privateKey: string }

async function device(): Promise<Device> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  return {
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: bufferToHex(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  };
}

/** The awareness state a device with a working key announces. */
async function announce(who: Device, displayName: string | undefined, isOwner: boolean, lobbyId = LOBBY): Promise<Record<string, unknown>> {
  const claim = { publicKey: who.publicKey, encPublicKey: `rsa-of-${who.publicKey.slice(0, 8)}`, isOwner, ...(isOwner ? { inviteId: 'inv-1' } : {}) };
  return { ...claim, ...(displayName ? { displayName } : {}), announceSig: await signLobbyAnnounce(lobbyId, claim, who) };
}

let self: Device;
let ownerA: Device;
let ownerB: Device;

beforeAll(async () => {
  [self, ownerA, ownerB] = await Promise.all([device(), device(), device()]);
});

describe('deriveLobbyOwnerCodes', () => {
  it('returns one code per owner device, each matching what that owner derives', async () => {
    const codes = await deriveLobbyOwnerCodes([
      await announce(ownerB, 'Phone', true),
      await announce(self, 'Me', false),
      await announce(ownerA, 'Laptop', true),
    ], self.publicKey, LOBBY);
    expect(codes.map((entry) => entry.displayName)).toEqual(['Laptop', 'Phone']);
    for (const entry of codes) {
      expect(entry.safetyNumber).toMatch(/^\d{8}$/);
      // The owner side derives with its own key first — the code must be symmetric.
      expect(entry.safetyNumber).toBe(await deriveConnectionCode(entry.publicKey, self.publicKey, LOBBY));
    }
    expect(codes[0].safetyNumber).not.toBe(codes[1].safetyNumber);
  });

  it('collapses several tabs of the same owner device into one entry', async () => {
    const state = await announce(ownerA, 'Laptop', true);
    expect(await deriveLobbyOwnerCodes([state, { ...state }], self.publicKey, LOBBY)).toHaveLength(1);
  });

  it('ignores non-owners, malformed states and our own key', async () => {
    const codes = await deriveLobbyOwnerCodes([
      await announce(ownerB, 'Viewer', false),
      await announce(self, undefined, true),
      { isOwner: true },
      null,
      await announce(ownerA, undefined, true),
    ], self.publicKey, LOBBY);
    expect(codes).toEqual([{ publicKey: ownerA.publicKey, displayName: 'Owner device', safetyNumber: await deriveConnectionCode(self.publicKey, ownerA.publicKey, LOBBY) }]);
  });

  it('shows no code for an "owner" that did not prove its key: unsigned, signed for another lobby, or with swapped fields', async () => {
    const genuine = await announce(ownerA, 'Laptop', true);
    const codes = await deriveLobbyOwnerCodes([
      { publicKey: ownerA.publicKey, encPublicKey: 'x', displayName: 'Unsigned', isOwner: true },
      await announce(ownerB, 'Other lobby', true, 'dapp-lobby-elsewhere'),
      { ...genuine, encPublicKey: 'attacker-rsa-key' }, // the victim's announce with the attacker's encryption key
    ], self.publicKey, LOBBY);
    expect(codes).toEqual([]);
  });

  it('keeps the order stable regardless of connection order', async () => {
    const a = await announce(ownerA, 'Laptop', true);
    const b = await announce(ownerB, 'Phone', true);
    expect(await deriveLobbyOwnerCodes([a, b], self.publicKey, LOBBY)).toEqual(await deriveLobbyOwnerCodes([b, a], self.publicKey, LOBBY));
  });
});
