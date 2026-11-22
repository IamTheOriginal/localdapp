import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Camera, Link2, Package, Puzzle, Users } from 'lucide-react';
import { exportDefinitionBundle } from '../services/store/index.ts';
import { createSourceShare, listSourceShares, removeSourceShare, sourceShareLink, subscribeSourceShares } from '@/services/sourceShare.ts';
import type { SourceShare } from '@/types.ts';
import { DAPP_FILE_MIME, dappFileName, serializeDappFile } from '../services/dappFile.ts';
import { getIdentity } from '../services/identity.ts';
import { showAlert } from '@/services/dialogs.ts';
import { useCodeAppManifest, useDappConfig, useDappsList, useMyRole } from '../hooks/useYjs.ts';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DappContent } from '@/components/DappContent.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import AccessDenied from '@/components/AccessDenied.tsx';
import { grantedDevicePermissionLabels, grantedHostPermissionLabels } from '@/components/code-app/hostPermissionLabels.ts';
import GithubSourceCard from '@/components/code-app/GithubSourceCard.tsx';
import { useI18n } from '@/i18n';
import { Input } from '@/components/ui/input.tsx';

export default function DappSettingsPage() {
  const { t } = useI18n();
  const { id } = useParams<{ id: string }>();
  const config = useDappConfig(id);
  const { manifest: codeAppManifest } = useCodeAppManifest(id);
  const identity = getIdentity();
  const myRole = useMyRole(id);
  const inCatalog = useDappsList().some((dapp) => dapp.id === id);

  const [exportingDefinition, setExportingDefinition] = useState(false);
  const [creatingSourceShare, setCreatingSourceShare] = useState(false);
  const [sourceShares, setSourceShares] = useState<SourceShare[]>([]);

  useEffect(() => {
    if (!id) return;
    const refresh = () => setSourceShares(listSourceShares(id));
    refresh();
    return subscribeSourceShares(refresh);
  }, [id]);

  const handleExportDefinition = async () => {
    if (!id || exportingDefinition) return;
    setExportingDefinition(true);
    try {
      const bundle = await exportDefinitionBundle(id);
      const blob = new Blob([serializeDappFile(bundle)], { type: DAPP_FILE_MIME });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = dappFileName(bundle.name);
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      void showAlert(`Definition export failed: ${error instanceof Error ? error.message : String(error)}`, { title: 'Export failed' });
    } finally {
      setExportingDefinition(false);
    }
  };

  const handleCreateSourceShare = async () => {
    if (!id || creatingSourceShare) return;
    setCreatingSourceShare(true);
    try {
      const share = await createSourceShare(id);
      const link = sourceShareLink(share);
      try { await navigator.clipboard.writeText(link); }
      catch { /* The visible, selectable field remains the fallback. */ }
    } catch (error) {
      void showAlert(`${t('Could not create source link')}: ${error instanceof Error ? error.message : String(error)}`, { title: t('Source sharing failed') });
    } finally {
      setCreatingSourceShare(false);
    }
  };

  if (!id || !config || !inCatalog || !identity || myRole === null) {
    return <div className="p-8 text-center text-sm text-muted-foreground animate-pulse">Loading settings...</div>;
  }

  if (myRole !== 'owner') {
    return <AccessDenied dappId={id} message="You do not have permission to view or change settings for this Dapp." />;
  }

  const hostPermissions = grantedHostPermissionLabels(codeAppManifest);
  const devicePermissions = grantedDevicePermissionLabels(codeAppManifest);

  return (
    <DappContent width="narrow">
      <PageHeader
        icon={config.meta.icon}
        iconStyle={{ backgroundColor: `${config.meta.color}20`, color: config.meta.color }}
        title={`${config.meta.name} Settings`}
      />

      <div className="flex flex-col gap-6">
        {/* Renders nothing unless this dapp was added from a GitHub link. */}
        <GithubSourceCard dappId={id} />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Link2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />{t('Share dapp source')}</CardTitle>
            <CardDescription>{t('Creates a reusable link that expires in 24 hours. The recipient receives only signed source code and does not join this dapp. This device must stay online while the link is used.')}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div>
              <Button variant="secondary" disabled={creatingSourceShare} onClick={() => { void handleCreateSourceShare(); }}>
                {creatingSourceShare ? t('Creating source link…') : t('Create source link')}
              </Button>
              {sourceShares.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{t('A new link was copied when the browser allowed clipboard access. You can also copy it from the field below.')}</p>}
            </div>
            {sourceShares.map((share) => {
              const link = sourceShareLink(share);
              return (
                <div key={share.id} className="grid gap-2 rounded-xl border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm text-muted-foreground">{t('Expires')} {new Date(share.expiresAt).toLocaleString()}</p>
                    <Button variant="outline" size="sm" onClick={() => removeSourceShare(share.id)}>{t('Remove link')}</Button>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input readOnly aria-label={t('Source-share link')} value={link} onFocus={(event) => event.currentTarget.select()} />
                    <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(link); }}>{t('Copy link')}</Button>
                  </div>
                </div>
              );
            })}
            {sourceShares.length === 0 && <p className="text-sm text-muted-foreground">{t('No active source links.')}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Puzzle className="h-4 w-4 text-muted-foreground" aria-hidden="true" />Host permissions</CardTitle>
            <CardDescription>
              Framework UI this Code App may ask to open, declared in <code>manifest.yaml</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {hostPermissions.map((label) => <Badge key={label} variant="secondary">{label}</Badge>)}
            {hostPermissions.length === 0 && (
              <p className="text-sm text-muted-foreground">No host permissions declared.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Camera className="h-4 w-4 text-muted-foreground" aria-hidden="true" />{t('Device permissions')}</CardTitle>
            <CardDescription>
              {t('Device features this Code App may request through the host, declared in manifest.yaml.')}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {devicePermissions.map((label) => <Badge key={label} variant="secondary">{t(label)}</Badge>)}
            {devicePermissions.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('No device permissions declared.')}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Package className="h-4 w-4 text-muted-foreground" aria-hidden="true" />Definition bundle</CardTitle>
            <CardDescription>
              Export signed source code and display metadata as a .dapp file that opens in Dapp Builder. Records, members, and room credentials are never included.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="secondary" disabled={exportingDefinition} onClick={() => { void handleExportDefinition(); }}>
              {exportingDefinition ? 'Exporting…' : 'Export .dapp file'}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />Invites &amp; members</CardTitle>
            <CardDescription>
              Inviting devices, approving them and managing members all live on one page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link to={`/dapp/${id}/share`} className="text-sm font-medium text-primary underline-offset-2 hover:underline">Open Share &amp; invite ›</Link>
          </CardContent>
        </Card>
      </div>

    </DappContent>
  );
}
