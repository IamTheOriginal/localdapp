import { useState } from 'react';
import { BellOff, BellRing, Info } from 'lucide-react';
import {
  disablePushNotifications, enablePushNotifications, getPushRegistration, getPushSupport,
} from '@/services/pushNotifications.ts';
import { useI18n } from '@/i18n/index.tsx';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

function pushEnabled(): boolean {
  return Boolean(getPushRegistration())
    && typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

export default function NotificationSettings() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(pushEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const support = getPushSupport();

  const handleEnable = async () => {
    setBusy(true);
    setError(null);
    try {
      await enablePushNotifications();
      setEnabled(pushEnabled());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    setBusy(true);
    setError(null);
    try {
      await disablePushNotifications();
      setEnabled(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 pt-6">
          <p className="text-sm text-muted-foreground">
            {t('Get a notification when a contact shares something with you while this app is closed.')}
          </p>

          {support === 'ios-needs-install' && (
            <p className="text-sm text-muted-foreground" role="note">
              {t('On iPhone and iPad, notifications only work after adding Dapp Builder to the Home Screen (Share → Add to Home Screen), then enabling them here.')}
            </p>
          )}
          {support === 'unsupported' && (
            <p className="text-sm text-muted-foreground" role="note">
              {t('This browser does not support push notifications.')}
            </p>
          )}

          {support === 'ok' && (enabled ? (
            <div className="flex flex-wrap items-center gap-3">
              <BellRing className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
              <span className="text-sm">{t('Notifications are on for this device.')}</span>
              <Button variant="outline" className="ml-auto" disabled={busy} onClick={() => void handleDisable()}>
                {busy ? t('Turning off…') : t('Turn off')}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <BellOff className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="text-sm">{t('Notifications are off for this device.')}</span>
              <Button className="ml-auto" disabled={busy} onClick={() => void handleEnable()}>
                {busy ? t('Turning on…') : t('Turn on')}
              </Button>
            </div>
          ))}

          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {t('Wake-up notifications are content-free: the relay and your browser vendor only learn that this device was woken — never by whom or about what. Details load through the normal encrypted sync when you open the app.')}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
