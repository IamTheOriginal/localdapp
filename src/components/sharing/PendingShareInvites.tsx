import { useMemo, useState } from 'react';
import { Inbox, ShieldCheck } from 'lucide-react';
import { useDappsList } from '@/hooks/useYjs.ts';
import { useChannelSharingCatalog } from '@/hooks/useSharing.ts';
import { parseCodeAppManifest } from '@/services/codeAppManifest.ts';
import { isShareInviteCompatible } from '@/services/shareCompatibility.ts';
import { getCodeAppFile } from '@/services/store/source.ts';
import { getRelationship } from '@/services/store/relationships.ts';
import { getPerson } from '@/services/store/people.ts';
import { acceptPendingShareInvite, declinePendingShareInvite, inspectPendingShareDefinition } from '@/services/browserRelationshipRuntime.ts';
import type { CodeAppDefinitionBundle } from '@/types.ts';
import { Alert } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import DefinitionInstallDialog from '@/components/code-app/DefinitionInstallDialog.tsx';


export default function PendingShareInvites() {
  const { pendingInvites } = useChannelSharingCatalog();
  const dapps = useDappsList();
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reviewingInviteId, setReviewingInviteId] = useState<string | null>(null);
  const [reviewingDefinition, setReviewingDefinition] = useState<CodeAppDefinitionBundle | null>(null);
  const reviewingInvite = pendingInvites.find((invite) => invite.id === reviewingInviteId) ?? null;

  const compatibleByInvite = useMemo(() => new Map(pendingInvites.map((invite) => [
    invite.id,
    dapps.filter((dapp) => {
      const parsed = parseCodeAppManifest(getCodeAppFile(dapp.id, 'manifest.yaml'));
      if (parsed.error) return false;
      return isShareInviteCompatible(invite, parsed.manifest);
    }),
  ])), [dapps, pendingInvites]);

  if (pendingInvites.length === 0) return null;

  const run = async (inviteId: string, action: () => Promise<unknown>) => {
    setBusy(inviteId);
    setErrors((current) => ({ ...current, [inviteId]: '' }));
    try { await action(); }
    catch (error) {
      setErrors((current) => ({ ...current, [inviteId]: error instanceof Error ? error.message : String(error) }));
    } finally { setBusy(null); }
  };

  return (
    <section className="mb-8" aria-labelledby="pending-share-invites-title">
      <div className="mb-3 flex items-center gap-2">
        <Inbox className="h-5 w-5 text-primary" aria-hidden="true" />
        <h2 id="pending-share-invites-title" className="text-xl font-semibold">Shared with you</h2>
        <Badge>{pendingInvites.length}</Badge>
      </div>
      <div className="grid gap-4">
        {pendingInvites.map((invite) => {
          const events = Array.isArray(invite.events) ? invite.events : [];
          const actions = Array.isArray(invite.actions) ? invite.actions : [];
          const relationship = getRelationship(invite.relationshipId);
          const sender = relationship ? getPerson(relationship.personId)?.displayName : null;
          const compatible = compatibleByInvite.get(invite.id) ?? [];
          const selected = selections[invite.id] ?? '';
          return (
            <Card key={invite.id}>
              <CardHeader>
                <div className="flex min-w-0 items-start gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl" style={{ backgroundColor: `${invite.dappMeta.color}20` }} aria-hidden="true">{invite.dappMeta.icon}</span>
                  <div className="min-w-0 flex-1">
                    <CardTitle className="break-words">{invite.dappMeta.name} · {invite.shareLabel}</CardTitle>
                    <CardDescription className="mt-1">{sender || 'A paired contact'} wants to share updates with you — without full access to either side&apos;s app.</CardDescription>
                  </div>
                  {relationship?.verifiedAt && <Badge variant="secondary"><ShieldCheck className="mr-1 h-3 w-3" />Verified</Badge>}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <PermissionList title="May send to you" items={events.map((event) => `${event.label} (${event.id})`)} />
                  <PermissionList title="May invoke in your app" items={actions.map((action) => `${action.label} (${action.id})`)} />
                </div>
                {compatible.length > 0 ? (
                  <div className="space-y-1.5">
                    <label htmlFor={`invite-app-${invite.id}`} className="text-sm font-medium">Install channel into</label>
                    <NativeSelect
                      id={`invite-app-${invite.id}`}
                      wrapperClassName="w-full"
                      value={selected}
                      onChange={(event) => setSelections((current) => ({ ...current, [invite.id]: event.target.value }))}
                    >
                      <option value="">Choose a compatible local Code App</option>
                      {compatible.map((dapp) => <option key={dapp.id} value={dapp.id}>{dapp.name}</option>)}
                    </NativeSelect>
                  </div>
                ) : (
                  <Alert variant="muted">
                    {invite.definition
                      ? 'No compatible local Code App is installed. You can review the attached signed definition and install it as a new, empty app when accepting.'
                      : 'No compatible local Code App is installed, and this offer does not include an installable definition.'}
                  </Alert>
                )}
                {errors[invite.id] && <p role="alert" className="text-sm text-destructive">{errors[invite.id]}</p>}
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button variant="outline" disabled={busy === invite.id} onClick={() => void run(invite.id, () => declinePendingShareInvite(invite.id))}>Decline</Button>
                  {invite.definition && (
                    <Button
                      variant="secondary"
                      disabled={busy === invite.id}
                      onClick={() => void run(invite.id, async () => {
                        const definition = await inspectPendingShareDefinition(invite.id);
                        if (!definition) throw new Error('This share offer has no installable app definition');
                        setReviewingDefinition(definition);
                        setReviewingInviteId(invite.id);
                      })}
                    >
                      Review attached app
                    </Button>
                  )}
                  <Button disabled={!selected || busy === invite.id} onClick={() => void run(invite.id, () => acceptPendingShareInvite(invite.id, selected))}>
                    {busy === invite.id ? 'Working…' : 'Accept share'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <DefinitionInstallDialog
        bundle={reviewingInvite ? reviewingDefinition : null}
        installing={Boolean(reviewingInvite && busy === reviewingInvite.id)}
        confirmLabel="Install app & accept share"
        onCancel={() => {
          setReviewingInviteId(null);
          setReviewingDefinition(null);
        }}
        onInstall={() => {
          if (!reviewingInvite || !reviewingDefinition) return;
          void run(reviewingInvite.id, async () => {
            await acceptPendingShareInvite(reviewingInvite.id, undefined, reviewingDefinition.signature);
            setReviewingInviteId(null);
            setReviewingDefinition(null);
          });
        }}
      />
    </section>
  );
}

function PermissionList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
        {items.map((item) => <li key={item} className="break-words">• {item}</li>)}
      </ul>
    </div>
  );
}
