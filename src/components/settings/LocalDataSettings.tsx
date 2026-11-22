import { useEffect, useState } from 'react';
import { formatBytes } from '@/lib/format.ts';
import { Download, Eraser, HardDrive, ShieldCheck, TriangleAlert } from 'lucide-react';
import { exportLocalData, requestLocalDataReset } from '@/services/localData.ts';
import { showConfirm } from '@/services/dialogs.ts';
import { getBlobStore, type BlobStoreUsage } from '@/services/blobStore.ts';
import { getBlobCleanupPolicy, runBlobCleanup, setBlobCleanupPolicy, type BlobCleanupPolicy } from '@/services/blobCleanup.ts';
import { getKeepAwakeState, setKeepAwakeEnabled, subscribeKeepAwake, type KeepAwakeState } from '@/services/wakeLock.ts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Card, CardContent } from '@/components/ui/card';

const RETENTION_CHOICES: Array<{ value: number | null; label: string }> = [
  { value: 7, label: 'after a week unused' },
  { value: 30, label: 'after a month unused' },
  { value: 90, label: 'after 3 months unused' },
  { value: null, label: 'never (keep until deleted)' },
];

const SIZE_CAP_CHOICES: Array<{ value: number | null; label: string }> = [
  { value: 512 * 1024 * 1024, label: '512 MB' },
  { value: 1024 * 1024 * 1024, label: '1 GB' },
  { value: 2 * 1024 * 1024 * 1024, label: '2 GB' },
  { value: 5 * 1024 * 1024 * 1024, label: '5 GB' },
  { value: null, label: 'no limit' },
];

