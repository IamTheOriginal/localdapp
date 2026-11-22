import { PersonAvatar } from '@/components/PersonAvatar.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Check } from 'lucide-react';
import { useI18n } from '@/i18n';

/**
 * One person asking to become a contact, with the safety number of the pairing BEFORE it is
 * approved. Anyone who got hold of the invite code can send a request under any name, so the
 * name proves nothing — the number, read out to the person on the other side, does. Shared by
 * the Requests inbox and the Add-contact dialog so both show the same thing.
 */
export default function PairingRequestRow({ personName, requesterPublicKey, safetyNumber, valid, busy, error, onApprove }: {
  personName: string;
  requesterPublicKey: string;
  /** Null while it is being derived. */
  safetyNumber: string | null;
  valid: boolean;
  busy: boolean;
  error?: string;
  onApprove: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <PersonAvatar name={personName || '?'} seed={requesterPublicKey} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{personName || t('Unknown')} {t('wants to be your contact')}</p>
          <p className="truncate font-mono text-xs text-muted-foreground" title={requesterPublicKey}>{requesterPublicKey}</p>
          {!valid && <p className="text-xs text-destructive">{t('This request failed signature verification and cannot be approved.')}</p>}
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </div>
        <Button disabled={!valid || busy} onClick={onApprove}>
          <Check className="h-4 w-4" aria-hidden="true" />
          {busy ? t('Approving…') : t('Approve')}
        </Button>
      </div>
      <div className="rounded-lg bg-muted/40 p-3">
        <p className="text-xs font-medium text-muted-foreground">{t('Safety number — compare BEFORE you approve')}</p>
        <p className="mt-1 break-words font-mono text-sm tabular-nums">{safetyNumber ?? t('Deriving…')}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('Their device shows the same number under the pending contact. Read it out on a call or in person — a name anyone can type, this number nobody can.')}
        </p>
      </div>
    </div>
  );
}
