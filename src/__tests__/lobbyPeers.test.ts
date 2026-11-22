import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { classifyLobbyPeer } from '../services/store/lobbyPeers.ts';

const SELF = 'owner-self';

function membersWith(entries: Record<string, Record<string, string>>): Y.Map<unknown> {
  const members = new Y.Doc().getMap('members');
  for (const [key, fields] of Object.entries(entries)) {
    const member = new Y.Map<unknown>();
    Object.entries(fields).forEach(([field, value]) => member.set(field, value));
    members.set(key, member);
  }
  return members;
}

describe('classifyLobbyPeer', () => {
  it('shows a newcomer with the key and name it announces', () => {
    expect(classifyLobbyPeer({ publicKey: 'new-device', displayName: 'Phone', encPublicKey: 'announced-enc', isOwner: false }, SELF, membersWith({})))
      .toEqual({ publicKey: 'new-device', displayName: 'Phone', encPublicKey: 'announced-enc', rejoin: false });
  });

  it('turns a waiting device that already is a member into a rejoin bound to its STORED key', () => {
    const members = membersWith({ keeper: { name: 'NAS Keeper', role: 'owner', encPublicKey: 'stored-enc' } });
    // The lobby state is self-asserted: an impostor may announce any key and name.
    const peer = classifyLobbyPeer({ publicKey: 'keeper', displayName: 'Impostor', encPublicKey: 'attacker-enc', isOwner: false }, SELF, members);
    expect(peer).toEqual({ publicKey: 'keeper', displayName: 'NAS Keeper', encPublicKey: 'stored-enc', rejoin: true, currentRole: 'owner' });
  });

  it('hides a member that has no stored encryption key — it cannot be let back in safely', () => {
    const members = membersWith({ legacy: { name: 'Old device', role: 'editor' } });
    expect(classifyLobbyPeer({ publicKey: 'legacy', encPublicKey: 'announced-enc' }, SELF, members)).toBeNull();
  });

  it('ignores hosts holding the lobby open: owners, and member devices that announce the invite they serve', () => {
    const members = membersWith({ editor: { name: 'Editor laptop', role: 'editor', encPublicKey: 'stored-enc' } });
    expect(classifyLobbyPeer({ publicKey: 'other-owner', isOwner: true, inviteId: 'inv-1' }, SELF, members)).toBeNull();
    expect(classifyLobbyPeer({ publicKey: 'editor', isOwner: false, inviteId: 'inv-1', encPublicKey: 'x' }, SELF, members)).toBeNull();
  });

  it('ignores this device and malformed states', () => {
    const members = membersWith({});
    expect(classifyLobbyPeer({ publicKey: SELF, encPublicKey: 'x' }, SELF, members)).toBeNull();
    expect(classifyLobbyPeer({ displayName: 'No key' }, SELF, members)).toBeNull();
    expect(classifyLobbyPeer(null, SELF, members)).toBeNull();
    expect(classifyLobbyPeer({ publicKey: 'nameless' }, SELF, members)).toEqual({ publicKey: 'nameless', displayName: 'Unknown Device', rejoin: false });
  });
});
