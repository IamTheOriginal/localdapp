import { useEffect, useState } from 'react';
import { ShieldQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatConnectionCode } from '@/services/connectionCode';
import {
  confirmPendingAccessGrant, getPendingAccessGrant, onPendingAccessGrantsChange, refusePendingAccessGrant,
  type PendingAccessGrant,
} from '@/services/store/pendingGrant';
import { useI18n } from '@/i18n';

/** The approval this device holds for `dappId` and has not used yet; null while there is none. */
export function usePendingAccessGrant(dappId: string | undefined): PendingAccessGrant | null {
  const [grant, setGrant] = useState<PendingAccessGrant | null>(() => (dappId ? getPendingAccessGrant(dappId) : null));
  useEffect(() => {
    const read = () => { setGrant(dappId ? getPendingAccessGrant(dappId) : null); };
    read();
    return onPendingAccessGrantsChange(read);
  }, [dappId]);
  return grant;
}

/**
 * Last step of joining: a device approved this one — the person confirms that it was THEIR
 * owner device, by the code both screens show, before the approval is used. Anyone holding
 * the invite link can pose as an owner; only the code tells the devices apart
 * (services/store/pendingGrant.ts).
 */
export default function ConfirmApprovalCard({ grant }: { grant: PendingAccessGrant }) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-md text-center">
        <CardContent className="py-8">
          <ShieldQuestion className="mx-auto mb-4 h-12 w-12 text-primary" aria-hidden="true" />
          <h2 className="mb-2 text-2xl">{t('Almost there — check who let you in')}</h2>
          <p className="mb-6 text-muted-foreground">
            {t('This device was approved by:')} <strong className="break-words text-foreground">{grant.approverName}</strong>
          </p>
          <div className="mb-1 text-xs">{t('Connection Code')}</div>
          <div className="mb-6 font-mono text-4xl tracking-wider tabular-nums" aria-live="polite">{formatConnectionCode(grant.code)}</div>
          {grant.automatic ? (
            <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
              {t('This invite lets devices in automatically, so nobody on the other side has checked this code yet. To be sure, ask an owner to open Share & invite for this app: the list of devices admitted automatically must show exactly this code for you. Anyone holding the invite link could otherwise pose as the owner.')}
            </p>
          ) : (
            <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
              {t('The device that approved you shows a code for this device. Join only if it is exactly this one. A different code — or an approval nobody you know gave — means someone else holding the invite link is posing as the owner.')}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Button onClick={() => { confirmPendingAccessGrant(grant.dappId); }}>{t('The codes match — join')}</Button>
            <Button variant="outline" onClick={() => { refusePendingAccessGrant(grant.dappId); }}>{t('Not the same — keep waiting')}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
