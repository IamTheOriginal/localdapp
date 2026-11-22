import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchGithubSource, githubLocationUrl, type GithubSourceSnapshot } from '../services/githubSource.ts';
import { createGithubDapp, getGithubOrigin, githubSnapshotIdentity } from '../services/store/githubOrigin.ts';
import { recordGithubInstall } from '../services/githubUpdateState.ts';
import { parseCodeAppManifest } from '../services/codeAppManifest.ts';
import { grantedHostPermissionLabels } from './code-app/hostPermissionLabels.ts';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface GithubImportPanelProps {
  /** Called with the new dapp id after the sources were installed. */
  onCreated?: (dappId: string) => void;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^github: /, '');
}

/**
 * Two explicit steps: load a public GitHub folder (nothing is installed yet,
 * the sources are only downloaded and verified), review what it contains,
 * then create the dapp. Lives inside the New Dapp dialog's form, so it uses
 * plain buttons and swallows Enter instead of nesting a second form.
 */
export default function GithubImportPanel({ onCreated }: GithubImportPanelProps) {
  const navigate = useNavigate();
  const busyRef = useRef(false);
  const [link, setLink] = useState('');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'creating'>('idle');
  const [snapshot, setSnapshot] = useState<GithubSourceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (nextPhase: 'loading' | 'creating', task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPhase(nextPhase);
    setError(null);
    try {
      await task();
    } catch (taskError) {
      setError(errorText(taskError));
    } finally {
      busyRef.current = false;
      setPhase('idle');
    }
  };

  const load = () => run('loading', async () => {
    setSnapshot(null);
    setSnapshot(await fetchGithubSource(link));
  });

  const create = () => run('creating', async () => {
    if (!snapshot) return;
    const id = await createGithubDapp(snapshot);
    // Just installed = just checked: spares the background check a GitHub call.
    const origin = getGithubOrigin(id);
    if (origin) recordGithubInstall(id, origin);
    void navigate(`/dapp/${id}/app`);
    onCreated?.(id);
  });

  const identity = snapshot ? githubSnapshotIdentity(snapshot) : null;
  const manifest = snapshot ? parseCodeAppManifest(snapshot.files['manifest.yaml']).manifest : null;
  const hostPermissions = manifest ? grantedHostPermissionLabels(manifest) : [];
  const networkOrigins = manifest ? [...(manifest.permissions?.network?.connect ?? []), ...(manifest.permissions?.network?.images ?? [])] : [];

  return (
    <section aria-label="Add from GitHub" className="grid gap-3">
      <div className="grid gap-2">
        <Label htmlFor="github-link">Public GitHub link</Label>
        <div className="flex flex-col gap-2 @md:flex-row">
          <Input
            id="github-link"
            name="githubLink"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://github.com/owner/repo/tree/main/app"
            value={link}
            onChange={(event) => { setLink(event.target.value); setSnapshot(null); }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault(); // never submit the surrounding "create blank dapp" form
              if (link.trim()) void load();
            }}
          />
          <Button type="button" variant="secondary" disabled={!link.trim() || phase !== 'idle'} onClick={() => { void load(); }}>
            {phase === 'loading' ? 'Loading…' : 'Load'}
          </Button>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          The repository or folder must contain <code>index.html</code> and <code>manifest.yaml</code>. Text sources are copied into a new dapp that you own; images and other binary files are skipped.
        </p>
      </div>

      {error ? <Alert variant="destructive" role="alert">{error}</Alert> : null}

      {snapshot && identity ? (
        <div className="grid gap-3 rounded-xl border border-border/80 bg-card p-4 shadow-sm">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl" style={{ backgroundColor: `${identity.color}20` }} aria-hidden="true">{identity.icon}</span>
            <div className="w-0 min-w-0 flex-1">
              <h3 className="truncate text-sm font-semibold">{identity.name}</h3>
              <a className="block truncate text-xs text-muted-foreground underline-offset-2 hover:underline" href={githubLocationUrl(snapshot.location, snapshot.commitSha)} target="_blank" rel="noreferrer noopener">
                {snapshot.location.owner}/{snapshot.location.repo}{snapshot.location.path ? `/${snapshot.location.path}` : ''} @ {snapshot.commitSha.slice(0, 7)}
              </a>
            </div>
          </div>
          <dl className="grid min-w-0 gap-2 text-sm [overflow-wrap:anywhere] sm:grid-cols-[8rem_minmax(0,1fr)]">
            <dt className="font-medium text-muted-foreground">Files</dt>
            <dd>{Object.keys(snapshot.files).sort().join(', ')}</dd>
            {snapshot.skipped.length > 0 && (
              <>
                <dt className="font-medium text-muted-foreground">Not copied</dt>
                <dd className="text-muted-foreground">{snapshot.skipped.slice(0, 8).join(', ')}{snapshot.skipped.length > 8 ? ` and ${snapshot.skipped.length - 8} more` : ''}</dd>
              </>
            )}
            <dt className="font-medium text-muted-foreground">Host permissions</dt>
            <dd className="flex flex-wrap gap-1">{hostPermissions.length ? hostPermissions.map((label) => <Badge key={label} variant="secondary">{label}</Badge>) : 'None'}</dd>
            <dt className="font-medium text-muted-foreground">Network origins</dt>
            <dd>{networkOrigins.length ? networkOrigins.join(', ') : 'None'}</dd>
          </dl>
          <p className="text-xs leading-5 text-muted-foreground">
            Later changes on GitHub are never installed automatically. Owners see a red dot on Dapp settings and decide there whether to update.
          </p>
          <Button type="button" disabled={phase !== 'idle'} onClick={() => { void create(); }}>
            {phase === 'creating' ? 'Creating…' : `Create ${identity.name}`}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