export default function LocalDataSettings() {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blobUsage, setBlobUsage] = useState<BlobStoreUsage | null>(null);
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [policy, setPolicy] = useState<BlobCleanupPolicy>(() => getBlobCleanupPolicy());
  const [cleaning, setCleaning] = useState(false);
  const [cleanupNote, setCleanupNote] = useState<string | null>(null);
  const [keepAwake, setKeepAwake] = useState<KeepAwakeState>(() => getKeepAwakeState());

  useEffect(() => subscribeKeepAwake(setKeepAwake), []);

  useEffect(() => {
    void getBlobStore().usage().then(setBlobUsage).catch(() => setBlobUsage(null));
    if (navigator.storage?.estimate) {
      void navigator.storage.estimate().then((estimate) => {
        setQuota({ usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 });
      }).catch(() => setQuota(null));
    }
    if (navigator.storage?.persisted) {
      void navigator.storage.persisted().then(setPersisted).catch(() => setPersisted(null));
    }
  }, []);

  const updatePolicy = (next: BlobCleanupPolicy) => {
    setPolicy(next);
    setBlobCleanupPolicy(next);
  };

  const handleCleanupNow = async () => {
    if (cleaning) return;
    setCleaning(true);
    setCleanupNote(null);
    try {
      const result = await runBlobCleanup(policy);
      setCleanupNote(result.evicted === 0
        ? 'Nothing to clean up — no unpinned files matched the policy.'
        : `Removed ${result.evicted} local file ${result.evicted === 1 ? 'copy' : 'copies'} (${formatBytes(result.freedBytes)} freed). The files stay available from other members.`);
      setBlobUsage(await getBlobStore().usage());
    } catch (cleanupError) {
      setCleanupNote(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    } finally {
      setCleaning(false);
    }
  };

  const handlePersist = async () => {
    if (!navigator.storage?.persist) return;
    try {
      setPersisted(await navigator.storage.persist());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    setError(null);
    try {
      const bundle = await exportLocalData();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `dapp-builder-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setExporting(false);
    }
  };

  const handleReset = async () => {
    if (!(await showConfirm('Delete ALL dapp data stored on this device? Dapps you own that are not synced to another peer are lost permanently. Your identity is kept.', { title: 'Reset this device', confirmLabel: 'Continue', danger: true }))) return;
    if (!(await showConfirm('Last check: this cannot be undone on this device.', { title: 'Reset this device', confirmLabel: 'Delete all local data', danger: true }))) return;
    requestLocalDataReset();
  };

  return (
    <Card>
      <CardContent className="space-y-6 p-5 sm:p-6">
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Storage</h2>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
            {quota && <span className="flex items-center gap-1.5"><HardDrive className="h-4 w-4" aria-hidden="true" />{formatBytes(quota.usage)} used of {formatBytes(quota.quota)} available</span>}
            {blobUsage && <span>{blobUsage.blobCount} synced files ({formatBytes(blobUsage.completeBytes)})</span>}
          </div>
          {persisted === false && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-muted-foreground">The browser may clear this app's storage under disk pressure.</p>
              <Button variant="secondary" size="sm" onClick={() => void handlePersist()}>
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                Protect storage
              </Button>
            </div>
          )}
          {persisted === true && (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />Storage is protected from automatic cleanup.</p>
          )}
        </div>

        <div className="space-y-3 border-t border-border/70 pt-6">
          <h2 className="text-sm font-semibold">Always-on device</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Keep the screen awake while this app is open, so the device stays reachable as a sync peer — your other devices and members can pull data and files from it any time, like a small keeper node. Best on a plugged-in spare phone or tablet with the app installed; for a device that also works with the screen off, run the headless keeper (docs/HEADLESS.md).
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 shrink-0 accent-primary"
              checked={keepAwake.enabled}
              disabled={!keepAwake.supported}
              onChange={(event) => void setKeepAwakeEnabled(event.target.checked)}
            />
            Keep screen awake while the app is open
          </label>
          {!keepAwake.supported && (
            <p className="text-sm text-muted-foreground">This browser does not support the screen wake lock API.</p>
          )}
          {keepAwake.supported && keepAwake.enabled && (
            <p className="text-sm text-muted-foreground">
              {keepAwake.active
                ? 'Wake lock active — the screen stays on while this tab is visible.'
                : 'Wake lock engages as soon as this tab is visible in the foreground.'}
            </p>
          )}
        </div>

        <div className="space-y-3 border-t border-border/70 pt-6">
          <h2 className="text-sm font-semibold">Synced file cleanup</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Files fetched from other members are cached on this device. Cleanup removes unused, unpinned copies — your own uploads and pinned files are never touched, and removed files stay in every file list and re-download on demand (a member holding a copy, such as an always-on keeper node, must be online).
          </p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground">Remove copies</span>
              <NativeSelect
                compact
                value={policy.retentionDays === null ? 'off' : String(policy.retentionDays)}
                onChange={(event) => updatePolicy({ ...policy, retentionDays: event.target.value === 'off' ? null : Number(event.target.value) })}
              >
                {RETENTION_CHOICES.map((choice) => (
                  <option key={choice.label} value={choice.value === null ? 'off' : String(choice.value)}>{choice.label}</option>
                ))}
              </NativeSelect>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground">Keep at most</span>
              <NativeSelect
                compact
                value={policy.maxBytes === null ? 'off' : String(policy.maxBytes)}
                onChange={(event) => updatePolicy({ ...policy, maxBytes: event.target.value === 'off' ? null : Number(event.target.value) })}
              >
                {SIZE_CAP_CHOICES.map((choice) => (
                  <option key={choice.label} value={choice.value === null ? 'off' : String(choice.value)}>{choice.label}</option>
                ))}
              </NativeSelect>
            </label>
            <Button variant="secondary" size="sm" onClick={() => void handleCleanupNow()} disabled={cleaning}>
              <Eraser className="h-4 w-4" aria-hidden="true" />
              {cleaning ? 'Cleaning up…' : 'Clean up now'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Cleanup runs automatically in the background; oldest unused copies are removed first when the size limit is reached.</p>
          {cleanupNote && <p className="text-sm text-muted-foreground" role="status">{cleanupNote}</p>}
        </div>

        <div className="space-y-3 border-t border-border/70 pt-6">
          <h2 className="text-sm font-semibold">Export local data</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Download every document stored on this device (dapp catalogs, data, Code App sources, sharing channels) as one JSON bundle of Yjs updates. Private keys are non-extractable and are never part of an export.
          </p>
          <Button variant="secondary" onClick={() => void handleExport()} disabled={exporting}>
            <Download className="h-4 w-4" aria-hidden="true" />
            {exporting ? 'Exporting…' : 'Export all local data'}
          </Button>
        </div>

        <div className="space-y-3 border-t border-border/70 pt-6">
          <h2 className="text-sm font-semibold text-destructive">Reset this device</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Deletes all locally stored dapp data and reloads the app. Your identity (keys and display name) is kept, so invites and memberships on other devices remain valid — but dapps that exist only on this device are gone for good.
          </p>
          <Button variant="destructive" onClick={() => void handleReset()}>
            <TriangleAlert className="h-4 w-4" aria-hidden="true" />
            Delete all local data
          </Button>
        </div>

        {error && (
          <Alert variant="destructive" role="alert">
            <TriangleAlert aria-hidden="true" />
            <span><strong>Export failed:</strong> {error}</span>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
