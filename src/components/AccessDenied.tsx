import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { DappContent } from '@/components/DappContent.tsx';
import { EmptyState } from '@/components/EmptyState.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { useI18n } from '@/i18n';

/** Owner-only page guard: the same "restricted" card on every dapp management page. */
export default function AccessDenied({ dappId, message }: { dappId: string; message: string }) {
  const navigate = useNavigate();
  const { t } = useI18n();
  return (
    <DappContent width="narrow">
      <PageHeader title={t('Access Denied')} />
      <EmptyState
        icon="🔒"
        title={t('Restricted Access')}
        description={message}
        action={(
          <Button variant="default" onClick={() => void navigate(`/dapp/${dappId}`)}>
            {t('Return to Dapp')}
          </Button>
        )}
      />
    </DappContent>
  );
}
