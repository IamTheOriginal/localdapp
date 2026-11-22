import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Link2, TriangleAlert } from 'lucide-react';
import type { CodeAppDefinitionBundle } from '@/types.ts';
import { sourceShareCodeFromLocation } from '@/services/inviteLinks.ts';
import { receiveSourceShare } from '@/services/sourceShare.ts';
import { importDefinitionBundle, replaceDefinitionBundle } from '@/services/store/index.ts';
import { showConfirm } from '@/services/dialogs.ts';
import { useDappsList } from '@/hooks/useYjs.ts';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import DefinitionInstallDialog from '@/components/code-app/DefinitionInstallDialog.tsx';
import { useI18n } from '@/i18n';
import { clearGithubUpdateCheck } from '@/services/githubUpdateState.ts';

/** Receives exactly one signed source-only definition; it never joins the sender's dapp. */
export default function SourceImportPage() {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const dapps = useDappsList();
  const uri = sourceShareCodeFromLocation(location);
  const [bundle, setBundle] = useState<CodeAppDefinitionBundle | null>(null);
  const [error, setError] = useState(() => uri ? '' : t('This source-share link is invalid.'));
  const [loading, setLoading] = useState(() => Boolean(uri));
  const [installing, setInstalling] = useState(false);
  const replaceTargets = useMemo(() => dapps
    .filter((dapp) => dapp.role === 'owner' && !dapp.archivedAt)
    .map(({ id, name, icon }) => ({ id, name, icon })), [dapps]);

  useEffect(() => {
    if (window.location.hash || window.location.search) window.history.replaceState(window.history.state, '', window.location.pathname);
    if (!uri) return;
    const received = receiveSourceShare(uri);
    let active = true;
    void received.bundle.then((definition) => {
      if (!active) return;
      setBundle(definition);
      setLoading(false);
    }).catch((caught: unknown) => {
      if (!active) return;
      setError(caught instanceof Error ? caught.message : t('Could not receive this app source.'));
      setLoading(false);
    });
    return () => { active = false; received.close(); };
  }, [t, uri]);

  const install = async () => {
    if (!bundle || installing) return;
    setInstalling(true);
    try { void navigate(`/dapp/${await importDefinitionBundle(bundle)}`); }
    catch (caught) { setError(caught instanceof Error ? caught.message : t('Could not install the source.')); }
    finally { setInstalling(false); }
  };
  const replace = async (dappId: string) => {
    if (!bundle || installing) return;
    const target = replaceTargets.find((item) => item.id === dappId);
    const confirmed = await showConfirm(
      t('Replace the source and manifest of {name}? Its records, members, credentials, and files stay, but its current code is replaced.')
        .replace('{name}', target?.name ?? t('this dapp')),
      { title: t('Replace dapp source'), confirmLabel: t('Replace source'), danger: true },
    );
    if (!confirmed) return;
    setInstalling(true);
    try {
      await replaceDefinitionBundle(dappId, bundle);
      clearGithubUpdateCheck(dappId);
      void navigate(`/dapp/${dappId}/app`);
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : t('Could not replace the source.')); }
    finally { setInstalling(false); }
  };

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-lg items-center px-4 py-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Link2 className="h-5 w-5 text-primary" aria-hidden="true" />{t('Source-share link')}</CardTitle>
          <CardDescription>{t('This temporary room transfers signed source code only. It does not add this device to the sender’s dapp.')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading && <p role="status" className="text-sm text-muted-foreground">{t('Connecting to the source owner…')}</p>}
          {error && <p role="alert" className="flex gap-2 text-sm text-destructive"><TriangleAlert className="h-4 w-4 shrink-0" />{error}</p>}
          {error && <Button variant="outline" render={<Link to="/" />}>{t('Back to home')}</Button>}
          {bundle && <p className="text-sm text-muted-foreground">{t('The signed definition arrived. Review its files and permissions before installing or replacing anything.')}</p>}
        </CardContent>
      </Card>
      <DefinitionInstallDialog
        bundle={bundle}
        installing={installing}
        onCancel={() => { setBundle(null); void navigate('/'); }}
        onInstall={() => { void install(); }}
        replaceTargets={replaceTargets}
        onReplace={(dappId) => { void replace(dappId); }}
        confirmLabel={t('Install as new dapp')}
      />
    </div>
  );
}
