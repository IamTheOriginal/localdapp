import { useState } from 'react';
import type { CodeAppDefinitionBundle } from '@/types.ts';
import { parseCodeAppManifest } from '@/services/codeAppManifest.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { useI18n } from '@/i18n';

interface DefinitionInstallDialogProps {
  bundle: CodeAppDefinitionBundle | null;
  installing: boolean;
  onCancel: () => void;
  onInstall: () => void;
  /** Existing dapps whose source their owner may deliberately replace. */
  replaceTargets?: Array<{ id: string; name: string; icon: string }>;
  onReplace?: (dappId: string) => void;
  confirmLabel?: string;
}

function fingerprint(publicKey: string): string {
  return publicKey.match(/.{1,8}/g)?.slice(0, 4).join(' ') ?? publicKey;
}

export default function DefinitionInstallDialog({
  bundle, installing, onCancel, onInstall, replaceTargets = [], onReplace, confirmLabel = 'Install as new dapp',
}: DefinitionInstallDialogProps) {
  const { t } = useI18n();
  const [replaceId, setReplaceId] = useState('');
  if (!bundle) return null;
  const parsed = parseCodeAppManifest(bundle.files['manifest.yaml']);
  const manifest = parsed.manifest;
  const hostPermissions = Object.entries(manifest.permissions?.host ?? {})
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  const networkOrigins = [
    ...(manifest.permissions?.network?.connect ?? []),
    ...(manifest.permissions?.network?.images ?? []),
  ];
  const devicePermissions = Object.entries(manifest.permissions?.device ?? {})
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  const shareNames = manifest.channels?.shares?.map((share) => share.label) ?? [];

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !installing) onCancel(); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Install {bundle.icon} {bundle.name}?</DialogTitle>
          <DialogDescription>
            Review this signed definition before creating a new, empty local dapp instance.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid min-w-0 gap-3 rounded-xl border border-border p-4 text-sm [overflow-wrap:anywhere] sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="font-medium text-muted-foreground">Author key</dt>
          <dd className="break-all font-mono text-xs">{fingerprint(bundle.authorPublicKey)}</dd>
          <dt className="font-medium text-muted-foreground">Source fingerprint</dt>
          <dd className="font-mono text-xs">{bundle.manifestVersion}</dd>
          <dt className="font-medium text-muted-foreground">Files</dt>
          <dd>{Object.keys(bundle.files).length}</dd>
          <dt className="font-medium text-muted-foreground">Routes</dt>
          <dd>{manifest.routes.map((route) => route.label).join(', ') || 'None'}</dd>
          <dt className="font-medium text-muted-foreground">Host permissions</dt>
          <dd className="flex flex-wrap gap-1">
            {hostPermissions.length ? hostPermissions.map((permission) => <Badge key={permission} variant="secondary">{permission}</Badge>) : 'None'}
          </dd>
          <dt className="font-medium text-muted-foreground">Network origins</dt>
          <dd className="break-all">{networkOrigins.length ? networkOrigins.join(', ') : 'None'}</dd>
          <dt className="font-medium text-muted-foreground">Device permissions</dt>
          <dd>{devicePermissions.length ? devicePermissions.join(', ') : 'None'}</dd>
          <dt className="font-medium text-muted-foreground">Share channels</dt>
          <dd>{shareNames.length ? shareNames.join(', ') : 'None'}</dd>
        </dl>

        <p className="text-sm text-muted-foreground">
          The definition contains source code only. Records, app data, members, room credentials, and sharing credentials are not imported.
        </p>

        {onReplace && replaceTargets.length > 0 && (
          <div className="grid gap-2 rounded-xl border border-border p-3">
            <label htmlFor="replace-definition-target" className="text-sm font-medium">{t('Replace source of an existing dapp')}</label>
            <div className="flex flex-wrap gap-2">
              <NativeSelect id="replace-definition-target" value={replaceId} onChange={(event) => setReplaceId(event.target.value)} className="min-w-56">
                <option value="">{t('Choose a dapp…')}</option>
                {replaceTargets.map((target) => <option key={target.id} value={target.id}>{target.icon} {target.name}</option>)}
              </NativeSelect>
              <Button variant="secondary" disabled={installing || !replaceId} onClick={() => { if (replaceId) onReplace(replaceId); }}>
                {installing ? t('Replacing…') : t('Replace source')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('This keeps that dapp’s records, members, credentials, and files, but replaces its code and manifest.')}</p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={installing} onClick={onCancel}>Cancel</Button>
          <Button disabled={installing} onClick={onInstall}>
            {installing ? 'Installing…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
