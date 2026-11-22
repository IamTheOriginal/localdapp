import { showAlert, showConfirm } from './dialogs.ts';
import { leaveDapp, resolveDappLeaveKind } from './dappLeaveRuntime.ts';

type Translate = (key: string) => string;

/**
 * Confirm-then-leave flow shared by every surface that offers "Leave dapp".
 * Resolves `true` only when this device actually left; the user cancelling
 * or a failure (already reported through an alert) resolves `false`.
 */
export async function confirmAndLeaveDapp(dappId: string, t: Translate): Promise<boolean> {
  // Before the first sync there is no local copy to keep and nobody to notify — say so.
  const unsynced = await resolveDappLeaveKind(dappId).then((kind) => kind === 'unsynced', () => false);
  const confirmed = await showConfirm(
    unsynced
      ? t('Stop waiting for this app? Nothing has synced to this device yet, so the app is removed from it completely. If an owner already approved this device, they keep listing it until they remove it. You can join again with a fresh invite.')
      : t('Leave this app? Your device keeps a read-only local copy and stops syncing. Other members are notified so they can close the shared room. You can rejoin later with a fresh invite.'),
    { title: t('Leave app'), confirmLabel: t('Leave') },
  );
  if (!confirmed) return false;

  try {
    const kind = await leaveDapp(dappId);
    void showAlert(
      kind === 'unsynced'
        ? t('The app was removed from this device. Join again anytime with a new invite.')
        : t('You left the app. A local copy stays on this device — rejoin anytime with a new invite.'),
      { title: kind === 'unsynced' ? t('App removed') : t('App left') },
    );
    return true;
  } catch (error) {
    void showAlert(
      `${t('Leaving failed')}: ${error instanceof Error ? error.message : String(error)}`,
      { title: t('Leaving failed'), danger: true },
    );
    return false;
  }
}
