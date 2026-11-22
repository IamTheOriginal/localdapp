import { useSyncExternalStore } from 'react';
import { TriangleAlert } from 'lucide-react';
import { getStorageHealth, onStorageHealthChange } from '@/services/store/storageHealth';
import { useI18n } from '@/i18n';

/**
 * Shown for as long as this device cannot keep its data: without it the app
 * looks fine, works in memory, and everything typed is gone after a reload.
 */
export default function StorageWarning() {
  const { t } = useI18n();
  const health = useSyncExternalStore(onStorageHealthChange, getStorageHealth, getStorageHealth);
  if (health === 'ok') return null;
  return (
    <div role="alert" className="flex items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-foreground">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
      <p>
        <strong className="font-medium">
          {health === 'unavailable'
            ? t('This device cannot store data right now.')
            : t('Saving to this device failed.')}
        </strong>{' '}
        {health === 'unavailable'
          ? t('Changes are only kept until you close or reload the app. Check that this is not a private window and that the browser may store data for this site, then reload.')
          : t('The storage is probably full. Changes made from now on may be lost on reload — free up space (Settings → Local data), then reload.')}
      </p>
    </div>
  );
}
