import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/i18n';

interface Props {
  onScan: (result: string) => void;
  onClose: () => void;
}

export default function ScannerModal({ onScan, onClose }: Props) {
  const { t } = useI18n();
  const [manualCode, setManualCode] = useState('');

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualCode.trim()) {
      onScan(manualCode.trim());
    }
  };

  useEffect(() => {
    let scanner: import('html5-qrcode').Html5QrcodeScanner | undefined;
    let cancelled = false;

    const initScanner = async () => {
      // Dialog content is portaled — wait for the element to appear before init
      while (!document.getElementById('qr-reader')) {
        if (cancelled) return;
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Heavy ZXing engine loads only when the scanner actually opens.
      const { Html5QrcodeScanner } = await import('html5-qrcode');
      if (cancelled) return;

      scanner = new Html5QrcodeScanner(
        'qr-reader',
        { fps: 10, qrbox: { width: 250, height: 250 } },
        false
      );

      scanner.render(
        (text) => {
          scanner?.clear().catch(console.error);
          onScan(text);
        },
        (err) => {
          // html5-qrcode calls this constantly when no code is found in the frame.
          // We only want to log real errors if needed.
          if (typeof err === 'string' && err.includes('NotFound')) return;
          console.warn('QR scan error', err);
        }
      );
    };

    void initScanner();

    return () => {
      cancelled = true;
      // scanner may still be initializing; clear() only exists once constructed
      scanner?.clear().catch(console.error);
    };
  }, [onScan]);

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Join with a link or QR code')}</DialogTitle>
          <DialogDescription>{t('Works for both kinds of invite: joining an app, and becoming someone’s contact. You confirm on the next page.')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <form onSubmit={handleManualSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="grid min-w-0 flex-1 gap-2">
              <Label htmlFor="inviteCode">{t('Invite link')}</Label>
              <Input 
                id="inviteCode"
                name="inviteCode"
                placeholder={t('Paste the invite link or code')} 
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                className="font-mono text-xs"
                autoComplete="off"
              />
            </div>
            <Button type="submit" variant="default" disabled={!manualCode.trim()}>
              {t('Join')}
            </Button>
          </form>

          <div className="relative text-center text-muted-foreground before:absolute before:top-1/2 before:left-0 before:h-px before:w-full before:bg-border before:content-['']">
            <span className="relative bg-popover px-2 text-xs font-semibold">{t('OR')}</span>
          </div>

          <p className="text-sm text-muted-foreground">
            {t('Point your camera at a Dapp Builder invite QR code.')}
          </p>
          <div id="qr-reader" className="w-full min-w-0 overflow-hidden rounded-xl bg-muted shadow-inner [&_video]:max-w-full"></div>
        </div>
      </DialogContent>
    </Dialog>
  );
}