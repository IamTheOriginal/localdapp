/**
 * In-page replacement for window.alert/confirm. Native dialogs let the
 * browser offer "block additional dialogs for this site", which can silently
 * break destructive-action confirmation — and they look terrible. The
 * SystemDialogs host (mounted once in App) renders these as normal HTML
 * dialogs; if no host is mounted (isolated tests), we fall back to the native
 * functions so flows still behave.
 */

export interface DialogRequest {
  kind: 'alert' | 'confirm';
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  resolve: (confirmed: boolean) => void;
}

type DialogHost = (request: DialogRequest) => void;

let host: DialogHost | null = null;

export function registerDialogHost(nextHost: DialogHost): () => void {
  host = nextHost;
  return () => {
    if (host === nextHost) host = null;
  };
}

interface DialogOptions {
  title?: string;
  confirmLabel?: string;
  danger?: boolean;
}

export function showAlert(message: string, options: DialogOptions = {}): Promise<void> {
  if (!host) {
    window.alert(message);
    return Promise.resolve();
  }
  const active = host;
  return new Promise((resolve) => {
    active({
      kind: 'alert',
      title: options.title ?? 'Notice',
      message,
      confirmLabel: options.confirmLabel ?? 'OK',
      danger: options.danger ?? false,
      resolve: () => resolve(),
    });
  });
}

export function showConfirm(message: string, options: DialogOptions = {}): Promise<boolean> {
  if (!host) return Promise.resolve(window.confirm(message));
  const active = host;
  return new Promise((resolve) => {
    active({
      kind: 'confirm',
      title: options.title ?? 'Are you sure?',
      message,
      confirmLabel: options.confirmLabel ?? 'Continue',
      danger: options.danger ?? false,
      resolve,
    });
  });
}
