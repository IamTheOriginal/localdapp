import { useCallback, useEffect, useState } from 'react';
import { getQuarantinedMembers } from '@/services/store/auth.ts';
import { LogOut, Radio, RefreshCw, Trash2, Wifi, WifiOff } from 'lucide-react';
import * as Y from 'yjs';
import { getDappDoc } from '../services/store/index.ts';
import { useDappConfig, useDappMembers } from '@/hooks/useYjs.ts';
import { FOUNDER_PLACEHOLDER_NAME } from '../services/store/protocolCore.ts';
import { getDappSyncDocs, type SyncDocSnapshot } from '../services/syncDiagnostics.ts';
import { ensureBlobChannel, getBlobChannelStatus, reconnectBlobChannel, syncDappStateFromPeers, type MeshChannelStatus } from '../services/blobRoomManager.ts';
import { confirmAndDeleteDapp } from '../services/dappDeletionFlow.ts';
import { confirmAndLeaveDapp } from '../services/dappLeaveFlow.ts';
import { useI18n } from '@/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

function countRecords(dappId: string): number {
  let total = 0;
  getDappDoc(dappId).getMap('data').forEach((rows) => {
    if (rows instanceof Y.Array) total += rows.length;
    else if (rows instanceof Y.Map) total += rows.size;
  });
  return total;
}

function agoMs(milliseconds: number, t: (key: string) => string): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 5) return t('just now');
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}min`;
  return `${Math.round(seconds / 3600)}h`;
}

function ago(timestamp: number | null, t: (key: string) => string): string {
  if (!timestamp) return t('never');
  return agoMs(Date.now() - timestamp, t);
}

/** Colour alone says nothing to a screen reader (or to someone who cannot tell red from green): `label` is read out. */
function StatusDot({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <>
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? 'bg-success' : 'bg-destructive'}`} aria-hidden="true" />
      {label && <span className="sr-only">{label}</span>}
    </>
  );
}

function DocCard({ doc, connected, t }: { doc: SyncDocSnapshot; connected: boolean; t: (key: string) => string }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <StatusDot ok={connected && doc.persistenceSynced} label={connected && doc.persistenceSynced ? t('in sync') : t('not syncing')} />
          {doc.label === 'data' ? t('Data document') : t('Source document')}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
          <span>{t('received')}: <span className="font-medium text-foreground">{doc.received}</span> · {ago(doc.lastReceivedAt, t)}</span>
          <span>{t('sent')}: <span className="font-medium text-foreground">{doc.sent}</span> · {ago(doc.lastSentAt, t)}</span>
          <span>{t('local storage')}: {doc.persistenceSynced ? '✓' : '…'}</span>
        </div>
      </CardContent>
    </Card>
  );
}

interface DappSyncPanelProps {
  dappId: string;
  /**
   * Whether this device may leave the dapp (joined through an invite, not the
   * founding owner). When set, a "Leave dapp" action sits above "Delete dapp".
   */
  canLeave?: boolean;
  /** Called after this device left or deleted the dapp so the host can leave its routes. */
  onExit: () => void;
}

/**
 * Live sync diagnostics for one dapp plus its leave / delete actions. Opened
 * from the dapp card at the top of the sidebar; there is no standalone route.
 */
