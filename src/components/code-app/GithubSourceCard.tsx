import { useRef, useState } from 'react';
import { GitBranch } from 'lucide-react';
import {
  downloadGithubSnapshot, fetchGithubTree, githubCompareUrl, githubLocationUrl, resolveGithubLocation, type GithubSourceSnapshot,
} from '@/services/githubSource.ts';
import {
  applyGithubUpdate, diffGithubSnapshot, disconnectGithubOrigin, getGithubOrigin, type GithubOrigin, type GithubUpdateDiff,
} from '@/services/store/githubOrigin.ts';
import {
  checkGithubUpdate, clearGithubUpdateCheck, githubSourceLabel, githubSourceMismatch, pinGithubSource, recordGithubInstall,
} from '@/services/githubUpdateState.ts';
import { parseCodeAppManifest } from '@/services/codeAppManifest.ts';
import { showAlert, showConfirm } from '@/services/dialogs.ts';
import { useGithubUpdate } from '@/hooks/useGithubUpdate.ts';
import { grantedHostPermissionLabels } from './hostPermissionLabels.ts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface Review {
  origin: GithubOrigin;
  snapshot: GithubSourceSnapshot;
  diff: GithubUpdateDiff;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^github: /, '');
}

function FileList({ label, paths }: { label: string; paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <>
      <dt className="font-medium text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xs leading-5">{paths.join(', ')}</dd>
    </>
  );
}

/**
 * Owner-only settings card of a GitHub-linked dapp (DappSettingsPage already
 * gates on the owner role; the hook stays empty for everyone else). Updating
 * is always two deliberate steps: "Review update" downloads and verifies the
 * new revision without touching the dapp, the dialog shows what would change,
 * and only "Update dapp" replaces the sources.
 */
