import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createPendingShareInvite,
  declinePendingShareInvitesByChannel,
  listPendingShareInvites,
} from '../services/store/pendingShareInvites.ts';

function createInvite(doc: Y.Doc, relationshipId: string, channelId: string, offerId: string) {
  return createPendingShareInvite({
    relationshipId,
    dappId: 'remote-app',
    shareId: 'shared-data',
    shareLabel: 'Shared data',
    instanceId: 'instance-1',
    offerId,
    dappMeta: { name: 'App', icon: '📦', color: '#123456' },
    events: [],
    actions: [],
    routes: [],
    channel: {
      id: channelId,
      schemaVersion: 1,
      roomId: `room-${offerId}`,
      roomPassword: `secret-${offerId}`,
      memberDeviceKeys: ['local-key', 'peer-key'],
      createdAt: '2026-08-21T10:00:00.000Z',
    },
    offerMessageId: `message-${offerId}`,
    offerMessageHash: `hash-${offerId}`,
  }, doc);
}

describe('pending invite revocation tombstones', () => {
  it('declines every pending offer for the authenticated relationship and channel only', () => {
    const doc = new Y.Doc();
    const first = createInvite(doc, 'relationship-a', 'channel-1', 'offer-1');
    const second = createInvite(doc, 'relationship-a', 'channel-1', 'offer-2');
    const otherRelationship = createInvite(doc, 'relationship-b', 'channel-1', 'offer-3');
    const otherChannel = createInvite(doc, 'relationship-a', 'channel-2', 'offer-4');

    expect(declinePendingShareInvitesByChannel('relationship-a', 'channel-1', doc).map((invite) => invite.id).sort())
      .toEqual([first.id, second.id].sort());

    const statuses = new Map(listPendingShareInvites(doc).map((invite) => [invite.id, invite.status]));
    expect(statuses.get(first.id)).toBe('declined');
    expect(statuses.get(second.id)).toBe('declined');
    expect(statuses.get(otherRelationship.id)).toBe('pending');
    expect(statuses.get(otherChannel.id)).toBe('pending');
  });
});
