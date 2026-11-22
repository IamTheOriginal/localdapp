import { Inbox, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { DappContent } from '@/components/DappContent.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import RequestsInbox from '@/components/sharing/RequestsInbox.tsx';
import { useI18n } from '@/i18n';

/**
 * The one inbox: everything that waits for a decision on this device — devices
 * asking to join an app, people asking to become a contact, and shares offered
 * by a contact. The sidebar badge counts exactly what is listed here.
 */
export default function RequestsPage() {
  const { t } = useI18n();
  return (
    <DappContent>
      <PageHeader
        icon={<Inbox className="h-5 w-5" />}
        title={t('Requests')}
        description={t('Everything that is waiting for your decision.')}
        actions={(
          <Button variant="outline" onClick={() => window.dispatchEvent(new Event('open-scan-invite'))}>
            <Link2 className="h-4 w-4" />
            {t('Join with link')}
          </Button>
        )}
      />
      <RequestsInbox />
    </DappContent>
  );
}
