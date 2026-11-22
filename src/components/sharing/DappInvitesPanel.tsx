import { useState, useSyncExternalStore } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Alert } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import InviteLinkPanel from '@/components/sharing/InviteLinkPanel.tsx';
import { useInvites } from '@/hooks/useYjs.ts';
import { appInviteUri, createInvite, deleteInvite } from '@/services/store/index.ts';
import { showConfirm } from '@/services/dialogs.ts';
import { getAutomaticAdmissions, subscribeAutomaticAdmissions } from '@/services/store/automaticAdmissions.ts';
import { formatConnectionCode } from '@/services/connectionCode.ts';
import { useI18n } from '@/i18n';

/**
 * Create, hand over and delete the invites of one dapp. An invite lets a
 * DEVICE into the whole app (it becomes a member); sharing selected updates
 * with a contact is a different thing and lives in the app itself.
 */
export default function DappInvitesPanel({ dappId, appName }: { dappId: string; appName: string }) {
  const { t } = useI18n();
  const invites = useInvites(dappId);
  const [inviteType, setInviteType] = useState<'one-time' | 'multi' | 'open'>('one-time');
  const [openRole, setOpenRole] = useState<'editor' | 'viewer'>('editor');
  const [error, setError] = useState('');
  const admissions = useSyncExternalStore(subscribeAutomaticAdmissions, () => getAutomaticAdmissions(dappId), () => getAutomaticAdmissions(dappId));

  const handleCreate = async () => {
    setError('');
    try {
      await createInvite(dappId, inviteType === 'one-time' ? 1 : 999999, inviteType === 'open'
        ? { autoApprove: true, autoRole: openRole }
        : {});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Could not create the invite.'));
    }
  };

  const handleDelete = async (inviteId: string) => {
    const confirmed = await showConfirm(
      t("Delete this invite? The link will stop working for anyone who hasn't joined yet."),
      { title: t('Delete invite'), confirmLabel: t('Delete'), danger: true },
    );
    if (!confirmed) return;
    try {
      await deleteInvite(dappId, inviteId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          value={inviteType}
          aria-label={t('Invite type')}
          onChange={(event) => setInviteType(event.target.value as 'one-time' | 'multi' | 'open')}
        >
          <option value="one-time">{t('One person (closes after use)')}</option>
          <option value="multi">{t('Multiple people (stays open)')}</option>
          <option value="open">{t('Anyone with the link (1-step, no approval)')}</option>
        </NativeSelect>
        {inviteType === 'open' && (
          <NativeSelect
            value={openRole}
            aria-label={t('Role for people who join')}
            onChange={(event) => setOpenRole(event.target.value as 'editor' | 'viewer')}
          >
            <option value="editor">{t('Join as editor')}</option>
            <option value="viewer">{t('Join as viewer')}</option>
          </NativeSelect>
        )}
        <Button onClick={() => void handleCreate()}>
          <Plus className="h-4 w-4" />
          {t('New invite')}
        </Button>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {invites.length === 0 ? (
        <Alert variant="muted">{t('No open invites. Create one, then send the link or show the QR code.')}</Alert>
      ) : (
        <div className="space-y-4">
          {invites.map((invite) => {
            const uri = appInviteUri(invite.lobbyId, invite.lobbyPassword);
            const usesLeft = Number(invite.usesLeft ?? 1);
            const multiUse = usesLeft > 900000;
            const oneStep = invite.autoApprove === 'true';
            return (
              <div key={invite.id} className="space-y-3 rounded-xl border border-border p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">
                      {multiUse ? t('Multi-use') : usesLeft === 1 ? t('1 use left') : `${usesLeft} ${t('uses left')}`}
                    </Badge>
                    {oneStep && <Badge>{t('1-step')}</Badge>}
                  </div>
                  <Button variant="ghost" size="icon-sm" aria-label={t('Delete invite')} onClick={() => void handleDelete(invite.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                {oneStep && (
                  <Alert variant="warning">
                    {invite.autoRole === 'viewer'
                      ? t('Anyone who opens this link joins as a viewer without your confirmation — one of your devices just needs to be online. Share it only where you would share the data itself.')
                      : t('Anyone who opens this link joins as an editor without your confirmation — one of your devices just needs to be online. Share it only where you would share the data itself.')}
                  </Alert>
                )}
                {oneStep && admissions.some((row) => row.inviteId === invite.id) && (
                  <div className="space-y-1.5">
                    <p className="text-sm font-medium">{t('Admitted automatically by this device')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('Each person who joined sees a code on their screen. It must match the code here — a different one means someone else holding the link let them in.')}
                    </p>
                    <ul className="divide-y divide-border rounded-lg border border-border text-sm">
                      {admissions.filter((row) => row.inviteId === invite.id).map((row) => (
                        <li key={row.publicKey} className="flex items-center justify-between gap-3 px-3 py-2">
                          <span className="min-w-0 truncate">{row.displayName || t('Unknown device')}</span>
                          <span className="font-mono tabular-nums">{formatConnectionCode(row.code)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <InviteLinkPanel uri={uri} shareTitle={`${t('Join')} ${appName}`} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
