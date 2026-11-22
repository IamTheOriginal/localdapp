import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Inbox, KeyRound, UserRoundPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge.tsx';
import { EmptyState } from '@/components/EmptyState.tsx';
import { usePairingRequests, useDappAccessRequests } from '@/hooks/useRequestsInbox.ts';
import PairingRequestRow from '@/components/sharing/PairingRequestRow.tsx';
import { useChannelSharingCatalog } from '@/hooks/useSharing.ts';
import { approveRelationshipPairing } from '@/services/browserRelationshipRuntime.ts';
import AccessRequestRow from '@/components/sharing/AccessRequestRow.tsx';
import PendingShareInvites from '@/components/sharing/PendingShareInvites.tsx';
import { useI18n } from '@/i18n';

/**
 * The one place requests land (the Requests page): devices waiting in any of
 * your apps' invite lobbies, contact requests from every hosted invite, and
 * shares offered by a contact. The shell badge counts the same items, minus
 * devices a 1-step invite admits on its own.
 */
export default function RequestsInbox() {
  const { t } = useI18n();
  const pairingRequests = usePairingRequests();
  const accessRequests = useDappAccessRequests();
  const { pendingInvites } = useChannelSharingCatalog();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const approve = async (inviteId: string, requestId: string) => {
    setBusy(requestId);
    setErrors((current) => ({ ...current, [requestId]: '' }));
    try {
      await approveRelationshipPairing(inviteId, requestId);
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [requestId]: error instanceof Error ? error.message : t('Could not approve this request.'),
      }));
    } finally {
      setBusy(null);
    }
  };

  if (pairingRequests.length === 0 && accessRequests.length === 0 && pendingInvites.length === 0) {
    return (
      <EmptyState
        icon={<Inbox className="h-6 w-6" />}
        title={t('Nothing is waiting')}
        description={t('Devices asking to join your apps, contact requests and shares offered to you appear here.')}
      />
    );
  }

  return (
    <>
      {accessRequests.length > 0 && (
        <section className="mb-8" aria-labelledby="access-requests-title">
          <div className="mb-3 flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" aria-hidden="true" />
            <h2 id="access-requests-title" className="text-xl font-semibold">{t('Devices waiting')}</h2>
            <Badge>{accessRequests.length}</Badge>
          </div>
          <div className="grid gap-3">
            {accessRequests.map((entry) => (
              <div key={`${entry.dappId}:${entry.publicKey}`} className="grid gap-1.5">
                <AccessRequestRow
                  entry={entry}
                  title={<>{entry.displayName} → {entry.dappIcon} {entry.dappName}</>}
                />
                <Link to={`/dapp/${entry.dappId}/share`} className="justify-self-start px-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                  {t('Open Share & invite')} ›
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}

      {pairingRequests.length > 0 && (
        <section className="mb-8" aria-labelledby="pairing-requests-title">
          <div className="mb-3 flex items-center gap-2">
            <UserRoundPlus className="h-5 w-5 text-primary" aria-hidden="true" />
            <h2 id="pairing-requests-title" className="text-xl font-semibold">{t('Contact requests')}</h2>
            <Badge>{pairingRequests.length}</Badge>
          </div>
          <div className="grid gap-3">
            {pairingRequests.map((entry) => (
              <PairingRequestRow
                key={entry.requestId}
                personName={entry.personName}
                requesterPublicKey={entry.requesterPublicKey}
                safetyNumber={entry.safetyNumber}
                valid={entry.valid}
                busy={busy === entry.requestId}
                error={errors[entry.requestId]}
                onApprove={() => void approve(entry.inviteId, entry.requestId)}
              />
            ))}
          </div>
        </section>
      )}

      <PendingShareInvites />
    </>
  );
}
