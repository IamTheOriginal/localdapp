import { useEffect, useState } from 'react';
import type { ChannelShare, PendingShareInvite } from '@/types.ts';
import { getRootDoc, getRootPersistence } from '@/services/store/docs.ts';
import { listAllChannelShares } from '@/services/store/channelShares.ts';
import { listPendingShareInvites } from '@/services/store/pendingShareInvites.ts';

interface ChannelSharingCatalog {
  pendingInvites: PendingShareInvite[];
  shares: ChannelShare[];
}

export function useChannelSharingCatalog(): ChannelSharingCatalog {
  const [catalog, setCatalog] = useState<ChannelSharingCatalog>({ pendingInvites: [], shares: [] });
  useEffect(() => {
    const rootDoc = getRootDoc();
    const invites = rootDoc.getMap('pendingShareInvites');
    const shares = rootDoc.getMap('channelShares');
    const refresh = () => setCatalog({
      pendingInvites: listPendingShareInvites(rootDoc).filter((invite) => invite.status === 'pending'),
      shares: listAllChannelShares(rootDoc),
    });
    const persistence = getRootPersistence();
    if (persistence) void Promise.resolve(persistence.whenSynced).then(refresh);
    refresh();
    invites.observeDeep(refresh);
    shares.observeDeep(refresh);
    return () => {
      invites.unobserveDeep(refresh);
      shares.unobserveDeep(refresh);
    };
  }, []);
  return catalog;
}
