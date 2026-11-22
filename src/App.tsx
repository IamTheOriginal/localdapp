import { Routes, Route, useNavigate } from 'react-router-dom';
import { lazy, Suspense, useEffect, useState } from 'react';
import { getIdentity, ensureIdentityKeysReady, signIceRequest } from './services/identity.ts';
import { getRootDoc, createDapp } from './services/store/index.ts';
import { persistNewDapp } from './services/store/docs.ts';
import { watchStorageHealth } from './services/store/storageHealth.ts';
import type { DeviceIdentity } from './types.ts';
import { TooltipProvider } from '@/components/ui/tooltip';
import CreateDappModal from './components/CreateDappModal.tsx';
import ScannerModal from './components/ScannerModal.tsx';
import OnboardingModal from './components/OnboardingModal.tsx';
import ErrorBoundary, { forgetStaleBuildReload } from './components/ErrorBoundary.tsx';
import AppShell from './components/AppShell.tsx';
import SystemDialogs from './components/SystemDialogs.tsx';
import { showAlert } from './services/dialogs.ts';
import { inviteUriFromText } from './services/inviteLinks.ts';
import { startDynamicIceServers } from './services/signalingConfig.ts';

// Pages are code-split — only the shell loads up front.
const HomePage = lazy(() => import('./pages/HomePage.tsx'));
const DappPage = lazy(() => import('./pages/DappPage.tsx'));
const DappSettingsPage = lazy(() => import('./pages/DappSettingsPage.tsx'));
const CodeAppEditorPage = lazy(() => import('./pages/CodeAppEditorPage.tsx'));
const PeoplePage = lazy(() => import('./pages/PeoplePage.tsx'));
const RequestsPage = lazy(() => import('./pages/RequestsPage.tsx'));
const ShareInvitePage = lazy(() => import('./pages/ShareInvitePage.tsx'));
const ThemePage = lazy(() => import('./pages/ThemePage.tsx'));
const FilesPage = lazy(() => import('./pages/FilesPage.tsx'));
const InvitePage = lazy(() => import('./pages/InvitePage.tsx'));
const ShareTargetPage = lazy(() => import('./pages/ShareTargetPage.tsx'));
const OpenFilePage = lazy(() => import('./pages/OpenFilePage.tsx'));
const SourceImportPage = lazy(() => import('./pages/SourceImportPage.tsx'));

function PageFallback() {
  return (
    <div className="flex h-full min-h-[50vh] items-center justify-center" role="status" aria-label="Loading">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
    </div>
  );
}

export default function App() {
  // Root doc init and the identity lookup are synchronous — resolving them in
  // the initializer (instead of a mount effect) skips the loading flash a
  // post-mount setState produced.
  const [identity, setIdentity] = useState<DeviceIdentity | null>(() => {
    getRootDoc();
    return getIdentity();
  });

  useEffect(() => {
    // Migrate any legacy plaintext identity keys into non-extractable storage.
    void ensureIdentityKeysReady();
    // Storage that cannot be opened or written to must be visible, not silent.
    watchStorageHealth();
    const settled = window.setTimeout(forgetStaleBuildReload, 30_000);
    // Custom events for global sheet actions
    const handleIdentityUpdate = () => setIdentity(getIdentity());
    window.addEventListener('identity-updated', handleIdentityUpdate);

    return () => {
      window.clearTimeout(settled);
      window.removeEventListener('identity-updated', handleIdentityUpdate);
    };
  }, []);

  if (!identity) {
    return <OnboardingModal onComplete={setIdentity} />;
  }

  // We are safe to render the main app now

  return <MainApp identity={identity} setIdentity={setIdentity} />;
}

/**
 * Background runtimes are loaded off the critical path. A load that fails (flaky network, a
 * deploy that replaced the file) used to leave sharing, the reconnect watchdog or the cleanup
 * switched off for the session without a trace: retry once, then say so.
 */
function loadRuntime<T>(label: string, load: () => Promise<T>): Promise<T | null> {
  return load()
    .catch(() => new Promise<void>((resolve) => { setTimeout(resolve, 3_000); }).then(load))
    .catch((error: unknown) => {
      console.error(`${label} could not be loaded — it stays off until the app is reloaded`, error);
      return null;
    });
}

