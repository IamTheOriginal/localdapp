import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FileUp } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { useI18n } from '@/i18n/index.tsx';
import { consumeLaunchedDappFile, DAPP_FILE_ACCEPT, readDappFile } from '@/services/dappFile.ts';
import { importDefinitionBundle } from '@/services/store/index.ts';
import type { CodeAppDefinitionBundle } from '@/types.ts';
import DefinitionInstallDialog from '@/components/code-app/DefinitionInstallDialog.tsx';

/**
 * Landing page for OS file-handler launches (`file_handlers` in
 * manifest.webmanifest → /open-file): the launched `.dapp` file is read from
 * `window.launchQueue`, verified, and shown in the same install preview the
 * Home-page import uses. Browsers without the File Handling API land here
 * only by direct navigation and get a manual picker instead.
 */
export default function OpenFilePage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [bundle, setBundle] = useState<CodeAppDefinitionBundle | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');

  const open = async (file: File) => {
    setError('');
    try {
      setBundle(await readDappFile(file));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  useEffect(() => {
    consumeLaunchedDappFile((file) => { void open(file); });
  }, []);

  const install = async () => {
    if (!bundle || installing) return;
    setInstalling(true);
    try {
      const id = await importDefinitionBundle(bundle);
      setBundle(null);
      void navigate(`/dapp/${id}`, { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-lg items-center px-4 py-8">
      <input
        type="file"
        accept={DAPP_FILE_ACCEPT}
        className="hidden"
        ref={fileInputRef}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void open(file);
        }}
      />
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FileUp className="h-5 w-5 text-primary" aria-hidden="true" />{t('Open a .dapp file')}</CardTitle>
          <CardDescription>{t('A .dapp file is a signed Code App definition: source code and display metadata only, never records, members or credentials. Installing creates a fresh local dapp.')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p role="alert" className="text-sm text-destructive">{t('Invalid dapp file')}: {error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="default" onClick={() => fileInputRef.current?.click()}>{t('Choose file')}</Button>
            <Button variant="outline" render={<Link to="/" />}>{t('Back to home')}</Button>
          </div>
        </CardContent>
      </Card>
      <DefinitionInstallDialog
        bundle={bundle}
        installing={installing}
        onCancel={() => setBundle(null)}
        onInstall={() => { void install(); }}
      />
    </div>
  );
}
