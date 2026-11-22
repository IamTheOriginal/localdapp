import { useState } from 'react';
import { Lock } from 'lucide-react';
import { createIdentity } from '../services/identity.ts';
import type { DeviceIdentity } from '../types.ts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useI18n } from '@/i18n';

interface Props {
  onComplete: (identity: DeviceIdentity) => void;
}

export default function OnboardingModal({ onComplete }: Props) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || loading) return;
    setLoading(true);
    setError('');
    try {
      onComplete(await createIdentity(name.trim()));
    } catch (caught) {
      // Key generation fails on browsers without Ed25519 WebCrypto and when
      // IndexedDB is unavailable (private mode). Without this the first run was a
      // dead end: a disabled form stuck on "Creating identity..." in a dialog that
      // cannot be closed.
      setError(caught instanceof Error ? caught.message : String(caught));
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-background flex items-center justify-center">
      <Dialog open={true} onOpenChange={() => {}}>
        <DialogContent showCloseButton={false}>
          <form onSubmit={(e) => void handleSubmit(e)} className="grid gap-5">
            <DialogHeader className="items-center pt-3 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-2xl font-bold text-primary-foreground shadow-sm" aria-hidden="true">⬡</div>
              <DialogTitle className="text-xl tracking-tight">
                {t('Welcome to Dapp Builder')}
              </DialogTitle>
              <DialogDescription>
                {t('Create distributed apps that sync peer-to-peer — no server needed.')}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <Label htmlFor="displayName">{t('Your display name')}</Label>
              <Input
                id="displayName"
                name="displayName"
                autoFocus // autoFocus: single primary input
                placeholder={t('Your display name')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={32}
                disabled={loading}
                autoComplete="name"
              />
              <p className="flex items-start gap-2 rounded-lg border border-border/70 bg-muted/40 px-3 py-2.5 text-left text-xs text-muted-foreground">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                <span>{t('A unique cryptographic identity will be generated on your device. Your private key never leaves this device.')}</span>
              </p>
              {error && (
                <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {t('Your identity could not be created on this device.')} {error}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="default"
                type="submit"
                className="w-full"
                disabled={loading || !name.trim()}
              >
                {loading ? t('Creating identity...') : error ? t('Try again') : t('Get Started')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
