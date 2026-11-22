import { useEffect, useRef } from 'react';
import type { CodeAppChromeMode, CodeAppHostSurface, MemberRole } from '@/types';
import { useRunnableCodeApp } from '@/hooks/useYjs';
import {
  attachCodeAppBridge,
  buildCodeAppDocument,
  cancelledRelationshipSurfaceResult,
  CODE_APP_HOST_SURFACE_CLOSED_EVENT,
  CODE_APP_HOST_SURFACE_EVENT,
  CODE_APP_RELATIONSHIP_SURFACE_EVENT,
  CODE_APP_RELATIONSHIP_SURFACE_RESOLVED_EVENT,
  CODE_APP_SANDBOX,
  type CodeAppBridge,
  type CodeAppHostSurfaceClosedEventDetail,
  type CodeAppHostSurfaceEventDetail,
  type CodeAppRelationshipSurface,
  type CodeAppRelationshipSurfaceEventDetail,
  type CodeAppRelationshipSurfaceResolvedEventDetail,
} from '@/services/codeAppRuntime';
import { Card, CardContent } from '@/components/ui/card';
import { useI18n } from '@/i18n';

interface CodeAppRuntimeProps {
  dappId: string;
  role: MemberRole | null;
  route: string;
  search: string;
  chrome: CodeAppChromeMode;
  onNavigate: (path: string) => void;
  onSetChrome: (mode: CodeAppChromeMode) => void;
}