function MainApp({ identity, setIdentity }: { identity: DeviceIdentity, setIdentity: (id: DeviceIdentity) => void }) {
  const navigate = useNavigate();
  const [createDappOpen, setCreateDappOpen] = useState(false);
  const [scanInviteOpen, setScanInviteOpen] = useState(false);

  useEffect(() => {
    // The sharing/relationship and binding runtimes are heavy and most
    // sessions never share anything — load them off the critical path.
    const disposeDynamicIce = startDynamicIceServers({ signRequest: signIceRequest });
    let disposed = false;
    let disposeDirectBindings: (() => void) | null = null;
    void loadRuntime('sharing runtime', () => import('./services/browserRelationshipRuntime.ts')).then((runtime) => {
      if (runtime && !disposed) runtime.initializeBrowserRelationshipRuntime();
    });
    // Reconnect watchdog: recovers zombie WebRTC connections after device
    // sleep so every open dapp resumes live sync without a manual restart.
    let disposeSyncWatchdog: (() => void) | null = null;
    void loadRuntime('sync watchdog', () => import('./services/syncDiagnostics.ts')).then((runtime) => {
      if (runtime && !disposed) disposeSyncWatchdog = runtime.startSyncWatchdog();
    });
    void loadRuntime('direct bindings runtime', () => import('./services/directCodeBindingRuntime.ts')).then((runtime) => {
      if (runtime && !disposed) disposeDirectBindings = runtime.initializeDirectCodeBindingRuntime();
    });
    // Periodic blob cleanup: reclaims unpinned synced file copies per the
    // device's retention/size policy (Settings → Local data).
    let disposeBlobCleanup: (() => void) | null = null;
    void loadRuntime('file cleanup', () => import('./services/blobCleanup.ts')).then((runtime) => {
      if (runtime && !disposed) disposeBlobCleanup = runtime.startBlobCleanupScheduler();
    });
    // Screen wake lock (Settings → Local data → Always-on device): restores the
    // persisted keep-awake preference so a dedicated device stays online.
    let disposeKeepAwake: (() => void) | null = null;
    void loadRuntime('keep-awake', () => import('./services/wakeLock.ts')).then((runtime) => {
      if (runtime && !disposed) disposeKeepAwake = runtime.initKeepAwake();
    });
    // Push notifications: refresh the relay registration and re-announce this
    // device's inbox to contacts (no-op unless VITE_PUSH_RELAY_URL is set).
    void loadRuntime('push notifications', () => import('./services/pushNotifications.ts')).then((runtime) => {
      if (runtime && !disposed) runtime.initPushNotifications();
    });
    void loadRuntime('source shares', () => import('./services/sourceShare.ts')).then((runtime) => {
      if (runtime && !disposed) void runtime.initializeSourceShares();
    });
    const handleNewDapp = () => setCreateDappOpen(true);
    const handleScanInvite = () => setScanInviteOpen(true);
    window.addEventListener('open-new-dapp', handleNewDapp);
    window.addEventListener('open-scan-invite', handleScanInvite);
    return () => {
      disposed = true;
      disposeDynamicIce();
      disposeDirectBindings?.();
      disposeSyncWatchdog?.();
      disposeBlobCleanup?.();
      disposeKeepAwake?.();
      window.removeEventListener('open-new-dapp', handleNewDapp);
      window.removeEventListener('open-scan-invite', handleScanInvite);
    };
  }, []);

  const handleCreate = (name: string, icon: string, color: string) => {
    const id = createDapp(name, icon, color);
    setCreateDappOpen(false);
    // Stored before it is shown: a reload right after creating must not lose the document.
    void persistNewDapp(id).finally(() => { void navigate(`/dapp/${id}/code`); });
  };

  return (
    <TooltipProvider>
      <ErrorBoundary>
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route element={<AppShell identity={identity} onIdentityUpdate={setIdentity} />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/requests" element={<RequestsPage />} />
              <Route path="/people" element={<PeoplePage />} />
              <Route path="/invite" element={<InvitePage />} />
              <Route path="/share-target" element={<ShareTargetPage />} />
              <Route path="/open-file" element={<OpenFilePage />} />
              <Route path="/import" element={<SourceImportPage />} />
              <Route path="/dapp/:id" element={<DappPage />} />
              <Route path="/dapp/:id/app/*" element={<DappPage />} />
              <Route path="/dapp/:id/full/*" element={<DappPage />} />
              <Route path="/dapp/:id/code" element={<CodeAppEditorPage />} />
              <Route path="/dapp/:id/theme" element={<ThemePage />} />
              <Route path="/dapp/:id/files" element={<FilesPage />} />
              <Route path="/dapp/:id/share" element={<ShareInvitePage />} />
              <Route path="/dapp/:id/settings" element={<DappSettingsPage />} />
            </Route>
          </Routes>
        </Suspense>
      </ErrorBoundary>
      {createDappOpen && (
        <CreateDappModal onClose={() => setCreateDappOpen(false)} onCreate={handleCreate} />
      )}
      <SystemDialogs />
      {scanInviteOpen && (
        <ScannerModal
          onClose={() => setScanInviteOpen(false)}
          onScan={(result) => {
            setScanInviteOpen(false);
            // QR codes may carry a raw invite URI or the clickable https wrapper.
            // Every recognized invite lands on the same consent page.
            const uri = inviteUriFromText(result);
            if (uri) {
              void navigate(`/invite#code=${encodeURIComponent(uri)}`);
              return;
            }
            void showAlert('Invalid invite QR code', { title: 'Scan failed' });
          }}
        />
      )}
    </TooltipProvider>
  );
}
