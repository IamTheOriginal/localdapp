import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';
import { Label } from '@/components/ui/label.tsx';
import InviteLinkPanel from '@/components/sharing/InviteLinkPanel.tsx';
import PairingRequestRow from '@/components/sharing/PairingRequestRow.tsx';
import type { RelationshipPairingRequestInfo } from '@/services/relationshipPairingRuntime.ts';
import {
  approveRelationshipPairing,
  getHostedPairingInvite,
  hostRelationshipPairing,
  listHostedPairingRequests,
  observeHostedPairingRequests,
  pendingPairingSafetyNumber,
  reissueRelationshipInvite,
} from '@/services/browserRelationshipRuntime.ts';
import { useI18n } from '@/i18n';

interface HostedState { inviteId: string; uri: string; relationshipId: string }

/**
 * "Add contact": create a contact invite, hand over the link / QR code, and
 * approve the person when they show up. Used from the Contacts page and when a
 * Code App asks for a new contact (`$contacts.invite`). Pass `relationshipId`
 * to reopen the invite of a pending contact instead of creating a new one.
 */
export default function PairContactDialog({ open, onOpenChange, relationshipId, onPaired }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  relationshipId?: string;
  onPaired?: () => void;
}) {
  const { t } = useI18n();
  const [hosted, setHosted] = useState<HostedState | null>(null);
  const [requests, setRequests] = useState<RelationshipPairingRequestInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Requester key → the safety number of that pairing, shown before Approve. */
  const [safetyNumbers, setSafetyNumbers] = useState<Record<string, string>>({});

  // Reopen the persisted invite of a pending contact (re-issued when it expired).
  useEffect(() => {
    if (!open || !relationshipId) return;
    let cancelled = false;
    void (async () => {
      try {
        const info = getHostedPairingInvite(relationshipId);
        if (!info) return;
        const current = info.expired ? await reissueRelationshipInvite(relationshipId) : info;
        if (!cancelled) setHosted({ inviteId: current.inviteId, uri: current.uri, relationshipId });
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : t('Could not reopen the invite.'));
      }
    })();
    return () => { cancelled = true; };
  }, [open, relationshipId, t]);

  useEffect(() => {
    if (!hosted) return;
    void listHostedPairingRequests(hosted.inviteId).then(setRequests).catch(() => undefined);
    return observeHostedPairingRequests(hosted.inviteId, setRequests);
  }, [hosted]);

  // Derived here, not on approval: the number is what tells the expected person from anyone
  // else who got hold of the invite code, so it has to be on screen BEFORE the button is used.
  useEffect(() => {
    if (!hosted) return;
    let cancelled = false;
    void Promise.all(requests.map(async ({ request }) => [
      request.requesterPublicKey,
      await pendingPairingSafetyNumber(hosted.relationshipId, request.requesterPublicKey),
    ] as const))
      .then((entries) => {
        if (cancelled) return;
        setSafetyNumbers(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry[1] !== null)));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [hosted, requests]);

  const reset = () => { setHosted(null); setRequests([]); setError(''); setSafetyNumbers({}); };

  const createInvite = async () => {
    setBusy(true); setError('');
    try {
      const result = await hostRelationshipPairing();
      setHosted({ inviteId: result.inviteId, uri: result.uri, relationshipId: result.relationshipId });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Could not create the contact invite.'));
    } finally { setBusy(false); }
  };

  const approve = async (requestId: string) => {
    if (!hosted) return;
    setBusy(true); setError('');
    try {
      await approveRelationshipPairing(hosted.inviteId, requestId);
      reset();
      onOpenChange(false);
      onPaired?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Could not approve this request.'));
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('Add contact')}</DialogTitle>
          <DialogDescription>
            {t("Create a short invite code (valid 7 days). Their name fills in automatically when they accept. Closing this dialog is fine — reopen the invite any time from the contact's card. Approve only the person you expect.")}
          </DialogDescription>
        </DialogHeader>
        {!hosted ? (
          <Alert variant="muted">{t('The invite carries your name; the contact card takes theirs once they accept — nobody types a name for anybody.')}</Alert>
        ) : (
          <div className="space-y-4">
            <InviteLinkPanel uri={hosted.uri} shareTitle={t('Become my contact on Dapp Builder')} />
            <div className="space-y-2">
              <Label>{t('Contact requests')}</Label>
              {requests.length === 0 ? <Alert variant="muted">{t('Waiting for the other device…')}</Alert> : requests.map(({ request, valid }) => (
                <PairingRequestRow
                  key={request.requestId}
                  personName={request.displayName || ''}
                  requesterPublicKey={request.requesterPublicKey}
                  safetyNumber={safetyNumbers[request.requesterPublicKey] ?? null}
                  valid={valid}
                  busy={busy}
                  onApprove={() => void approve(request.requestId)}
                />
              ))}
            </div>
          </div>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onOpenChange(false); }}>{t('Close')}</Button>
          {!hosted && <Button disabled={busy} onClick={() => void createInvite()}>{busy ? t('Creating…') : t('Create invite')}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