export default function CodeAppRuntime({ dappId, role, route, search, chrome, onNavigate, onSetChrome }: CodeAppRuntimeProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<CodeAppBridge | null>(null);
  const routeRef = useRef(route);
  const searchRef = useRef(search);
  const chromeRef = useRef(chrome);
  const onNavigateRef = useRef(onNavigate);
  const onSetChromeRef = useRef(onSetChrome);
  const { language, t } = useI18n();
  const languageRef = useRef(language);
  // Only owner-sealed source runs (sourceSeal.ts): a member's rewrite of the synced files never reaches this iframe.
  const { files, localReady, status: sealStatus, reason: sealReason } = useRunnableCodeApp(dappId);
  const content = files['index.html'] || '';

  useEffect(() => {
    languageRef.current = language;
    bridgeRef.current?.setLanguage(language);
  }, [language]);

  useEffect(() => {
    routeRef.current = route;
    searchRef.current = search;
    bridgeRef.current?.setRoute(route, search);
  }, [route, search]);

  useEffect(() => {
    chromeRef.current = chrome;
    bridgeRef.current?.setChrome(chrome);
  }, [chrome]);

  useEffect(() => {
    onNavigateRef.current = onNavigate;
  }, [onNavigate]);

  useEffect(() => {
    onSetChromeRef.current = onSetChrome;
  }, [onSetChrome]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !localReady || !content) return;
    const runtimeId = crypto.randomUUID();
    const bundle = buildCodeAppDocument(files, runtimeId);
    // Resolved by AppShell dispatching the matching *-closed event once the opened
    // modal closes. Tracked so an unmount mid-open resolves rather than leaking.
    const pendingHostSurfaceResolutions = new Map<string, () => void>();
    const pendingRelationshipResolutions = new Map<string, () => void>();
    const onOpenHostSurface = (surface: CodeAppHostSurface, params: Record<string, unknown>): Promise<{ opened: boolean }> => (
      new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const handleClosed = (event: Event) => {
          const detail = (event as CustomEvent<CodeAppHostSurfaceClosedEventDetail>).detail;
          if (detail?.requestId !== requestId) return;
          window.removeEventListener(CODE_APP_HOST_SURFACE_CLOSED_EVENT, handleClosed);
          pendingHostSurfaceResolutions.delete(requestId);
          resolve({ opened: true });
        };
        pendingHostSurfaceResolutions.set(requestId, () => {
          window.removeEventListener(CODE_APP_HOST_SURFACE_CLOSED_EVENT, handleClosed);
          resolve({ opened: false });
        });
        window.addEventListener(CODE_APP_HOST_SURFACE_CLOSED_EVENT, handleClosed);
        window.dispatchEvent(new CustomEvent<CodeAppHostSurfaceEventDetail>(CODE_APP_HOST_SURFACE_EVENT, {
          detail: { requestId, dappId, surface, params },
        }));
      })
    );
    const onOpenRelationshipSurface = (surface: CodeAppRelationshipSurface, params: Record<string, unknown>): Promise<unknown> => (
      new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const handleResolved = (event: Event) => {
          const detail = (event as CustomEvent<CodeAppRelationshipSurfaceResolvedEventDetail>).detail;
          if (detail?.requestId !== requestId) return;
          window.removeEventListener(CODE_APP_RELATIONSHIP_SURFACE_RESOLVED_EVENT, handleResolved);
          pendingRelationshipResolutions.delete(requestId);
          resolve(detail.result);
          iframe.focus();
        };
        pendingRelationshipResolutions.set(requestId, () => {
          window.removeEventListener(CODE_APP_RELATIONSHIP_SURFACE_RESOLVED_EVENT, handleResolved);
          resolve(cancelledRelationshipSurfaceResult(surface));
        });
        window.addEventListener(CODE_APP_RELATIONSHIP_SURFACE_RESOLVED_EVENT, handleResolved);
        window.dispatchEvent(new CustomEvent<CodeAppRelationshipSurfaceEventDetail>(CODE_APP_RELATIONSHIP_SURFACE_EVENT, {
          detail: { requestId, dappId, surface, params },
        }));
      })
    );
    const bridge = attachCodeAppBridge(iframe, dappId, role, runtimeId, {
      route: routeRef.current,
      search: searchRef.current,
      chrome: chromeRef.current,
      language: languageRef.current,
      onNavigate: (path) => onNavigateRef.current(path),
      onSetChrome: (mode) => onSetChromeRef.current(mode),
      onOpenHostSurface,
      onOpenRelationshipSurface,
    });
    bridgeRef.current = bridge;
    iframe.srcdoc = bundle.srcdoc;
    return () => {
      pendingHostSurfaceResolutions.forEach((cancel) => cancel());
      pendingHostSurfaceResolutions.clear();
      pendingRelationshipResolutions.forEach((cancel) => cancel());
      pendingRelationshipResolutions.clear();
      bridge.destroy();
      bundle.dispose();
      bridgeRef.current = null;
      iframe.srcdoc = '';
    };
  }, [content, dappId, files, localReady, role]);

  if (sealStatus === 'blocked') {
    return (
      <div className="flex min-h-[70vh] items-center justify-center p-6">
        <Card className="w-full max-w-md text-center">
          <CardContent className="py-10">
            <div className="mb-4 text-4xl" aria-hidden="true">🛡️</div>
            <h2 className="mb-2 text-xl font-semibold">{t('This app is not running')}</h2>
            <p role="alert" className="text-sm text-muted-foreground">
              {t('Its code was changed without an owner signing it, so it is not started on this device. It runs again as soon as an owner device is online and restores or re-signs the code.')}
            </p>
            {sealReason && <p className="mt-3 text-xs text-muted-foreground">{sealReason}</p>}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!localReady || !content) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center p-6">
        <Card className="w-full max-w-md text-center">
          <CardContent className="py-10">
            <div className="mb-4 text-4xl" aria-hidden="true">{localReady ? '📄' : '🔄'}</div>
            <h2 className="mb-2 text-xl font-semibold">{localReady ? 'index.html is empty' : 'Syncing Code App…'}</h2>
            <p className="text-sm text-muted-foreground">
              {localReady
                ? 'The owner can add the entry file in the Code editor.'
                : 'Loading the isolated source document from local storage and connected peers.'}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      title="Code App"
      sandbox={CODE_APP_SANDBOX}
      // Native capture cannot run at an opaque origin. $camera uses the host bridge.
      allow="camera 'none'; microphone 'none'"
      // Fills its parent (DappPage gives it the remaining height of the viewport-locked
      // shell). Sizing it from 100vh made it taller than the visible area on phones —
      // bottom-fixed app UI sat under the browser chrome — and the old 36rem minimum
      // forced a second scrollbar in landscape and whenever the sync banner showed.
      data-chrome={chrome}
      className="block h-full w-full border-0 bg-white"
    />
  );
}
