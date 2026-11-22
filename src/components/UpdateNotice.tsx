import { useSyncExternalStore } from 'react';
import { RefreshCw } from 'lucide-react';
import { getMeshCompatState, subscribeMeshCompat } from '@/services/meshCompat';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';

/**
 * Shown when the member mesh met a device that speaks another protocol version.
 * The two cannot sync, so the person has to know which side must update.
 */
export default function UpdateNotice() {
  const { t } = useI18n();
  const compat = useSyncExternalStore(subscribeMeshCompat, getMeshCompatState, getMeshCompatState);
  if (compat.newerIn.length === 0 && compat.olderIn.length === 0) return null;
  const outdated = compat.newerIn.length > 0;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-primary/30 bg-primary/10 px-4 py-2 text-sm text-foreground">
      <RefreshCw className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        {outdated
          ? t('Another device in your apps runs a newer version. This device cannot sync with it until you reload to update.')
          : t('A device in one of your apps runs an older version and cannot sync with this one until it is updated. Ask its owner to reload the app there.')}
      </p>
      {outdated && (
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          {t('Reload to update')}
        </Button>
      )}
    </div>
  );
}
