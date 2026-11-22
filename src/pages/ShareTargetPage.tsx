import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Inbox, Paperclip, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { useDappsList } from '@/hooks/useYjs.ts';
import { useI18n } from '@/i18n/index.tsx';
import { formatBytes } from '@/lib/format.ts';
import { parseCodeAppManifest } from '@/services/codeAppManifest.ts';
import { ingestLocalFile } from '@/services/fileIngest.ts';
import {
  clearStagedShare, loadStagedShareFiles, manifestAcceptsShare, normalizeWebShare, stagedShareRef,
} from '@/services/webShare.ts';
import { appendIncomingShare, getCodeAppFile, getDappSourceDoc } from '@/services/store/index.ts';
import type { CodeAppManifest, DappListItem } from '@/types.ts';

/**
 * Landing page for OS-level Web Share Target launches (declared in
 * manifest.webmanifest; the service worker turns the POST into
 * /share-target?title&text&url&share&files). Shows a picker of dapps whose
 * Code App manifest opts in via `shareTarget.accepts`; picking one stores any
 * shared files in that dapp's file store and drops the share into its `$data`
 * inbox (`incoming-shares`), then opens the app. Delivery is an ordinary
 * editor-gated write from this device — nothing is broadcast, nothing installs.
 */

/** Live map of dappId → parsed Code App manifest for the given candidates. */
function useCodeAppManifests(dappIds: string[]): Record<string, CodeAppManifest> {
  const [manifests, setManifests] = useState<Record<string, CodeAppManifest>>({});

  useEffect(() => {
    const refresh = () => {
      const next: Record<string, CodeAppManifest> = {};
      for (const id of dappIds) {
        next[id] = parseCodeAppManifest(getCodeAppFile(id, 'manifest.yaml')).manifest;
      }
      setManifests(next);
    };
    refresh();
    // Source docs load from IndexedDB (and peers) after mount — re-evaluate
    // eligibility as each dapp's manifest.yaml materializes.
    const cleanups = dappIds.map((id) => {
      const files = getDappSourceDoc(id).getMap('files');
      files.observeDeep(refresh);
      return () => files.unobserveDeep(refresh);
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [dappIds]);

  return manifests;
}

/** Files the service worker staged for this launch (empty for text/url shares); null while loading. */
function useStagedFiles(params: URLSearchParams): File[] | null {
  const ref = useMemo(() => stagedShareRef(params), [params]);
  const [loaded, setLoaded] = useState<{ id: string; files: File[] } | null>(null);

  useEffect(() => {
    if (!ref) return;
    let cancelled = false;
    loadStagedShareFiles(ref)
      .then((files) => { if (!cancelled) setLoaded({ id: ref.id, files }); })
      .catch(() => { if (!cancelled) setLoaded({ id: ref.id, files: [] }); });
    return () => { cancelled = true; };
  }, [ref]);

  if (!ref) return [];
  return loaded?.id === ref.id ? loaded.files : null;
}

export default function ShareTargetPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const dapps = useDappsList();
  const [busyDappId, setBusyDappId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const staged = useStagedFiles(params);
  const loading = staged === null;
  const share = useMemo(() => (staged ? normalizeWebShare(params, staged) : null), [params, staged]);

  // Viewers cannot receive: delivery is a $data (and file) write, which needs editor.
  const candidates = useMemo(
    () => dapps.filter((dapp) => !dapp.archivedAt && dapp.role !== 'viewer'),
    [dapps],
  );
  const candidateIds = useMemo(() => candidates.map((dapp) => dapp.id), [candidates]);
  const manifests = useCodeAppManifests(candidateIds);
  const eligible = useMemo(
    () => (share ? candidates.filter((dapp) => manifests[dapp.id] && manifestAcceptsShare(manifests[dapp.id], share)) : []),
    [candidates, manifests, share],
  );

  const deliver = async (dapp: DappListItem) => {
    if (!share) return;
    setBusyDappId(dapp.id);
    setError('');
    try {
      const files = [];
      for (const file of share.files ?? []) {
        const record = await ingestLocalFile(dapp.id, file, { name: file.name, mime: file.type });
        files.push({ fileId: record.id, name: record.name, mime: record.mime, size: record.size });
      }
      appendIncomingShare(dapp.id, { title: share.title, text: share.text, url: share.url, files });
      const ref = stagedShareRef(params);
      if (ref) await clearStagedShare(ref).catch(() => undefined);
      void navigate(`/dapp/${dapp.id}/app`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Could not deliver the share.'));
      setBusyDappId(null);
    }
  };

  const summary = share
    ? [share.title, share.url ?? share.text].filter(Boolean).join(' — ')
    : '';

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-lg items-center px-4 py-8">
      <Card className="w-full">
        {loading && (
          <CardHeader>
            <CardTitle>{t('Loading…')}</CardTitle>
          </CardHeader>
        )}

        {!loading && !share && (
          <>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Inbox className="h-5 w-5 text-muted-foreground" aria-hidden="true" />{t('Nothing to share')}</CardTitle>
              <CardDescription>{t('This page receives content shared from other apps. Share a link, text, or files to Dapp Builder to use it.')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" render={<Link to="/" />}>{t('Back to home')}</Button>
            </CardContent>
          </>
        )}

        {share && (
          <>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Share2 className="h-5 w-5 text-primary" aria-hidden="true" />{t('Share with a dapp')}</CardTitle>
              {summary && (
                <CardDescription className="break-words [overflow-wrap:anywhere]">{summary}</CardDescription>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              {share.files && share.files.length > 0 && (
                <ul className="space-y-1 text-sm" aria-label={t('Shared files')}>
                  {share.files.map((file, index) => (
                    <li key={`${file.name}-${index}`} className="flex items-center gap-2 text-muted-foreground">
                      <Paperclip className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="truncate text-foreground">{file.name}</span>
                      <span className="ml-auto shrink-0 text-xs">{formatBytes(file.size)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              {eligible.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {share.files && share.files.length > 0
                    ? t('None of your dapps accept shared files yet. A dapp opts in by declaring shareTarget with files in its manifest and requesting the files permission.')
                    : t('None of your dapps accept shared content yet. A dapp opts in by declaring shareTarget in its manifest.')}
                </p>
              )}
              {eligible.length > 0 && (
                <ul className="space-y-2">
                  {eligible.map((dapp) => (
                    <li key={dapp.id}>
                      <Button
                        variant="outline"
                        className="w-full justify-start gap-3"
                        disabled={busyDappId !== null}
                        onClick={() => { void deliver(dapp); }}
                      >
                        <span aria-hidden="true">{dapp.icon}</span>
                        <span className="truncate">{dapp.name}</span>
                        {busyDappId === dapp.id && <span className="ml-auto text-xs text-muted-foreground">{t('Delivering…')}</span>}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <Button variant="outline" render={<Link to="/" />}>{t('Not now')}</Button>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
