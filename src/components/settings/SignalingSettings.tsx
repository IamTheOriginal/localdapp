import { useCallback, useEffect, useState } from 'react';
import { Plus, RotateCcw, ShieldCheck, TriangleAlert, Trash2 } from 'lucide-react';
import {
  defaultIceServersUrl,
  defaultSignalingUrls,
  getDeviceIceServers,
  getDeviceSignalingUrls,
  getDynamicIceStatus,
  normalizeDeviceIceServers,
  normalizeSignalingUrls,
  setDeviceIceServers,
  setDeviceSignalingUrls,
  subscribeIceConfig,
  MAX_ICE_CREDENTIAL_LENGTH,
  MAX_ICE_SERVERS,
  MAX_ICE_URL_LENGTH,
  MAX_SIGNALING_URLS,
  MAX_SIGNALING_URL_LENGTH,
  type DynamicTurnStatus,
  type IceServerEntry,
  type IceServerRejection,
  type SignalingUrlRejection,
} from '@/services/signalingConfig.ts';
import type { MeshBrokerStatus } from '@/services/blobRoomManager.ts';
import { useI18n } from '@/i18n';
import { fill } from '@/components/home/text.ts';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Device-local signaling & TURN/ICE relay servers (services/signalingConfig.ts).
 *
 * Someone who opened this app from somebody else's site can point THIS device
 * at their own broker or TURN server without rebuilding it. Both settings never
 * leave the device — they are in no document and in no invite.
 */

const STATUS_POLL_MS = 3000;

