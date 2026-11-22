import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';

interface Props {
  children?: ReactNode;
  /** A change of this value (the route) clears a caught error, so navigating away recovers the page. */
  resetKey?: string;
}

interface State {
  error: Error | null;
  caughtAtKey: string | undefined;
}

const RELOADED_FOR_UPDATE_KEY = 'dapp-builder-reloaded-for-update';

/**
 * After a deploy the running tab still points at the previous build's lazily
 * loaded files, which are gone: opening a page then fails with the browser's
 * raw "Failed to fetch dynamically imported module". That is an update, not a bug.
 */
export function isStaleBuildError(error: Error): boolean {
  return /dynamically imported module|Importing a module script failed|Loading chunk|error loading dynamically imported/i.test(error.message);
}

/** Called once the app has been running for a while: the NEXT update may reload by itself again. */
export function forgetStaleBuildReload(): void {
  try {
    sessionStorage.removeItem(RELOADED_FOR_UPDATE_KEY);
  } catch {
    // no session storage
  }
}

function ErrorPanel({ error }: { error: Error }) {
  const { t } = useI18n();
  const stale = isStaleBuildError(error);
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div role="alert" className="max-w-sm rounded-2xl border border-border bg-card p-8 text-center">
        <h2 className={`mb-4 text-lg font-semibold ${stale ? 'text-foreground' : 'text-destructive'}`}>
          {stale ? t('A new version is available') : t('Something went wrong.')}
        </h2>
        <p className="mb-8 text-sm text-muted-foreground">
          {stale
            ? t('The app was updated while this tab was open. Reload to continue — your data is stored on this device and stays as it is.')
            : error.message || t('An unexpected error occurred.')}
        </p>
        <Button onClick={() => { window.location.reload(); }}>{t('Reload')}</Button>
      </div>
    </div>
  );
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = { error: null, caughtAtKey: undefined };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  public static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (state.error && state.caughtAtKey !== undefined && (props.resetKey ?? '') !== state.caughtAtKey) {
      return { error: null, caughtAtKey: undefined };
    }
    if (state.error && state.caughtAtKey === undefined) return { caughtAtKey: props.resetKey ?? '' };
    return null;
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
    if (!isStaleBuildError(error)) return;
    // Reload once by itself; the flag keeps a build that is really broken from looping.
    try {
      if (sessionStorage.getItem(RELOADED_FOR_UPDATE_KEY)) return;
      sessionStorage.setItem(RELOADED_FOR_UPDATE_KEY, String(Date.now()));
    } catch {
      return; // no session storage: leave it to the button
    }
    window.location.reload();
  }

  public render() {
    if (!this.state.error) return this.props.children;
    return <ErrorPanel error={this.state.error} />;
  }
}

export default ErrorBoundary;
