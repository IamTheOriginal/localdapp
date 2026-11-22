import { deriveConnectionCode } from './connectionCode.ts';
import { verifiedLobbyStates } from './store/lobbyAnnounce.ts';

/** One owner device present in an invite lobby, with the connection code that device shows for us. */
export interface LobbyOwnerCode {
  publicKey: string;
  displayName: string;
  safetyNumber: string;
}

/**
 * A connection code is derived from exactly two device keys, so a waiting
 * joiner has one code PER owner device in the lobby: each owner's screen shows
 * the code for its own key. Returns every distinct owner (tabs of one device
 * share a key and collapse into one entry) in a stable order, so the list does
 * not reshuffle as peers reconnect.
 */
export async function deriveLobbyOwnerCodes(states: Iterable<unknown>, selfKey: string, lobbyId: string): Promise<LobbyOwnerCode[]> {
  const owners = new Map<string, string>();
  // Only devices that proved the key they announce — a code for a claimed key would be worthless.
  for (const state of await verifiedLobbyStates(lobbyId, states)) {
    const peer = (state ?? {}) as { isOwner?: unknown; publicKey?: unknown; displayName?: unknown };
    if (peer.isOwner !== true || typeof peer.publicKey !== 'string' || !peer.publicKey || peer.publicKey === selfKey) continue;
    if (owners.has(peer.publicKey)) continue;
    owners.set(peer.publicKey, typeof peer.displayName === 'string' && peer.displayName ? peer.displayName : 'Owner device');
  }
  const codes = await Promise.all([...owners].map(async ([publicKey, displayName]) => ({
    publicKey, displayName, safetyNumber: await deriveConnectionCode(selfKey, publicKey, lobbyId),
  })));
  return codes.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.publicKey.localeCompare(b.publicKey));
}
