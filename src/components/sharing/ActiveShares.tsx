import { useMemo, useState } from 'react';
import { Radio, ShieldOff, Trash2 } from 'lucide-react';
import type { ChannelShare } from '@/types.ts';
import { useDappsList } from '@/hooks/useYjs.ts';
import { useRelationshipCatalog } from '@/hooks/useRelationships.ts';
import { useChannelSharingCatalog } from '@/hooks/useSharing.ts';
import { Alert } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { EmptyState } from '@/components/EmptyState.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';
import { useI18n } from '@/i18n';

/**
 * Shares = selected updates of an app that travel to ONE contact over its own
 * isolated channel (not membership — that is an invite). The list is shown
 * where the question comes up: per app on its Share & invite page (`dappId`)
 * and per person on the Contacts page (`relationshipId`).
 */
export default function ActiveShares({ dappId, relationshipId, emptyHint }: {
  dappId?: string;
  relationshipId?: string;
  /** Replaces the default empty state — e.g. a one-liner inside a card. */
  emptyHint?: string;
}) {
  const { t } = useI18n();
  const { shares: allShares } = useChannelSharingCatalog();
  const shares = allShares.filter((share) => (!dappId || share.dappId === dappId) && (!relationshipId || share.relationshipId === relationshipId));
  const dapps = useDappsList();
  const { people, relationships } = useRelationshipCatalog();
  const [candidate, setCandidate] = useState<ChannelShare | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dappNames = useMemo(() => new Map(dapps.map((dapp) => [dapp.id, dapp.name])), [dapps]);
  const peopleById = useMemo(() => new Map(people.map((person) => [person.id, person.displayName])), [people]);
  const contactNames = useMemo(() => new Map(relationships.map((relationship) => [
    relationship.id,
    peopleById.get(relationship.personId) || t('Unknown contact'),
  ])), [peopleById, relationships, t]);

  const ordered = [...shares].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const remove = async (localOnly = false) => {
    if (!candidate) return;
    setBusy(true); setError('');
    try {
      const runtime = await import('@/services/browserRelationshipRuntime.ts');
      const revocable = candidate.status === 'active' || candidate.status === 'pending';
      if (revocable && !localOnly) await runtime.revokeChannelShareParticipant(candidate);
      else await runtime.removeChannelShareLocally(candidate);
      setCandidate(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setBusy(false); }
  };

  if (ordered.length === 0) {
    if (emptyHint) return <p className="text-sm text-muted-foreground">{emptyHint}</p>;
    return (
      <EmptyState
        icon={<Radio className="h-6 w-6" />}
        title={t('Nothing shared yet')}
        description={t('When an app shares selected updates with a contact, the share appears here.')}
      />
    );
  }

  return (
    <>
      <div className="grid gap-4">
        {ordered.map((share) => (
          <Card key={share.id}>
            <CardHeader>
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <CardTitle className="break-words">{dappNames.get(share.dappId) || t('Local Code App')} · {share.shareId}</CardTitle>
                  <CardDescription className="mt-1">
                    {t('Contact')}: {contactNames.get(share.relationshipId) || t('Unknown contact')} · {t('Created')} {new Date(share.createdAt).toLocaleString()}
                  </CardDescription>
                </div>
                <Badge variant={share.status === 'active' ? 'default' : 'secondary'}>{share.status}</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <PermissionSummary label={t('Outbound events')} values={share.eventIds} />
                <PermissionSummary label={t('Inbound actions')} values={share.actionIds} />
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="break-all font-mono text-[11px] text-muted-foreground">Instance {share.instanceId}</p>
                <Button
                  variant="destructive"
                  onClick={() => { setError(''); setCandidate(share); }}
                >
                  {share.status === 'revoked' ? <Trash2 className="h-4 w-4" /> : <ShieldOff className="h-4 w-4" />}
                  {share.status === 'active' ? t('Stop sharing') : share.status === 'pending' ? t('Withdraw share offer') : t('Remove')}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={Boolean(candidate)} onOpenChange={(open) => { if (!open && !busy) setCandidate(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {candidate?.status === 'active' ? t('Stop sharing with this contact?')
                : candidate?.status === 'pending' ? t('Withdraw this share offer?') : t('Remove this share entry?')}
            </DialogTitle>
            <DialogDescription>
              {candidate?.status === 'active'
                ? t('Access will be revoked, the local channel will be destroyed, and a signed remote purge will be queued.')
                : candidate?.status === 'pending'
                  ? t('The signed offer will be revoked and a remote purge will remain queued even if the other device is currently offline.')
                  : t('This stale or resolved share entry will be removed from this device.')}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <div className="space-y-3">
              <Alert variant="destructive" role="alert">{error}</Alert>
              {(candidate?.status === 'active' || candidate?.status === 'pending') && (
                <Button variant="outline" className="w-full" disabled={busy} onClick={() => void remove(true)}>
                  {t('Remove locally instead')}
                </Button>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setCandidate(null)}>{t('Cancel')}</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
              {busy ? t('Removing…') : candidate?.status === 'active' ? t('Stop sharing')
                : candidate?.status === 'pending' ? t('Withdraw share offer') : t('Remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PermissionSummary({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <h3 className="text-sm font-semibold">{label}</h3>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {values.map((value) => <Badge key={value} variant="outline" className="h-auto whitespace-normal break-all">{value}</Badge>)}
      </div>
    </div>
  );
}
