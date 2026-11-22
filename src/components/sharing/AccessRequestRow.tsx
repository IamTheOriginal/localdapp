import { useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip.tsx';
import { PersonAvatar } from '@/components/PersonAvatar.tsx';
import type { DappAccessRequestEntry } from '@/hooks/useRequestsInbox.ts';
import { approveLobbyDevice } from '@/services/store/index.ts';
import { formatConnectionCode } from '@/services/connectionCode.ts';
import { showAlert } from '@/services/dialogs.ts';

/**
 * One device waiting in a dapp's invite lobby, with its connection code and the
 * owner's approve action. Shared by the global Requests inbox and the per-dapp
 * Share & invite dialog so approval works identically from both.
 */
export default function AccessRequestRow({ entry, title, className }: { entry: DappAccessRequestEntry; title: ReactNode; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const approve = async () => {
    setBusy(true);
    setError('');
    try {
      await approveLobbyDevice(entry.dappId, {
        publicKey: entry.publicKey,
        displayName: entry.displayName,
        encPublicKey: entry.encPublicKey,
        inviteId: entry.inviteId,
      });
      // The joining device now asks its user "approved by … — code …" before it uses the
      // approval (anyone holding the invite link could have posed as the owner). A
      // single-use invite closes with the approval and this row disappears, so the code is
      // put in front of the owner once more — this is the moment the two are compared.
      void showAlert(
        `${entry.displayName} now shows a connection code and asks its user to confirm it before it joins. It must be this one:

${formatConnectionCode(entry.safetyNumber)}`,
        { title: entry.rejoin ? 'Let back in' : 'Approved' },
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not approve this device.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={className ?? 'flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center'}>
      <PersonAvatar name={entry.displayName} seed={entry.publicKey} size="lg" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p className="truncate font-mono text-xs text-muted-foreground" title={entry.publicKey}>{entry.publicKey}</p>
        {entry.autoApprove && !entry.awaitingConfirmation && (
          <p className="text-xs text-muted-foreground">1-step invite — this device is admitted automatically.</p>
        )}
        {entry.awaitingConfirmation && (
          <p className="text-xs text-muted-foreground">
            Approved. That device now shows this code and asks its user to confirm it — it joins as soon as they do.
          </p>
        )}
        {entry.rejoin && !entry.awaitingConfirmation && (
          <p className="text-xs text-muted-foreground">
            Already a member{entry.currentRole ? ` (${entry.currentRole})` : ''} — this device lost its copy and asks to be let back in. Its role stays the same.
          </p>
        )}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
      <div className="flex items-center gap-4 self-stretch justify-between sm:self-auto sm:justify-end">
        <Tooltip>
          <TooltipTrigger>
            <div className="flex cursor-help flex-col items-center px-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Connection code</span>
              <span className="whitespace-nowrap text-lg tabular-nums">{formatConnectionCode(entry.safetyNumber)}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent>The joining device shows the same code. Compare before approving — and the joining device asks its user to compare once more before it joins.</TooltipContent>
        </Tooltip>
        {!entry.autoApprove && !entry.awaitingConfirmation && (
          <Button disabled={!entry.encPublicKey || busy} onClick={() => void approve()}>
            <Check className="h-4 w-4" />
            {busy ? 'Approving…' : entry.rejoin ? 'Let back in' : 'Approve'}
          </Button>
        )}
      </div>
    </div>
  );
}