export default function DappSyncPanel({ dappId: id, canLeave = false, onExit }: DappSyncPanelProps) {
  const { t } = useI18n();
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [docs, setDocs] = useState<SyncDocSnapshot[]>([]);
  const members = [...useDappMembers(id)].sort((a, b) => a.name.localeCompare(b.name));
  const founderKey = useDappConfig(id)?.meta.createdBy;
  const [records, setRecords] = useState(0);
  const [mesh, setMesh] = useState<MeshChannelStatus>({ active: false, brokerConnected: false, brokerUrl: null, brokers: [], peers: [], docs: null });
  // Members whose entry this device can neither verify nor disprove (auth.ts). Rare, and
  // invisible without this line: the device simply would not talk to those members.
  const [unverified, setUnverified] = useState(0);
  const [pull, setPull] = useState<{ received: number; total: number } | null>(null);
  const [status, setStatus] = useState('');

  const refresh = useCallback(() => {
    if (!id) return;
    const status = getBlobChannelStatus(id);
    setMesh(status);
    setDocs(getDappSyncDocs(id, status));
    setRecords(countRecords(id));
    setUnverified(getQuarantinedMembers(id).size);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    void ensureBlobChannel(id);
    const initial = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 2000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [id, refresh]);

  const onlineKeys = new Set(mesh.peers.flatMap((peer) => (peer.ready && peer.publicKey ? [peer.publicKey] : [])));
  const livePeers = mesh.peers.filter((peer) => peer.ready).length;
  const shortKey = (publicKey: string) => `${publicKey.slice(0, 8)}…`;
  const memberName = (publicKey: string | null) => (publicKey
    ? members.find((member) => member.publicKey === publicKey)?.name || shortKey(publicKey)
    : '?');

  const reconnect = () => {
    if (!id) return;
    void reconnectBlobChannel(id);
    setStatus(t('Reconnecting…'));
    window.setTimeout(refresh, 800);
  };

  const pullMissing = async () => {
    if (!id) return;
    setStatus('');
    setPull({ received: 0, total: 1 });
    try {
      const ok = await syncDappStateFromPeers(id, (received, total) => setPull({ received, total }));
      setStatus(ok ? t('Pulled the latest data from a member.') : t('No member is reachable to pull from right now.'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setPull(null);
      refresh();
    }
  };

  const remove = async () => {
    if (deleting || leaving) return;
    setDeleting(true);
    try {
      if (await confirmAndDeleteDapp(id, t)) onExit();
    } finally {
      setDeleting(false);
    }
  };

  const leave = async () => {
    if (deleting || leaving) return;
    setLeaving(true);
    try {
      if (await confirmAndLeaveDapp(id, t)) onExit();
    } finally {
      setLeaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5 sm:p-6">
      {/* Right padding keeps the toolbar clear of the dialog close button. */}
      <div className="flex flex-wrap items-center justify-between gap-3 pr-8">
        <div>
          <h2 className="text-xl font-semibold">{t('Sync status')}</h2>
          <p className="text-sm text-muted-foreground">{records} {t('records in the shared document')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={reconnect}><RefreshCw className="h-4 w-4" />{t('Reconnect')}</Button>
          <Button onClick={() => void pullMissing()} disabled={pull !== null}>
            <Radio className="h-4 w-4" />
            {pull ? `${Math.round((pull.received / Math.max(1, pull.total)) * 100)}%` : t('Pull missing data')}
          </Button>
        </div>
      </div>

      {status && <p className="text-sm text-muted-foreground" aria-live="polite">{status}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        {docs.map((doc) => <DocCard key={doc.label} doc={doc} connected={mesh.brokerConnected} t={t} />)}

        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">{t('Members')}</CardTitle><CardDescription>{t('Online means a live connection to that device whose member key was verified.')}</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            {members.length === 0 && <p className="text-sm text-muted-foreground">{t('No members synced yet.')}</p>}
            {unverified > 0 && (
              <p role="alert" className="text-sm text-destructive">
                {unverified === 1
                  ? t('One member of this app cannot be verified on this device and is treated as a non-member here — this device will not sync with it. Ask an owner to open the app and rename that device (any owner-signed change repairs it).')
                  : t('Some members of this app cannot be verified on this device and are treated as non-members here — this device will not sync with them. Ask an owner to open the app and rename those devices (any owner-signed change repairs it).')}
              </p>
            )}
            {members.map((member) => (
              <div key={member.publicKey} className="flex items-center gap-2 text-sm">
                <StatusDot ok={onlineKeys.has(member.publicKey)} />
                <span className="font-medium">
                  {member.publicKey === founderKey && member.name === FOUNDER_PLACEHOLDER_NAME
                    ? `${t('Unnamed device')} ${shortKey(member.publicKey)}`
                    : member.name || shortKey(member.publicKey)}
                </span>
                {member.publicKey === founderKey && <Badge variant="default">{t('Founder')}</Badge>}
                <Badge variant="outline">{member.role}</Badge>
                <span className="text-xs text-muted-foreground">{onlineKeys.has(member.publicKey) ? t('online') : t('offline')}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base"><StatusDot ok={mesh.brokerConnected} label={mesh.brokerConnected ? t('connected') : t('not connected')} />{t('Member mesh')}</CardTitle>
              <Badge variant={livePeers > 0 ? 'default' : 'secondary'}>{livePeers} {t('peers live')}</Badge>
            </div>
            <CardDescription>{t('Carries live changes, catch-up syncs and file content. Only devices that prove a member key by signature are connected — the room password alone is not enough.')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {!mesh.active && <p className="text-sm text-muted-foreground">{t('Channel not open on this device.')}</p>}
            {/* One line per signaling server this device holds — peers are found through any of them. */}
            {mesh.brokers.map((broker) => (
              <div key={broker.url} className="flex items-center gap-2 text-xs text-muted-foreground">
                {broker.connected ? <Wifi className="h-3.5 w-3.5 text-success" /> : <WifiOff className="h-3.5 w-3.5 text-destructive" />}
                <span className="truncate font-mono">{broker.url}</span>
              </div>
            ))}
            {mesh.peers.map((peer, index) => (
              <div key={`${peer.publicKey ?? 'pending'}-${index}`} className="flex items-center gap-2 text-sm">
                <StatusDot ok={peer.ready} />
                <span>{memberName(peer.publicKey)}</span>
                {!peer.ready && <span className="text-xs text-muted-foreground">{t('handshake…')}</span>}
                <span className="text-xs text-muted-foreground">{t('seen')} {agoMs(peer.lastSeenMsAgo, t)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        {t('Dead connections are dropped automatically (within 90s, immediately on wake-up) so devices resume syncing after sleep, and every new connection first pulls exactly the changes this device is missing. “Pull missing data” does the same on demand.')}
      </p>

      <div className="mt-auto flex flex-col gap-3">
        {canLeave && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{t('Leave dapp')}</p>
              <p className="text-xs text-muted-foreground">{t('Stops syncing and tells the other members. A read-only copy stays on this device; rejoin anytime with a fresh invite.')}</p>
            </div>
            <Button
              variant="outline"
              className="border-warning/60 text-warning hover:bg-warning/10 hover:text-warning"
              onClick={() => void leave()}
              disabled={leaving || deleting}
            >
              <LogOut className="h-4 w-4" />
              {leaving ? t('Leaving…') : t('Leave dapp')}
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{t('Delete dapp')}</p>
            <p className="text-xs text-muted-foreground">{t('Erases all local data, source files, sharing rooms, and keys on this device.')}</p>
          </div>
          <Button variant="destructive" onClick={() => void remove()} disabled={deleting || leaving}>
            <Trash2 className="h-4 w-4" />
            {deleting ? t('Deleting…') : t('Delete dapp')}
          </Button>
        </div>
      </div>
    </div>
  );
}
