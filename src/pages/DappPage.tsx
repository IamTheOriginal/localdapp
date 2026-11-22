import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Clock, ShieldCheck } from 'lucide-react';
import type { CodeAppChromeMode } from '@/types';
import { useCodeAppManifest, useDappConfig, useMyRole } from '../hooks/useYjs.ts';
import { getDappDoc, getDappLobbyId, getDappPersistence, getDappSourceDoc, getDappsList, getLobbyProvider } from '../services/store/index.ts';
import { whenLocalCopyLoaded } from '../services/store/storageHealth.ts';
import { formatConnectionCode } from '../services/connectionCode.ts';
import { getIdentity } from '../services/identity.ts';
import { deriveLobbyOwnerCodes, type LobbyOwnerCode } from '../services/lobbyOwners.ts';
import { Card, CardContent } from '@/components/ui/card';
import CodeAppRuntime from '@/components/code-app/CodeAppRuntime';
import ConfirmApprovalCard, { usePendingAccessGrant } from '@/components/sharing/ConfirmApprovalCard';
import { codeAppFullscreenRouteUrl, codeAppRouteUrl, normalizeCodeAppRoutePath, splitCodeAppNavigationTarget } from '@/services/codeAppManifest';

export default function DappPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const config = useDappConfig(id);
  const { manifest: codeAppManifest, localReady: manifestReady } = useCodeAppManifest(id);
  // A string, not the identity object: getIdentity() parses a fresh object on every call,
  // and as an effect dependency that re-ran the effects below on every render.
  const myPublicKey = getIdentity()?.publicKey ?? null;
  const [isApproved, setIsApproved] = useState<boolean | null>(null);
  const [ownerCodes, setOwnerCodes] = useState<LobbyOwnerCode[]>([]);
  const pendingGrant = usePendingAccessGrant(id);
  // Whether this device is still waiting on a lobby approval (invitee without
  // main-room credentials). Owners and already-granted members have roomId in
  // the catalog and must NEVER see the "Connecting to owner" screen — for
  // them, a missing config just means local restore is still running.
  const [awaitingApproval, setAwaitingApproval] = useState<boolean | null>(null);
  const [localRestored, setLocalRestored] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ received: number; total: number } | null>(null);
  const [sourcesReady, setSourcesReady] = useState(false);
  const myRole = useMyRole(id);

  useEffect(() => {
    if (!id) return;
    const list = getDappsList();
    const check = () => {
      for (let i = 0; i < list.length; i++) {
        const item = list.get(i);
        if (item.get('id') !== id) continue;
        const hasRoom = Boolean(item.get('roomId') && item.get('roomPassword'));
        const hasLobby = Boolean(item.get('lobbyId') && item.get('lobbyPassword'));
        setAwaitingApproval(!hasRoom && hasLobby);
        return;
      }
      setAwaitingApproval(null);
    };
    check();
    list.observeDeep(check);
    return () => list.unobserveDeep(check);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    // Bounded: when the local database never opens the app still starts (in memory; the shell warns).
    void whenLocalCopyLoaded(getDappPersistence(id)).then(() => {
      if (!cancelled) setLocalRestored(true);
    });
    return () => { cancelled = true; };
  }, [id]);

  // Keep the blob mesh up while the dapp is open — it serves files AND the
  // chunked doc-sync path other members use to complete large initial joins.
  useEffect(() => {
    if (!id) return;
    void import('@/services/blobRoomManager')
      .then(({ ensureBlobChannel }) => ensureBlobChannel(id))
      .catch((error: unknown) => { console.error('member mesh could not be started for this dapp', error); });
  }, [id]);

  // The app SHELL comes from the small source doc and must not wait for the
  // (possibly huge) main doc: mount the runtime as soon as sources exist.
  useEffect(() => {
    if (!id || awaitingApproval !== false) return;
    const files = getDappSourceDoc(id).getMap('files');
    const check = () => setSourcesReady(files.size > 0);
    check();
    files.observe(check);
    return () => files.unobserve(check);
  }, [id, awaitingApproval]);

  // When local restore finished but the dapp is still empty (fresh join of a
  // large dapp), pull the state chunked from a connected member: y-webrtc's
  // single-message initial sync cannot deliver large docs at all.
  const missingData = localRestored && !config && awaitingApproval === false;
  useEffect(() => {
    if (!id || !missingData) return;
    let cancelled = false;
    const run = async () => {
      const { syncDappStateFromPeers } = await import('@/services/blobRoomManager');
      while (!cancelled) {
        const ok = await syncDappStateFromPeers(id, (received, total) => {
          if (!cancelled) setSyncProgress({ received, total });
        });
        if (ok || cancelled) break;
        await new Promise((resolve) => setTimeout(resolve, 8000));
      }
      if (!cancelled) setSyncProgress(null);
    };
    void run();
    return () => { cancelled = true; };
  }, [id, missingData]);

  useEffect(() => {
    if (!id || !myPublicKey) return;
    const doc = getDappDoc(id);
    const membersMap = doc.getMap('members');

    const check = () => {
      setIsApproved(membersMap.has(myPublicKey));
    };

    check();
    membersMap.observe(check);
    return () => { membersMap.unobserve(check); };
  }, [id, myPublicKey]);

  // One connection code per owner device in the lobby (invitee waiting screen):
  // each owner's screen shows the code for its own key, so all are listed.
  useEffect(() => {
    // Only a device that is actually waiting in a lobby has a lobby provider —
    // everyone else must not poll for one for as long as the page is open.
    if (!id || !myPublicKey || awaitingApproval !== true) return;

    let cleanup: (() => void) | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const attach = () => {
      const lobbyProvider = getLobbyProvider(id);
      if (!lobbyProvider) {
        // Provider not ready yet — retry shortly
        retryTimer = setTimeout(attach, 500);
        return;
      }

      let disposed = false;
      let run = 0;
      const computeOwnerCodes = async () => {
        const current = ++run;
        const codes = await deriveLobbyOwnerCodes(lobbyProvider.awareness.getStates().values(), myPublicKey, getDappLobbyId(id));
        // Awareness changes overlap; only the latest derivation may land.
        if (!disposed && current === run) setOwnerCodes(codes);
      };

      void computeOwnerCodes();
      lobbyProvider.awareness.on('change', computeOwnerCodes);
      cleanup = () => { disposed = true; lobbyProvider.awareness.off('change', computeOwnerCodes); };
    };

    attach();

    return () => {
      if (retryTimer) clearTimeout(retryTimer);
      if (cleanup) cleanup();
    };
  }, [id, myPublicKey, awaitingApproval]);

  // The URL family (/app vs /full) always wins over the manifest's requested
  // default chrome — only fall back to the manifest when the current path is
  // neither (e.g. a bare /dapp/:id URL still resolving to its canonical target).
  const codeAppChromeFromPath = useMemo<CodeAppChromeMode | null>(() => {
    if (!id) return null;
    const appPrefix = `/dapp/${id}/app`;
    const fullPrefix = `/dapp/${id}/full`;
    if (location.pathname === appPrefix || location.pathname.startsWith(`${appPrefix}/`)) return 'standard';
    if (location.pathname === fullPrefix || location.pathname.startsWith(`${fullPrefix}/`)) return 'fullscreen';
    return null;
  }, [id, location.pathname]);

  const codeAppChrome: CodeAppChromeMode = codeAppChromeFromPath
    ?? (codeAppManifest.display?.chrome === 'fullscreen' ? 'fullscreen' : 'standard');

  const codeAppRoute = useMemo(() => {
    const fallback = codeAppManifest.routes[0]?.path || '/';
    if (!id) return fallback;
    const prefix = codeAppChromeFromPath === 'fullscreen' ? `/dapp/${id}/full` : `/dapp/${id}/app`;
    if (!location.pathname.startsWith(prefix)) return fallback;
    const suffix = location.pathname.slice(prefix.length) || '/';
    try {
      return normalizeCodeAppRoutePath(suffix);
    } catch {
      return fallback;
    }
  }, [codeAppChromeFromPath, codeAppManifest.routes, id, location.pathname]);

  useEffect(() => {
    if (!id || !manifestReady) return;
    const routeExists = codeAppManifest.routes.some((route) => route.path === codeAppRoute);
    const targetPath = routeExists ? codeAppRoute : codeAppManifest.routes[0].path;
    const expectedUrl = codeAppChrome === 'fullscreen'
      ? codeAppFullscreenRouteUrl(id, targetPath)
      : codeAppRouteUrl(id, targetPath);
    if (location.pathname !== expectedUrl) void navigate(expectedUrl, { replace: true });
  }, [codeAppChrome, codeAppManifest.routes, codeAppRoute, id, location.pathname, manifestReady, navigate]);

  // Preserves the current chrome family — in-app navigation never changes standard/fullscreen.
  const navigateCodeApp = useCallback((target: string) => {
    if (!id) return;
    const { path, search } = splitCodeAppNavigationTarget(target);
    if (!codeAppManifest.routes.some((route) => route.path === path)) {
      throw new Error(`Route "${path}" is not declared in manifest.yaml.`);
    }
    const url = codeAppChrome === 'fullscreen' ? codeAppFullscreenRouteUrl(id, path) : codeAppRouteUrl(id, path);
    void navigate(url + search);
  }, [codeAppChrome, codeAppManifest.routes, id, navigate]);

  const setCodeAppChrome = useCallback((mode: CodeAppChromeMode) => {
    if (!id) return;
    const url = mode === 'fullscreen' ? codeAppFullscreenRouteUrl(id, codeAppRoute) : codeAppRouteUrl(id, codeAppRoute);
    void navigate(`${url}${location.search}`);
  }, [codeAppRoute, id, location.search, navigate]);

  // Route params guarantee an id on every /dapp/:id path; render nothing on
  // the impossible bare match instead of asserting through the whole tree.
  if (!id) return null;

  // An owner approved this device: the person confirms WHO it was before the approval is used.
  if (awaitingApproval === true && pendingGrant) return <ConfirmApprovalCard grant={pendingGrant} />;

  if (awaitingApproval === true && (isApproved === false || (isApproved === null && !config))) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <Card className="max-w-md w-full text-center">
          <CardContent className="py-8">
            <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-muted/60 text-primary" aria-hidden="true">
              <Clock className="h-6 w-6" />
            </div>
            <h2 className="mb-2 text-xl font-semibold tracking-tight">Verifying secure connection...</h2>
            <p className="mb-6 text-sm text-muted-foreground">
              An owner needs to approve your request. Check that the Connection Code next to their device below matches the one on their screen.
            </p>
            <div className="rounded-xl border border-border bg-muted/35 p-5">
              {ownerCodes.length === 0 ? (
                <>
                  <div className="mb-2 text-xs font-medium text-muted-foreground">Connection Code</div>
                  <div className="mb-2 font-mono text-3xl tracking-wider">------</div>
                  <div className="mt-2 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" role="status" aria-label="Loading" /> Connecting to owner...
                  </div>
                </>
              ) : (
                <>
                  <ul className="space-y-4" aria-label="Connection codes by owner device">
                    {ownerCodes.map((owner) => (
                      <li key={owner.publicKey}>
                        <div className="mb-1 break-words text-xs font-medium text-muted-foreground">
                          {ownerCodes.length > 1 ? `Connection Code for ${owner.displayName}` : `Connection Code · ${owner.displayName}`}
                        </div>
                        <div className={`${ownerCodes.length > 1 ? 'text-3xl' : 'text-4xl'} font-mono font-semibold tracking-wider tabular-nums`}>
                          {formatConnectionCode(owner.safetyNumber)}
                        </div>
                      </li>
                    ))}
                  </ul>
                  {ownerCodes.length > 1 && (
                    <div className="mt-4 text-xs leading-relaxed text-muted-foreground">
                      Several owner devices are online. Each one shows its own code, so compare with the device that approves you.
                    </div>
                  )}
                  <div className="mt-4 inline-flex items-center justify-center gap-1.5 text-xs leading-relaxed text-muted-foreground">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                    <span>This code ensures nobody can eavesdrop on your private connection.</span>
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Shell-first: with sources synced, run the app even while the main doc is
  // still streaming in (role null = read-only until membership arrives).
  const shellReady = awaitingApproval === false && !config && sourcesReady;

  if (!shellReady && (!config || isApproved === null || isApproved === false)) {
    const restoredButEmpty = localRestored && (!config || isApproved === false);
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <span className="animate-spin inline-block w-8 h-8 border-2 border-primary border-t-transparent rounded-full" role="status" aria-label="Loading" />
          <div className="text-xl">
            {syncProgress
              ? `Syncing from a member… ${Math.round((syncProgress.received / Math.max(1, syncProgress.total)) * 100)}%`
              : localRestored ? 'Waiting for dapp data…' : 'Restoring local data…'}
          </div>
          <p className="text-sm text-muted-foreground">
            {syncProgress
              ? 'Receiving the dapp state in chunks from an online member.'
              : restoredButEmpty
                ? 'Local storage finished loading but this dapp’s data has not appeared. Looking for an online member to sync from — if this device holds the only copy, storage may be exhausted or corrupted (check Settings → Local Data and the browser console).'
                : 'Large dapps (many records or embedded previews) can take a while to restore from disk on every open.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {!config && (
        <div className="flex items-center justify-center gap-2 border-b border-border bg-muted/60 px-4 py-1.5 text-xs text-muted-foreground" role="status">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden="true" />
          {syncProgress
            ? `Syncing dapp data from a member… ${Math.round((syncProgress.received / Math.max(1, syncProgress.total)) * 100)}%`
            : 'Waiting for an online member to sync the dapp data…'}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <CodeAppRuntime
          dappId={id}
          role={myRole}
          route={codeAppRoute}
          search={location.search}
          chrome={codeAppChrome}
          onNavigate={navigateCodeApp}
          onSetChrome={setCodeAppChrome}
        />
      </div>
    </div>
  );
}
