import { showAlert, showConfirm } from './dialogs.ts';
import { deleteDapp } from './dappDeletionRuntime.ts';

type Translate = (key: string) => string;

/**
 * Confirm-then-delete flow shared by every surface that offers "Delete dapp".
 * Resolves `true` only when the dapp was actually deleted; the user cancelling
 * or a failure (already reported through an alert) resolves `false`.
 */
export async function confirmAndDeleteDapp(dappId: string, t: Translate): Promise<boolean> {
  const confirmed = await showConfirm(
    t('Delete this Dapp and permanently erase all local data, source files, sharing rooms, and keys? Remote peers will receive signed deletion requests. This cannot be undone.'),
    { title: t('Delete dapp'), confirmLabel: t('Delete everything'), danger: true },
  );
  if (!confirmed) return false;

  try {
    const result = await deleteDapp(dappId);
    const remoteStatus = result.remotePurgeRequestFailures.length === 0
      ? `${result.remotePurgeRequests} ${t('remote deletion request(s) queued until acknowledged.')}`
      : `${result.remotePurgeRequests} ${t('remote request(s) queued;')} ${result.remotePurgeRequestFailures.length} ${t('could not be prepared.')}`;
    void showAlert(`${t('Dapp data and keys were deleted from this device.')} ${remoteStatus}`, { title: t('Dapp deleted') });
    return true;
  } catch (error) {
    void showAlert(
      `${t('Dapp deletion failed')}: ${error instanceof Error ? error.message : String(error)}`,
      { title: t('Deletion failed'), danger: true },
    );
    return false;
  }
}