export default function GithubSourceCard({ dappId }: { dappId: string }) {
  const { origin, check, updateAvailable } = useGithubUpdate(dappId);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState<'check' | 'review' | 'apply' | null>(null);
  const [review, setReview] = useState<Review | null>(null);

  if (!origin) return null;
  // Re-read on every render: the hook re-renders this card whenever the pin or a check changes.
  const pinnedElsewhere = githubSourceMismatch(dappId, origin);

  const run = async (kind: 'check' | 'review' | 'apply', title: string, task: () => Promise<void> | void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(kind);
    try {
      await task();
    } catch (error) {
      void showAlert(errorText(error), { title });
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const handleCheck = () => run('check', 'Update check failed', async () => {
    await checkGithubUpdate(dappId, { force: true });
  });

  const handleReview = () => run('review', 'Could not load the update', async () => {
    // Always review the newest revision, even if it moved again since the last check.
    const resolved = await resolveGithubLocation([origin]);
    const snapshot = await downloadGithubSnapshot(origin, await fetchGithubTree(origin, resolved));
    setReview({ origin, snapshot, diff: diffGithubSnapshot(dappId, snapshot) });
  });

  const handleAcceptSource = async () => {
    const confirmed = await showConfirm(
      `Take updates from ${githubSourceLabel(origin)} from now on?\n\nOnly accept this if you (or another owner you trust) moved the dapp to that repository. Updates install its code for every member.`,
      { title: 'Accept the new repository', confirmLabel: 'Accept repository', danger: true },
    );
    if (confirmed) pinGithubSource(dappId, origin);
  };

  const handleApply = () => run('apply', 'Update failed', () => {
    if (!review) return;
    if (githubSourceMismatch(dappId, origin)) throw new Error('github: The linked repository changed — accept it first');
    applyGithubUpdate(dappId, review.snapshot);
    const installed = getGithubOrigin(dappId);
    if (installed) recordGithubInstall(dappId, installed);
    setReview(null);
  });

  const handleDisconnect = async () => {
    const confirmed = await showConfirm(
      'Stop tracking this GitHub repository? The installed source files stay as they are; the dapp will no longer be offered updates.',
      { title: 'Disconnect from GitHub', confirmLabel: 'Disconnect', danger: true },
    );
    if (!confirmed) return;
    try {
      disconnectGithubOrigin(dappId);
      clearGithubUpdateCheck(dappId);
    } catch (error) {
      void showAlert(errorText(error), { title: 'Disconnect failed' });
    }
  };

  const nextManifest = review ? parseCodeAppManifest(review.snapshot.files['manifest.yaml']).manifest : null;
  const nextHostPermissions = nextManifest ? grantedHostPermissionLabels(nextManifest) : [];
  const nextNetworkOrigins = nextManifest ? [...(nextManifest.permissions?.network?.connect ?? []), ...(nextManifest.permissions?.network?.images ?? [])] : [];
  const nothingToApply = review ? review.diff.added.length + review.diff.changed.length + review.diff.removed.length === 0 : false;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="inline-flex items-center gap-2"><GitBranch className="h-4 w-4 text-muted-foreground" aria-hidden="true" />GitHub source</span>
          {updateAvailable && (
            <Badge variant="destructive" className="gap-1.5">
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-current" />
              Update available
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          This dapp&apos;s source files were copied from a public GitHub repository. Changes there are never installed automatically — not by members and not by keeper nodes. Only an owner can review and apply an update here.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid min-w-0 gap-2 text-sm [overflow-wrap:anywhere] sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="font-medium text-muted-foreground">Repository</dt>
          <dd>
            <a className="underline-offset-2 hover:underline" href={githubLocationUrl(origin)} target="_blank" rel="noreferrer noopener">
              {origin.owner}/{origin.repo}{origin.path ? `/${origin.path}` : ''}
            </a>
            {' '}<span className="text-muted-foreground">({origin.ref || 'default branch'})</span>
          </dd>
          <dt className="font-medium text-muted-foreground">Installed revision</dt>
          <dd>
            <a className="font-mono text-xs underline-offset-2 hover:underline" href={githubLocationUrl(origin, origin.commitSha)} target="_blank" rel="noreferrer noopener">{origin.commitSha.slice(0, 7)}</a>
            {origin.installedAt ? <span className="text-muted-foreground"> · {new Date(origin.installedAt).toLocaleString()}</span> : null}
          </dd>
          <dt className="font-medium text-muted-foreground">Last checked</dt>
          <dd>{check ? new Date(check.checkedAt).toLocaleString() : 'Not yet on this device'}</dd>
        </dl>
        {pinnedElsewhere && (
          <div role="alert" className="flex flex-col gap-2 rounded-xl border border-destructive/50 bg-destructive/10 p-4 text-sm">
            <p className="font-medium">The linked repository was changed.</p>
            <p className="[overflow-wrap:anywhere]">
              This device took updates from <span className="font-mono text-xs">{pinnedElsewhere}</span>. The dapp now points to{' '}
              <span className="font-mono text-xs">{githubSourceLabel(origin)}</span> — any member can write that link. Update checks are paused until an owner accepts the new location on this device.
            </p>
            <div>
              <Button variant="destructive" size="sm" onClick={() => { void handleAcceptSource(); }}>Accept the new repository…</Button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {updateAvailable && !pinnedElsewhere && (
            <Button disabled={busy !== null} onClick={() => { void handleReview(); }}>
              {busy === 'review' ? 'Loading update…' : 'Review update'}
            </Button>
          )}
          <Button variant="secondary" disabled={busy !== null || pinnedElsewhere !== null} onClick={() => { void handleCheck(); }}>
            {busy === 'check' ? 'Checking…' : 'Check now'}
          </Button>
          <Button variant="outline" disabled={busy !== null} onClick={() => { void handleDisconnect(); }}>
            Disconnect from GitHub
          </Button>
        </div>

      </CardContent>

      {review && (
        <Dialog open onOpenChange={(open) => { if (!open && busy !== 'apply') setReview(null); }}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Update from GitHub?</DialogTitle>
              <DialogDescription>
                The new revision was downloaded and verified against the repository, but nothing is installed yet. Review the changes, then decide.
              </DialogDescription>
            </DialogHeader>

            <dl className="grid min-w-0 gap-3 rounded-xl border border-border p-4 text-sm [overflow-wrap:anywhere] sm:grid-cols-[9rem_minmax(0,1fr)]">
              <dt className="font-medium text-muted-foreground">Installs from</dt>
              <dd className="font-mono text-xs">{githubSourceLabel(review.snapshot.location)}</dd>
              <dt className="font-medium text-muted-foreground">Revision</dt>
              <dd>
                <span className="font-mono text-xs">{review.origin.commitSha.slice(0, 7)} → {review.snapshot.commitSha.slice(0, 7)}</span>
                {' · '}
                <a className="underline-offset-2 hover:underline" href={githubCompareUrl(review.origin, review.origin.commitSha, review.snapshot.commitSha)} target="_blank" rel="noreferrer noopener">
                  View changes on GitHub
                </a>
              </dd>
              <FileList label="Changed files" paths={review.diff.changed} />
              <FileList label="New files" paths={review.diff.added} />
              <FileList label="Removed files" paths={review.diff.removed} />
              {nothingToApply && (
                <>
                  <dt className="font-medium text-muted-foreground">Files</dt>
                  <dd>The installed files already match this revision.</dd>
                </>
              )}
              <dt className="font-medium text-muted-foreground">Host permissions</dt>
              <dd className="flex flex-wrap gap-1">
                {nextHostPermissions.length ? nextHostPermissions.map((label) => <Badge key={label} variant="secondary">{label}</Badge>) : 'None'}
              </dd>
              <dt className="font-medium text-muted-foreground">Network origins</dt>
              <dd>{nextNetworkOrigins.length ? nextNetworkOrigins.join(', ') : 'None'}</dd>
            </dl>

            <p className="text-sm text-muted-foreground">
              Updating replaces all source files with the GitHub version for every member — edits made in the code editor are overwritten. Records, members and files stay untouched.
            </p>

            <DialogFooter>
              <Button variant="outline" disabled={busy === 'apply'} onClick={() => setReview(null)}>Not now</Button>
              <Button disabled={busy !== null} onClick={() => { void handleApply(); }}>
                {busy === 'apply' ? 'Updating…' : 'Update dapp'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}
