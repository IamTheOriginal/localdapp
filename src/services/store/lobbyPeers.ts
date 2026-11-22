import type * as Y from 'yjs';
import type { MemberRole } from '../../types.ts';

/**
 * A device WAITING in an invite lobby, as an owner should see it.
 *
 * `rejoin` marks a device whose key is already in the members map: it lost its
 * copy of the dapp (deleted it, got stuck on an old room after a rotation, a
 * keeper dropped a dapp it founded, …) and asks to be let back in. Such a
 * device never gets a new member entry — approval only re-sends the room
 * credentials, encrypted to the encryption key STORED for that member. Every
 * awareness field is self-asserted, so anyone holding the invite link can claim
 * a member's public key; with the stored key an impostor receives ciphertext it
 * cannot read, and the announced `encPublicKey` is ignored for members.
 */
export interface WaitingLobbyDevice {
  publicKey: string;
  displayName: string;
  /** Key the credential grant will be encrypted to (stored key for a rejoin, announced key for a newcomer). */
  encPublicKey?: string;
  rejoin: boolean;
  /** Present for a rejoin: the role the member keeps. */
  currentRole?: MemberRole;
}

/**
 * Classify one awareness state of an invite lobby. Returns null for everything
 * that is not a waiting device: this device, hosts holding the lobby open
 * (owners announce `isOwner`, every member host announces the `inviteId` it
 * serves — joiners announce neither), malformed states, and members that have
 * no stored encryption key (they cannot be re-granted safely; remove and
 * re-invite them instead).
 */
export function classifyLobbyPeer(state: unknown, selfKey: string, members: Y.Map<unknown>): WaitingLobbyDevice | null {
  const peer = (state ?? {}) as { publicKey?: unknown; displayName?: unknown; encPublicKey?: unknown; isOwner?: unknown; inviteId?: unknown };
  if (typeof peer.publicKey !== 'string' || !peer.publicKey || peer.publicKey === selfKey) return null;
  if (peer.isOwner === true || peer.inviteId !== undefined) return null;
  const announcedName = typeof peer.displayName === 'string' && peer.displayName ? peer.displayName : '';

  const member = members.get(peer.publicKey) as Y.Map<unknown> | undefined;
  if (member) {
    const storedKey = member.get('encPublicKey');
    if (typeof storedKey !== 'string' || !storedKey) return null;
    const storedName = member.get('name');
    const role = member.get('role');
    return {
      publicKey: peer.publicKey,
      displayName: (typeof storedName === 'string' && storedName) || announcedName || 'Unknown Device',
      encPublicKey: storedKey,
      rejoin: true,
      ...(role === 'owner' || role === 'editor' || role === 'viewer' ? { currentRole: role } : {}),
    };
  }

  return {
    publicKey: peer.publicKey,
    displayName: announcedName || 'Unknown Device',
    ...(typeof peer.encPublicKey === 'string' && peer.encPublicKey ? { encPublicKey: peer.encPublicKey } : {}),
    rejoin: false,
  };
}
