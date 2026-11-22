import { useEffect, useState } from 'react';
import { registerDialogHost, type DialogRequest } from '@/services/dialogs.ts';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * HTML replacement for window.alert/confirm — mounted once in App. Requests
 * queue so overlapping dialogs are shown one at a time instead of letting the
 * browser offer to suppress them.
 */
export default function SystemDialogs() {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const current = queue[0] ?? null;

  useEffect(() => registerDialogHost((request) => {
    setQueue((previous) => [...previous, request]);
  }), []);

  const settle = (confirmed: boolean) => {
    if (!current) return;
    current.resolve(confirmed);
    setQueue((previous) => previous.slice(1));
  };

  if (!current) return null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) settle(false); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{current.title}</DialogTitle>
          <DialogDescription className="whitespace-pre-line text-left">{current.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {current.kind === 'confirm' && (
            <Button variant="secondary" onClick={() => settle(false)} autoFocus={current.danger}>
              Cancel
            </Button>
          )}
          <Button
            variant={current.danger ? 'destructive' : 'default'}
            onClick={() => settle(true)}
            autoFocus={!current.danger}
          >
            {current.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
