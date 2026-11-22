import { useParams } from 'react-router-dom';
import { Palette } from 'lucide-react';
import { useDappConfig, useMyRole } from '../hooks/useYjs.ts';
import AccessDenied from '@/components/AccessDenied.tsx';
import ThemeEditor from '@/components/ThemeEditor';
import { DappContent } from '@/components/DappContent.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { useI18n } from '@/i18n';

export default function ThemePage() {
  const { id } = useParams<{ id: string }>();
  const config = useDappConfig(id);
  const myRole = useMyRole(id);
  const { t } = useI18n();

  if (!id || !config || myRole === null) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center animate-pulse">
        <span className="text-xl">{t('Loading…')}</span>
      </div>
    );
  }

  if (myRole !== 'owner') {
    return <AccessDenied dappId={id} message={t('You do not have permission to change the appearance of this app.')} />;
  }

  return (
    <DappContent width="narrow">
      <PageHeader
        icon={<Palette className="h-5 w-5" />}
        title={t('Theme')}
        description={t('Accent color and corner radius for this app — applied live on every device it syncs to.')}
      />
      <ThemeEditor dappId={id} config={config} />
    </DappContent>
  );
}
