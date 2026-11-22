import { useEffect, useMemo, useState } from 'react';
import { Check, Link2, Pencil, Plus, ShieldCheck, Trash2, UserRound, UsersRound } from 'lucide-react';
import { Alert } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import { useRelationshipCatalog } from '@/hooks/useRelationships.ts';
import {
  getPendingPairingKind,
  removeContact,
  removePendingRelationship,
} from '@/services/browserRelationshipRuntime.ts';
import { deriveRelationshipSafetyNumber } from '@/services/relationshipProtocol.ts';
import { updatePerson } from '@/services/store/people.ts';
import { setRelationshipVerified } from '@/services/store/relationships.ts';
import ActiveShares from '@/components/sharing/ActiveShares.tsx';
import PairContactDialog from '@/components/sharing/PairContactDialog.tsx';
import { PersonAvatar } from '@/components/PersonAvatar.tsx';
import { DappContent } from '@/components/DappContent.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { EmptyState } from '@/components/EmptyState.tsx';
import { useI18n } from '@/i18n';

/**
 * Contacts: the people this device is paired with, and what is shared with each
 * of them. Requests (someone asking to become a contact, a share offered to
 * you) live on the Requests page; joining through a link lives behind the one
 * "Join with link" action of the shell.
 */
export default function PeoplePage() {
  const { t } = useI18n();
  const { people, relationships, channels } = useRelationshipCatalog();
  // `true` = create a new contact invite; a relationship id = reopen that pending contact's invite.
  const [pairing, setPairing] = useState<true | string | null>(null);
  const [renaming, setRenaming] = useState<{ personId: string; value: string } | null>(null);
  const [error, setError] = useState('');
  const [removeCandidate, setRemoveCandidate] = useState<{ id: string; name: string; status: 'pending' | 'active' } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const [safetyNumbers, setSafetyNumbers] = useState<Record<string, string>>({});
  const peopleById = useMemo(() => new Map(people.map((person) => [person.id, person])), [people]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(relationships.map(async (relationship) => {
      if (relationship.status === 'active' && relationship.peerPublicKey && relationship.pairContextId) {
        return [relationship.id, await deriveRelationshipSafetyNumber(relationship.localIdentity.publicKey, relationship.peerPublicKey, relationship.pairContextId)] as const;
      }
      // A pairing this device is WAITING on already has a number: it knows the inviter's key
      // from the signed, code-gated announce. Showing it only after the pairing completed was
      // too late — by then there is nothing left to decide.
      if (relationship.status === 'pending') {
        const { pendingPairingSafetyNumber } = await import('@/services/browserRelationshipRuntime.ts');
        return [relationship.id, await pendingPairingSafetyNumber(relationship.id)] as const;
      }
      return [relationship.id, null] as const;
    })).then((entries) => {
      if (!cancelled) setSafetyNumbers(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry[1] !== null)));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [relationships]);

  const saveRename = () => {
    if (!renaming) return;
    setError('');
    try {
      updatePerson(renaming.personId, { displayName: renaming.value });
      setRenaming(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('Could not rename this contact.')); }
  };

  const confirmRemove = async () => {
    if (!removeCandidate) return;
    setRemoving(true); setRemoveError('');
    try {
      if (removeCandidate.status === 'active') await removeContact(removeCandidate.id);
      else await removePendingRelationship(removeCandidate.id);
      setRemoveCandidate(null);
    } catch (caught) {
      setRemoveError(caught instanceof Error ? caught.message : t('Could not remove this contact.'));
    } finally { setRemoving(false); }
  };

  return (
    <DappContent>
      <PageHeader
        icon={<UsersRound className="h-5 w-5" />}
        title={t('Contacts')}
        description={t('Pair privately with a person, then let apps share selected updates with them over isolated channels.')}
        actions={<Button onClick={() => setPairing(true)}><Plus className="h-4 w-4" />{t('Add contact')}</Button>}
      />

      {error && <Alert variant="destructive" role="alert" className="mb-6">{error}</Alert>}

      {relationships.length === 0 ? (
        <EmptyState
          icon={<UserRound className="h-6 w-6" />}
          title={t('No contacts yet')}
          description={t('Add a contact to create a private, encrypted connection to one person. Every contact stays isolated from all others.')}
          action={<Button onClick={() => setPairing(true)}><Plus className="h-4 w-4" />{t('Add contact')}</Button>}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {relationships.map((relationship) => {
            const person = peopleById.get(relationship.personId);
            const personName = person?.displayName ?? t('Unknown contact');
            const relatedChannels = channels.filter((channel) => channel.relationshipId === relationship.id);
            const pendingKind = relationship.status === 'pending' ? getPendingPairingKind(relationship.id) : null;
            return (
              <Card key={relationship.id}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <PersonAvatar name={personName} seed={relationship.peerPublicKey || relationship.id} size="lg" verified={Boolean(relationship.verifiedAt)} />
                      <div className="min-w-0">
                        {renaming?.personId === relationship.personId ? (
                          <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); saveRename(); }}>
                            <Input autoFocus value={renaming.value} maxLength={64} aria-label={t('Contact name')} onChange={(event) => setRenaming({ personId: relationship.personId, value: event.target.value })} />
                            <Button type="submit" size="sm" disabled={!renaming.value.trim()} aria-label={t('Save name')}><Check className="h-4 w-4" /></Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>{t('Cancel')}</Button>
                          </form>
                        ) : (
                          <CardTitle className="break-words">
                            {personName}
                            <Button variant="ghost" size="icon-sm" className="ml-1 align-middle text-muted-foreground" aria-label={`${t('Rename')} ${personName}`} onClick={() => setRenaming({ personId: relationship.personId, value: personName })}>
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          </CardTitle>
                        )}
                        <CardDescription>{relationship.status === 'active' ? t('Paired — encrypted connection set up') : t('Pairing not completed')}</CardDescription>
                      </div>
                    </div>
                    <Badge variant={relationship.status === 'active' ? 'default' : 'secondary'}>{relationship.status === 'active' ? t('active') : t('pending')}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="rounded-lg bg-muted/40 p-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      {relationship.status === 'pending' && safetyNumbers[relationship.id] ? t('Safety number — compare BEFORE they approve') : t('Safety number')}
                    </p>
                    <p className="mt-1 break-words font-mono text-sm">{safetyNumbers[relationship.id] ?? t('Available after pairing')}</p>
                    {relationship.status === 'pending' && safetyNumbers[relationship.id] && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t('The same number is on the other device, next to your request. Read it out before they approve — the invite code alone does not say who is on the other end.')}
                      </p>
                    )}
                    {relationship.status === 'active' && safetyNumbers[relationship.id] && (relationship.verifiedAt ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Badge><ShieldCheck className="mr-1 h-3 w-3" />{t('Verified')}</Badge>
                        <Button variant="ghost" size="sm" onClick={() => setRelationshipVerified(relationship.id, false)}>{t('Remove verification')}</Button>
                      </div>
                    ) : (
                      <div className="mt-2 space-y-2">
                        <p className="text-xs text-muted-foreground">
                          {t('Not verified yet. Compare this number with your contact on a call or in person — it must be identical on both devices. Anyone who got hold of the invite could otherwise be on the other end.')}
                        </p>
                        <Button variant="outline" size="sm" onClick={() => setRelationshipVerified(relationship.id, true)}>
                          <Check className="h-4 w-4" />{t('The numbers match — mark as verified')}
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">{relatedChannels.length} {relatedChannels.length === 1 ? t('isolated channel') : t('isolated channels')}</Badge>
                    {relationship.controlCapabilityId && <Badge variant="outline"><ShieldCheck className="mr-1 h-3 w-3" />{t('Connection installed')}</Badge>}
                  </div>
                  {relationship.status === 'active' && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">{t('Shared with this contact')}</p>
                      <ActiveShares relationshipId={relationship.id} emptyHint={t('Nothing shared yet. Apps offer sharing from inside the app.')} />
                    </div>
                  )}
                  {relationship.status === 'pending' ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {pendingKind === 'hosted' && <Button className="w-full sm:w-auto" onClick={() => setPairing(relationship.id)}><Link2 className="h-4 w-4" />{t('Show invite')}</Button>}
                      {pendingKind === 'joining' && <p className="text-sm text-muted-foreground">{t('Waiting for approval by')} {personName}…</p>}
                      <Button variant="outline" className="w-full sm:w-auto" onClick={() => { setRemoveError(''); setRemoveCandidate({ id: relationship.id, name: personName, status: 'pending' }); }}><Trash2 className="h-4 w-4" />{t('Remove pending contact')}</Button>
                    </div>
                  ) : (
                    <Button variant="outline" className="w-full sm:w-auto" onClick={() => { setRemoveError(''); setRemoveCandidate({ id: relationship.id, name: personName, status: 'active' }); }}><Trash2 className="h-4 w-4" />{t('Remove contact')}</Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <PairContactDialog
        open={pairing !== null}
        relationshipId={typeof pairing === 'string' ? pairing : undefined}
        onOpenChange={(open) => { if (!open) setPairing(null); }}
      />

      <Dialog open={Boolean(removeCandidate)} onOpenChange={(open) => { if (!open && !removing) { setRemoveCandidate(null); setRemoveError(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{removeCandidate?.status === 'active' ? t('Remove this contact?') : t('Remove this pending contact?')}</DialogTitle>
            <DialogDescription>
              {removeCandidate?.status === 'active'
                ? `${removeCandidate.name}: ${t('This deletes the pairing on this device: the encrypted connection, every isolated share channel with its synced data, and the contact entry. A signed erase request is sent for each channel — but if the other device is offline right now, it keeps whatever was already shared. This cannot be undone.')}`
                : `${removeCandidate?.name ?? ''}: ${t('The incomplete pairing will be removed from this device. Stored lobby data is also cleared when available.')}`}
            </DialogDescription>
          </DialogHeader>
          {removeError && <Alert variant="destructive" role="alert">{removeError}</Alert>}
          <DialogFooter>
            <Button variant="outline" disabled={removing} onClick={() => setRemoveCandidate(null)}>{t('Cancel')}</Button>
            <Button variant="destructive" disabled={removing} onClick={() => void confirmRemove()}>
              {removing ? t('Removing…') : removeCandidate?.status === 'active' ? t('Remove contact') : t('Remove pending contact')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DappContent>
  );
}
