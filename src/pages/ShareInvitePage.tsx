import { useParams } from 'react-router-dom';
import { UserPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { DappContent } from '@/components/DappContent.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import AccessDenied from '@/components/AccessDenied.tsx';
import AccessRequestRow from '@/components/sharing/AccessRequestRow.tsx';
import ActiveShares from '@/components/sharing/ActiveShares.tsx';
import DappInvitesPanel from '@/components/sharing/DappInvitesPanel.tsx';
import DappMembersList from '@/components/sharing/DappMembersList.tsx';
import { useCodeAppManifest, useDappConfig, useDappsList, useMyRole } from '@/hooks/useYjs.ts';
import { useDappAccessRequests } from '@/hooks/useRequestsInbox.ts';
import { useI18n } from '@/i18n';

/**
 * THE place for "who can use this app": devices waiting to get in, the invites
 * that let them in, the members that are in, and what the app shares with
 * contacts. One routed, owner-only page — it replaced a dialog that was mounted
 * twice (sidebar and Dapp settings) and a member list that lived elsewhere.
 */
export default function ShareInvitePage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useI18n();
  const config = useDappConfig(id);
  const { manifest } = useCodeAppManifest(id);
  const myRole = useMyRole(id);
  const inCatalog = useDappsList().some((dapp) => dapp.id === id);
  const waiting = useDappAccessRequests().filter((request) => request.dappId === id);

  if (!id || !config || !inCatalog || myRole === null) {
    return <div className="animate-pulse p-8 text-center text-sm text-muted-foreground">{t('Loading…')}</div>;
  }
  if (myRole !== 'owner') {
    return <AccessDenied dappId={id} message={t('Only owners can invite people and manage members of this app.')} />;
  }

  const appName = config.meta.name;
  const declaresShares = (manifest.channels?.shares ?? []).length > 0;

  return (
    <DappContent width="narrow">
      <PageHeader
        icon={<UserPlus className="h-5 w-5" />}
        title={`${appName} · ${t('Share & invite')}`}
        description={t('Invite devices into this app, approve them, and manage who is in.')}
      />

      <div className="flex flex-col gap-6">
        {waiting.length > 0 && (
          <Card className="border-primary/40 bg-primary/5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">{t('Waiting for approval')}<Badge>{waiting.length}</Badge></CardTitle>
              <CardDescription>{t('Compare the connection code with the one on the joining device before you approve it.')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {waiting.map((entry) => (
                <AccessRequestRow
                  key={entry.publicKey}
                  entry={entry}
                  title={<span className="text-sm">{entry.displayName}</span>}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center"
                />
              ))}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>{t('Invites')}</CardTitle>
            <CardDescription>
              {t('People who join get full access. With a standard invite you confirm every device first; a 1-step invite lets anyone with the link join instantly.')}
            </CardDescription>
          </CardHeader>
          <CardContent><DappInvitesPanel dappId={id} appName={appName} /></CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('Members')}</CardTitle>
            <CardDescription>{t('Devices with full access to this app.')}</CardDescription>
          </CardHeader>
          <CardContent><DappMembersList dappId={id} /></CardContent>
        </Card>

        {declaresShares && (
          <Card>
            <CardHeader>
              <CardTitle>{t('Shared with contacts')}</CardTitle>
              <CardDescription>
                {t('Selected updates only — a contact never gets access to the whole app. Sharing starts from inside the app.')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ActiveShares dappId={id} emptyHint={t('Nothing shared yet. Look for the share action inside the app.')} />
            </CardContent>
          </Card>
        )}
      </div>
    </DappContent>
  );
}