/** Colour alone says nothing to a screen reader: `label` is read out. */
function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <>
      <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${ok ? 'bg-success' : 'bg-muted-foreground/50'}`} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </>
  );
}

function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 10 || Math.abs(mb - Math.round(mb)) < 0.05) {
    return `${Math.round(mb)} MB`;
  }
  return `${mb.toFixed(1)} MB`;
}

function iceUrlsLabel(entry: IceServerEntry): string {
  return Array.isArray(entry.urls) ? entry.urls.join(', ') : entry.urls;
}

export default function SignalingSettings() {
  const { t } = useI18n();
  const defaults = defaultSignalingUrls();
  const [device, setDevice] = useState<string[]>(() => getDeviceSignalingUrls());
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [links, setLinks] = useState<MeshBrokerStatus[]>([]);

  // Device-local custom TURN / ICE servers + live built-in relay quota status.
  const hasBuiltInRelay = defaultIceServersUrl() !== null;
  const [customIce, setCustomIce] = useState<IceServerEntry[]>(() => getDeviceIceServers());
  const [turnStatus, setTurnStatus] = useState<DynamicTurnStatus | null>(() => getDynamicIceStatus());
  const [iceUrlDraft, setIceUrlDraft] = useState('');
  const [iceUserDraft, setIceUserDraft] = useState('');
  const [iceCredDraft, setIceCredDraft] = useState('');
  const [iceError, setIceError] = useState<string | null>(null);
  const [iceNote, setIceNote] = useState<string | null>(null);

  // Empty setting = "use what this build ships with".
  const effective = device.length > 0 ? device : defaults;
  const usesDefault = defaults.some((url) => effective.includes(url));

  // The mesh pulls in the WebRTC stack — load it only when this panel is open.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      void import('@/services/blobRoomManager.ts')
        .then(({ getBrokerLinkStatus }) => {
          if (!cancelled) setLinks(getBrokerLinkStatus());
        })
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [device]);

  useEffect(() => subscribeIceConfig(() => {
    setCustomIce(getDeviceIceServers());
    setTurnStatus(getDynamicIceStatus());
  }), []);

  const rejectionText = useCallback((reason: SignalingUrlRejection): string => {
    if (reason === 'protocol') return t('A signaling address must start with ws:// or wss://.');
    if (reason === 'tooLong') return fill(t('That address is longer than {count} characters.'), { count: MAX_SIGNALING_URL_LENGTH });
    if (reason === 'tooMany') return fill(t('At most {count} signaling servers can be used at once.'), { count: MAX_SIGNALING_URLS });
    return t('That is not a valid address.');
  }, [t]);

  const iceRejectionText = useCallback((reason: IceServerRejection): string => {
    if (reason === 'protocol') return t('A TURN / ICE address must start with stun:, stuns:, turn:, or turns:.');
    if (reason === 'tooLong') return t('That entry exceeds the maximum length.');
    if (reason === 'tooMany') return fill(t('At most {count} custom TURN / ICE servers can be configured.'), { count: MAX_ICE_SERVERS });
    return t('That TURN / ICE address is not valid.');
  }, [t]);

  const apply = (next: string[], message: string | null) => {
    setDevice(setDeviceSignalingUrls(next));
    setError(null);
    setNote(message);
  };

  const handleAdd = () => {
    const candidate = draft.trim();
    if (!candidate) return;
    // Added to the EFFECTIVE list, so adding one never silently drops the default.
    const { urls, rejected } = normalizeSignalingUrls([...effective, candidate]);
    if (rejected.length > 0) {
      setError(rejectionText(rejected[0].reason));
      return;
    }
    if (urls.length === effective.length) {
      setError(t('That server is already in the list.'));
      return;
    }
    setDraft('');
    apply(urls, t('Added. This device now also looks for peers there.'));
  };

  const handleRemove = (url: string) => {
    const next = effective.filter((entry) => entry !== url);
    apply(next, next.length === 0
      ? t('Back to the servers this app was built with.')
      : t('Removed. Devices that only use that server can no longer be found.'));
  };

  const applyIce = (next: IceServerEntry[], message: string | null) => {
    setCustomIce(setDeviceIceServers(next));
    setIceError(null);
    setIceNote(message);
  };

  const handleAddIce = () => {
    const url = iceUrlDraft.trim();
    if (!url) return;
    const entry: IceServerEntry = {
      urls: url,
      ...(iceUserDraft.trim() ? { username: iceUserDraft.trim() } : {}),
      ...(iceCredDraft.trim() ? { credential: iceCredDraft.trim() } : {}),
    };
    const { servers, rejected } = normalizeDeviceIceServers([...customIce, entry]);
    if (rejected.length > 0) {
      setIceError(iceRejectionText(rejected[0].reason));
      return;
    }
    if (servers.length === customIce.length) {
      setIceError(t('That relay server is already in the list.'));
      return;
    }
    setIceUrlDraft('');
    setIceUserDraft('');
    setIceCredDraft('');
    applyIce(servers, t('Added relay server. New connections will use your custom server instead of the shared free quota.'));
  };

  const handleRemoveIce = (index: number) => {
    const next = customIce.filter((_, i) => i !== index);
    applyIce(next, next.length === 0 ? t('Back to the built-in relay.') : t('Removed relay server.'));
  };

  const connected = (url: string) => links.find((link) => link.url === url)?.connected ?? false;

  const usagePercent = turnStatus && turnStatus.limitBytes > 0
    ? Math.min(100, Math.round((turnStatus.usedBytes / turnStatus.limitBytes) * 100))
    : 0;
  const userQuotaHit = turnStatus?.reason === 'user_quota_exceeded' || turnStatus?.reason === 'ip_quota_exceeded';
  const accountCapHit = turnStatus?.reason === 'account_cap_reached';

  const showQuotaMeter = customIce.length === 0
    && turnStatus !== null
    && turnStatus.limitBytes > 0
    && turnStatus.reason !== 'unconfigured';
  const showStunOnlyNote = customIce.length === 0
    && (turnStatus === null || turnStatus.reason === 'unconfigured');

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-6 p-5 sm:p-6">
          <div className="space-y-3">
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t('A signaling server introduces your devices to each other; it never sees your data, which travels directly between the devices and encrypted. This setting belongs to this device only — it is never synced, and it is not part of any dapp or invite. Run your own with server/signaling.mjs (see docs/DEPLOYMENT.md).')}
            </p>
            <Alert variant="warning">
              <TriangleAlert aria-hidden="true" />
              <p>
                <strong>{t('Two devices only find each other if they share at least one signaling server.')}</strong>{' '}
                {t('Adding your own is safe — this device then looks for peers on both. Removing the one the others use cuts you off from them.')}
              </p>
            </Alert>
          </div>

          <div className="space-y-3">
            <h2 className="text-sm font-semibold">{t('Servers this device uses')}</h2>
            <ul className="space-y-2">
              {effective.map((url) => (
                <li key={url} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/70 px-3 py-2 text-sm">
                  <StatusDot ok={connected(url)} label={connected(url) ? t('connected') : t('not connected')} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{url}</span>
                  {/* One badge, not two: with no device list every row IS the build default, and
                      "built in" already says so. */}
                  {defaults.includes(url) && <Badge variant="secondary">{t('built in')}</Badge>}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={effective.length < 2}
                    onClick={() => handleRemove(url)}
                    aria-label={fill(t('Remove {url}'), { url })}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              {t('A grey dot means this device has no open connection to that server right now — it keeps retrying, and one reachable server is enough.')}
            </p>
            {!usesDefault && (
              <Alert variant="destructive" role="status">
                <TriangleAlert aria-hidden="true" />
                <span>{t('This device no longer uses the server this app was built with. You will only meet devices that use one of the servers above.')}</span>
              </Alert>
            )}
          </div>

          <div className="space-y-3 border-t border-border/70 pt-6">
            <Label htmlFor="signaling-url">{t('Add your own signaling server')}</Label>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Input
                id="signaling-url"
                name="signaling-url"
                value={draft}
                placeholder="wss://signal.example.com"
                maxLength={MAX_SIGNALING_URL_LENGTH}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleAdd();
                  }
                }}
              />
              <Button className="shrink-0" onClick={handleAdd} disabled={!draft.trim()}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('Add')}
              </Button>
            </div>
            {error && (
              <Alert variant="destructive" role="alert">
                <TriangleAlert aria-hidden="true" />
                <span>{error}</span>
              </Alert>
            )}
            <p role="status" className="min-h-4 text-xs text-muted-foreground">{note ?? ''}</p>
            <p className="max-w-2xl text-xs text-muted-foreground">
              {t('The change takes effect right away: this device connects to the new set without a reload. Invite lobbies and pairing rooms that are already open keep their current server until you close and reopen them — reloading the app moves all of them over.')}
            </p>
          </div>

          {device.length > 0 && (
            <div className="space-y-3 border-t border-border/70 pt-6">
              <h2 className="text-sm font-semibold">{t('Back to the default')}</h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                {t('Forgets this device’s own list and uses the servers this app was built with again.')}
              </p>
              <Button variant="secondary" onClick={() => apply([], t('Back to the servers this app was built with.'))}>
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                {t('Use the default servers')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-6 p-5 sm:p-6">
          <div className="space-y-2">
            <h2 className="text-sm font-semibold">{t('Relay servers (TURN / ICE)')}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t('Direct peer-to-peer sync is always free and unlimited. A TURN relay is only needed when two devices sit behind strict mobile or corporate firewalls. Custom servers stay on this device only — they are never synced.')}
            </p>
          </div>

          {(hasBuiltInRelay || turnStatus) && (
            <div className="space-y-3 rounded-lg border border-border/70 bg-muted/25 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-foreground">{t('Built-in free relay')}</span>
                {customIce.length > 0 ? (
                  <Badge variant="secondary" className="gap-1">
                    <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                    {t('Using your own relay server')}
                  </Badge>
                ) : turnStatus?.active ? (
                  <Badge variant="secondary">{t('Free relay active')}</Badge>
                ) : userQuotaHit ? (
                  <Badge variant="destructive">{t('Monthly limit reached')}</Badge>
                ) : accountCapHit ? (
                  <Badge variant="destructive">{t('Community cap reached')}</Badge>
                ) : (
                  <Badge variant="outline">{t('STUN only')}</Badge>
                )}
              </div>

              {showQuotaMeter && turnStatus && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {fill(t('{used} / {limit} used this month ({month})'), {
                        used: formatMegabytes(turnStatus.usedBytes),
                        limit: formatMegabytes(turnStatus.limitBytes),
                        month: turnStatus.month || '—',
                      })}
                    </span>
                    <span className="font-mono">{usagePercent}%</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-valuenow={usagePercent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className={`h-full rounded-full transition-all ${userQuotaHit || accountCapHit ? 'bg-destructive' : 'bg-primary'}`}
                      style={{ width: `${usagePercent}%` }}
                    />
                  </div>
                  {!turnStatus.analyticsSynced && turnStatus.active && (
                    <p className="text-[11px] text-muted-foreground">
                      {t('Usage metering activates automatically once analytics sync is enabled on the relay.')}
                    </p>
                  )}
                </div>
              )}

              {showStunOnlyNote && (
                <p className="text-xs text-muted-foreground">
                  {t('No shared TURN relay is configured — direct peer-to-peer sync uses free STUN. Add your own TURN server below if you need sync across strict firewalls.')}
                </p>
              )}

              {customIce.length === 0 && userQuotaHit && turnStatus && (
                <Alert variant="warning" role="status">
                  <TriangleAlert aria-hidden="true" />
                  <span>
                    {fill(t('Free monthly relay limit reached ({limit}) — direct peer-to-peer sync still works. Add your own TURN server below for unlimited relay.'), {
                      limit: formatMegabytes(turnStatus.limitBytes || 10 * 1024 * 1024),
                    })}
                  </span>
                </Alert>
              )}

              {customIce.length === 0 && accountCapHit && (
                <Alert variant="warning" role="status">
                  <TriangleAlert aria-hidden="true" />
                  <span>
                    {t('Monthly community relay cap reached — direct peer-to-peer sync still works until next month, or add your own TURN server below.')}
                  </span>
                </Alert>
              )}
            </div>
          )}

          {customIce.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">{t('Your custom TURN / ICE servers')}</h3>
              <div role="list" className="space-y-2">
                {customIce.map((entry, index) => {
                  const label = iceUrlsLabel(entry);
                  return (
                    <div
                      key={`${label}-${entry.username ?? ''}-${index}`}
                      role="listitem"
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/70 px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{label}</span>
                      {entry.username && (
                        <Badge variant="outline" className="font-mono text-[11px]">{entry.username}</Badge>
                      )}
                      {entry.credential && (
                        <Badge variant="secondary">{t('Has credential')}</Badge>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveIce(index)}
                        aria-label={fill(t('Remove {url}'), { url: label })}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-3 border-t border-border/70 pt-6">
            <h3 className="text-sm font-semibold">{t('Add your own TURN / ICE server')}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="ice-server-url">{t('Server URL')}</Label>
                <Input
                  id="ice-server-url"
                  name="ice-server-url"
                  value={iceUrlDraft}
                  placeholder="turns:turn.example.com:5349?transport=tcp"
                  maxLength={MAX_ICE_URL_LENGTH}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setIceUrlDraft(event.target.value);
                    setIceError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleAddIce();
                    }
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ice-server-username">{t('Username (optional)')}</Label>
                <Input
                  id="ice-server-username"
                  name="ice-server-username"
                  value={iceUserDraft}
                  maxLength={MAX_ICE_CREDENTIAL_LENGTH}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setIceUserDraft(event.target.value);
                    setIceError(null);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ice-server-credential">{t('Credential / password (optional)')}</Label>
                <Input
                  id="ice-server-credential"
                  name="ice-server-credential"
                  type="password"
                  value={iceCredDraft}
                  maxLength={MAX_ICE_CREDENTIAL_LENGTH}
                  autoComplete="new-password"
                  spellCheck={false}
                  onChange={(event) => {
                    setIceCredDraft(event.target.value);
                    setIceError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleAddIce();
                    }
                  }}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleAddIce} disabled={!iceUrlDraft.trim()}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('Add relay server')}
              </Button>
              {customIce.length > 0 && (
                <Button variant="secondary" onClick={() => applyIce([], t('Back to the built-in relay.'))}>
                  <RotateCcw className="h-4 w-4" aria-hidden="true" />
                  {t('Use built-in relay')}
                </Button>
              )}
            </div>

            {iceError && (
              <Alert variant="destructive" role="alert">
                <TriangleAlert aria-hidden="true" />
                <span>{iceError}</span>
              </Alert>
            )}
            <p role="status" className="min-h-4 text-xs text-muted-foreground">{iceNote ?? ''}</p>
            <p className="max-w-2xl text-xs text-muted-foreground">
              {t('Tip: Cloudflare Realtime TURN includes 1 TB/month free, or you can self-host coturn. Reload the app so existing rooms pick up the new relay.')}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
