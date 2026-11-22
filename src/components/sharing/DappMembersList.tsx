import type { MemberRole } from '@/types.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { PersonAvatar } from '@/components/PersonAvatar.tsx';
import { useDappConfig, useDappMembers } from '@/hooks/useYjs.ts';
import { getIdentity } from '@/services/identity.ts';
import { removeMember, setMember } from '@/services/store/index.ts';
import { FOUNDER_PLACEHOLDER_NAME } from '@/services/store/protocolCore.ts';
import { AUTO_ROTATE_ON_MEMBER_REMOVAL } from '@/services/store/rotationPolicy.ts';
import { showAlert, showConfirm } from '@/services/dialogs.ts';
import { useI18n } from '@/i18n';

/** The devices that have full access to a dapp, with role changes and removal (owner-only surface). */
export default function DappMembersList({ dappId }: { dappId: string }) {
  const { t } = useI18n();
  const config = useDappConfig(dappId);
  const members = useDappMembers(dappId);
  const myPublicKey = getIdentity()?.publicKey;
  const founderKey = config?.meta.createdBy;

  const memberName = (publicKey: string) => members.find((member) => member.publicKey === publicKey)?.name || `${publicKey.substring(0, 8)}…`;
  // Older founder entries carry the placeholder name "Owner" until the founder's own device
  // opens the dapp and signs its real name in — show which device that is in the meantime.
  const memberLabel = (publicKey: string) => {
    const name = memberName(publicKey);
    return publicKey === founderKey && name === FOUNDER_PLACEHOLDER_NAME ? `${t('Unnamed device')} ${publicKey.substring(0, 8)}…` : name;
  };

  const handleRemove = async (publicKey: string) => {
    const consequence = AUTO_ROTATE_ON_MEMBER_REMOVAL
      ? t('The room keys will be rotated so they lose access to all data.')
      : t('They can no longer change anything or receive new data: every other device refuses their connection as soon as the removal has synced. Data already on their device stays there.');
    const confirmed = await showConfirm(
      `${t('Remove this member from the app?')} “${memberLabel(publicKey)}”. ${consequence}`,
      { title: t('Remove member'), confirmLabel: t('Remove'), danger: true },
    );
    if (!confirmed) return;
    let rotation: Awaited<ReturnType<typeof removeMember>>;
    try {
      rotation = await removeMember(dappId, publicKey);
    } catch (error) {
      void showAlert(error instanceof Error ? error.message : String(error), { title: t('Could not remove member'), danger: true });
      return;
    }
    if (!AUTO_ROTATE_ON_MEMBER_REMOVAL) return;
    if (!rotation) {
      void showAlert(t('Member removed, but the room keys could not be rotated — the removed member may still be able to read existing data.'), { title: t('Rotation failed'), danger: true });
    } else if (rotation.skipped.length > 0) {
      void showAlert(`${t('Room keys rotated. These members joined before key rotation existed and must be re-invited:')} ${rotation.skipped.map(memberName).join(', ')}`, { title: t('Re-invites needed') });
    }
  };

  const handleRoleChange = async (publicKey: string, role: string) => {
    const member = members.find((entry) => entry.publicKey === publicKey);
    if (!member) return;
    try {
      await setMember(dappId, { publicKey, role: role as MemberRole, name: member.name || 'Unknown' });
    } catch (error) {
      void showAlert(error instanceof Error ? error.message : String(error), { title: t('Could not change role'), danger: true });
    }
  };

  if (members.length === 0) return <p className="text-sm text-muted-foreground">{t('No members synced yet.')}</p>;

  return (
    <div className="flex flex-col divide-y divide-border/70">
      {members.map((member) => {
        const isSelf = member.publicKey === myPublicKey;
        // The device that created the dapp anchors every membership check and can never be removed.
        const isFounder = member.publicKey === founderKey;
        const label = memberLabel(member.publicKey);
        return (
          <div key={member.publicKey} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
            <PersonAvatar name={member.name || '?'} seed={member.publicKey} size="lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate font-medium">{label}</span>
                {isSelf && <Badge variant="default">{t('You')}</Badge>}
                {isFounder && <Badge variant="default" title={t('Created this app. The founder cannot be removed.')}>{t('Founder')}</Badge>}
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>{t('Role')}:</span>
                {!isSelf ? (
                  <NativeSelect
                    compact
                    value={member.role}
                    aria-label={`${t('Role')}: ${label}`}
                    onChange={(event) => void handleRoleChange(member.publicKey, event.target.value)}
                  >
                    <option value="owner">{t('Owner')}</option>
                    <option value="editor">{t('Editor')}</option>
                    <option value="viewer">{t('Viewer')}</option>
                  </NativeSelect>
                ) : (
                  <span>{member.role}</span>
                )}
              </div>
            </div>
            {!isSelf && !isFounder && (
              <Button variant="destructive" size="sm" aria-label={`${t('Remove')} ${label}`} onClick={() => void handleRemove(member.publicKey)}>
                {t('Remove')}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
