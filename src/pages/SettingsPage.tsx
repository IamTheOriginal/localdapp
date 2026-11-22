import { useRef, useState } from 'react';
import { Check, Copy, Fingerprint, Info, KeyRound, ShieldCheck, TriangleAlert, Upload } from 'lucide-react';
import { updateDisplayName, importIdentity, getIdentity } from '../services/identity.ts';
import type { DeviceIdentity } from '../types.ts';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import SettingsSection from '@/components/settings/SettingsSection.tsx';

interface Props {
  identity: DeviceIdentity;
  onUpdate: (identity: DeviceIdentity) => void;
  /** 'identity' | 'backup' | 'about'; anything else falls back to identity. */
  section?: string;
}

export default function SettingsPage({ identity, onUpdate, section = 'identity' }: Props) {
  if (section === 'backup') {
    return <IdentityBackupSettings onUpdate={onUpdate} />;
  }
  if (section === 'about') {
    return <AboutSettings />;
  }
  return <IdentitySettings identity={identity} onUpdate={onUpdate} />;
}

function IdentitySettings({ identity, onUpdate }: Omit<Props, 'section'>) {
  const [name, setName] = useState(identity.displayName);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    if (!name.trim()) return;
    const updated = updateDisplayName(name.trim());
    if (!updated) return;
    onUpdate(updated);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  return (
    <SettingsSection
      icon={<Fingerprint className="h-5 w-5" aria-hidden="true" />}
      title="Identity"
      description="Manage the device identity used to authenticate with peers."
    >
      <Card>
        <CardContent className="space-y-6 p-5 sm:p-6">
          <div className="space-y-2">
            <Label htmlFor="display-name">Display name</Label>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Input
                id="display-name"
                name="display-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={32}
                autoComplete="nickname"
              />
              <Button className="shrink-0" onClick={handleSave} disabled={!name.trim() || name === identity.displayName}>
                {saved ? <><Check className="h-4 w-4" aria-hidden="true" />Saved</> : 'Save'}
              </Button>
            </div>
          </div>

          <IdentityValue label="Public key" value={identity.publicKey} copyLabel="Copy public key" />
          <IdentityValue label="Device ID" value={identity.deviceId} copyLabel="Copy device ID" />
        </CardContent>
      </Card>
    </SettingsSection>
  );
}

function IdentityBackupSettings({ onUpdate }: Omit<Props, 'section' | 'identity'>) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      const content = loadEvent.target?.result as string;
      if (!content) return;

      void importIdentity(content).then((imported) => {
        if (imported) {
          setImportSuccess(true);
          setImportError(null);
          window.setTimeout(() => {
            const restored = getIdentity();
            if (restored) onUpdate(restored);
            window.location.reload();
          }, 1500);
        } else {
          setImportError('Invalid identity backup file. Please upload a valid JSON backup.');
          setImportSuccess(false);
        }
      }).catch((caught: unknown) => {
        setImportError(caught instanceof Error ? caught.message : String(caught));
        setImportSuccess(false);
      });
    };
    reader.onerror = () => {
      setImportError('The file could not be read.');
      setImportSuccess(false);
    };
    reader.readAsText(file);
  };

  return (
    <SettingsSection
      icon={<KeyRound className="h-5 w-5" aria-hidden="true" />}
      title="Cryptographic identity"
      description="This device's private keys are non-extractable and never leave the browser."
    >
      <Card>
        <CardContent className="space-y-5 p-5 sm:p-6">
          <Alert variant="success">
            <ShieldCheck aria-hidden="true" />
            <p><strong>Keys are locked to this device.</strong> They are stored non-extractably, so no page — including this one — can read or export them. To use your dapps on another device, open the dapp there and join with an invite; each device keeps its own keys.</p>
          </Alert>

          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Button variant="secondary" onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-4 w-4" aria-hidden="true" />
              Restore a legacy key backup
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              className="sr-only"
              onChange={handleFileChange}
              accept="application/json,.json"
              aria-label="Restore cryptographic identity from a JSON backup"
            />
          </div>

          {importSuccess && (
            <Alert variant="success" role="status">
              <Check aria-hidden="true" />
              <span><strong>Identity restored.</strong> Reloading Dapp Builder…</span>
            </Alert>
          )}

          {importError && (
            <Alert variant="destructive" role="alert">
              <TriangleAlert aria-hidden="true" />
              <span><strong>Restore failed:</strong> {importError}</span>
            </Alert>
          )}
        </CardContent>
      </Card>
    </SettingsSection>
  );
}

function AboutSettings() {
  return (
    <SettingsSection
      icon={<Info className="h-5 w-5" aria-hidden="true" />}
      title="About"
      description="Version and architecture information for Dapp Builder."
    >
      <Card>
        <CardContent className="space-y-5 p-5 sm:p-6">
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Dapp Builder is a P2P, local-first, low-code app builder. Your data stays on your device and syncs directly with peers—no central application server required.
          </p>
          <div className="flex flex-wrap gap-2">
            <Badge>v0.1.0</Badge>
            <Badge variant="secondary">Local-first</Badge>
            <Badge variant="secondary">P2P</Badge>
          </div>
        </CardContent>
      </Card>
    </SettingsSection>
  );
}

function IdentityValue({ label, value, copyLabel }: { label: string; value: string; copyLabel: string }) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const copy = () => {
    // The clipboard is refused without a user gesture, in some embedded views and on http.
    navigator.clipboard.writeText(value)
      .then(() => { setCopied('yes'); }, () => { setCopied('failed'); })
      .finally(() => { window.setTimeout(() => { setCopied(null); }, 2000); });
  };
  return (
    <div className="space-y-2">
      <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</Label>
      <div className="relative rounded-lg bg-muted p-3 pr-11 font-mono text-xs break-all">
        {value}
        <button
          type="button"
          onClick={copy}
          className="absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
          aria-label={copyLabel}
        >
          {copied === 'yes' ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
      <p role="status" className="min-h-4 text-xs text-muted-foreground">
        {copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Copying is not allowed here — select the text and copy it by hand.' : ''}
      </p>
    </div>
  );
}
