import { Suspense, lazy, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Check,
  ChevronRight,
  ChevronsUpDown,
  Code2,
  FolderOpen,
  Home,
  Inbox,
  LayoutDashboard,
  Link2,
  List,
  Maximize2,
  Menu,
  Moon,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Sun,
  UserPlus,
  Users,
  UsersRound,
} from 'lucide-react';
import { useCodeAppManifest, useDappConfig, useDappsList, useMyRole, usePeers } from '@/hooks/useYjs';
import { codeAppFullscreenRouteUrl, codeAppRouteUrl } from '@/services/codeAppManifest';
import {
  CODE_APP_HOST_SURFACE_CLOSED_EVENT,
  CODE_APP_HOST_SURFACE_EVENT,
  CODE_APP_RELATIONSHIP_SURFACE_EVENT,
  CODE_APP_RELATIONSHIP_SURFACE_RESOLVED_EVENT,
  type CodeAppHostSurfaceEventDetail,
  type CodeAppRelationshipSurfaceEventDetail,
  cancelledRelationshipSurfaceResult,
} from '@/services/codeAppRuntime';
import { useTheme } from '@/hooks/useTheme';
import { useI18n } from '@/i18n';
import StorageWarning from '@/components/StorageWarning';
import UpdateNotice from '@/components/UpdateNotice';
import ErrorBoundary from '@/components/ErrorBoundary';
import { useChannelSharingCatalog } from '@/hooks/useSharing.ts';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import SettingsWorkspace from '@/components/settings/SettingsWorkspace.tsx';
import CodeAppEditor from '@/components/code-app/CodeAppEditor.tsx';
import ContactPickerDialog from '@/components/sharing/ContactPickerDialog.tsx';
import ShareConsentDialog from '@/components/sharing/ShareConsentDialog.tsx';
import PairContactDialog from '@/components/sharing/PairContactDialog.tsx';
import { approvableAccessRequests, countAccessRequestsByDapp, usePairingRequests, useDappAccessRequests } from '@/hooks/useRequestsInbox.ts';
import { useGithubUpdate } from '@/hooks/useGithubUpdate.ts';
import type { CodeAppBindingDeclaration, DappContactHandle, DeviceIdentity } from '@/types.ts';

// The sync panel pulls in the WebRTC diagnostics and blob mesh; keep it out of the
// shell chunk until someone actually opens it.
const DappSyncPanel = lazy(() => import('@/components/DappSyncPanel.tsx'));

const SIDEBAR_COLLAPSED_KEY = 'shell:sidebar-collapsed';

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Private browsing / restricted storage — fall back to session state only.
  }
}

const navItemBase = 'group relative flex h-9 pointer-coarse:h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium transition-[background-color,color] duration-150 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25';
const navItemCollapsed = 'justify-center px-0';
// Active and inactive tones are mutually exclusive branches — never merged
// into one class string — so same-group utilities can't fight over cascade order.
const navItemTone = (active: boolean) => active
  ? 'bg-sidebar-accent text-sidebar-accent-foreground shadow-2xs'
  : 'text-sidebar-foreground/65 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground';

const sectionHeadingClass = 'mb-1 px-2.5 text-[11px] font-medium tracking-[0.02em] text-muted-foreground/80';

const codeRouteIcons = {
  code: Code2,
  home: Home,
  list: List,
  dashboard: LayoutDashboard,
  settings: Settings,
} as const;

function NavItem({ to, icon: Icon, label, onClick, ariaLabel, collapsed = false, badgeDot = false, children }: {
  to: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  ariaLabel?: string;
  collapsed?: boolean;
  badgeDot?: boolean;
  children?: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end
      onClick={onClick}
      aria-label={ariaLabel ?? (collapsed ? label : undefined)}
      title={collapsed ? label : undefined}
      className={({ isActive }) => cn(navItemBase, collapsed && navItemCollapsed, navItemTone(isActive))}
    >
      {({ isActive }) => (
        <>
          <Icon className={cn('h-4 w-4 shrink-0 transition-colors', isActive ? 'text-primary' : 'text-sidebar-foreground/55 group-hover:text-sidebar-foreground')} aria-hidden="true" />
          {!collapsed && <span className="truncate">{label}</span>}
          {!collapsed && children}
          {collapsed && badgeDot && (
            <span aria-hidden="true" className="absolute right-2 top-2 h-2 w-2 rounded-full bg-primary ring-2 ring-sidebar" />
          )}
        </>
      )}
    </NavLink>
  );
}

/** Pill shown at the right edge of a nav item: how many things wait for a decision there. */
function CountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span aria-hidden="true" className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-[11px] font-semibold tabular-nums text-primary">
      {count > 99 ? '99+' : count}
    </span>
  );
}

/** Apps listed in the Home sidebar before "All apps" takes over. */
const SIDEBAR_APP_LIMIT = 8;

function AppNavigation({
  collapsed = false,
  onNavigate,
  onOpenSettings,
  onOpenSync,
  requestCount,
  requestsByDapp,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
  onOpenSettings: () => void;
  onOpenSync: () => void;
  /** Everything waiting for a decision on this device (the Requests page lists the same items). */
  requestCount: number;
  /** Devices waiting for approval, per dapp id. */
  requestsByDapp: Record<string, number>;
}) {
  const { id } = useParams<{ id: string }>();
  const config = useDappConfig(id);
  const { manifest: codeAppManifest, error: manifestError } = useCodeAppManifest(id);
  const role = useMyRole(id);
  const peers = usePeers(id);
  const apps = useDappsList().filter((dapp) => !dapp.archivedAt);
  const waitingHere = id ? requestsByDapp[id] ?? 0 : 0;
  // Owner-only: the hook stays empty (and asks GitHub nothing) for every other role.
  const githubSource = useGithubUpdate(id);
  // One marker for both: an update to review, or a repository link someone re-pointed.
  const sourceUpdateAvailable = githubSource.updateAvailable || githubSource.sourceChanged;
  const { theme, setTheme } = useTheme();
  const { language, setLanguage, t } = useI18n();

  const closeAnd = (action?: () => void) => () => {
    action?.();
    onNavigate?.();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Brand header — matches the 48px height of the top bar for a crisp studio grid. */}
      <div className={cn('flex h-12 shrink-0 items-center border-b border-sidebar-border/80', collapsed ? 'justify-center px-2' : 'px-3.5')}>
        <Link
          to="/"
          onClick={closeAnd()}
          aria-label={collapsed ? 'Dapp Builder' : undefined}
          title={collapsed ? 'Dapp Builder' : undefined}
          className={cn('flex min-w-0 items-center gap-2.5 text-sidebar-foreground transition-opacity hover:opacity-85', collapsed && 'justify-center')}
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground shadow-2xs"
            aria-hidden="true"
          >
            ⬡
          </span>
          {!collapsed && (
            <span className="min-w-0 truncate text-sm font-semibold tracking-[-0.02em]">Dapp Builder</span>
          )}
        </Link>
      </div>

      {/* Main navigation scroll region */}
      <div className={cn('flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-3', collapsed ? 'px-2' : 'px-2.5')}>
        <nav aria-label="Global navigation" className="flex flex-col gap-0.5">
          {!collapsed && <p className={sectionHeadingClass}>{t('General')}</p>}
          <NavItem to="/" icon={Home} label={t('Home')} collapsed={collapsed} onClick={closeAnd()} />
          <NavItem
            to="/requests"
            icon={Inbox}
            label={t('Requests')}
            collapsed={collapsed}
            badgeDot={requestCount > 0}
            onClick={closeAnd()}
            ariaLabel={requestCount > 0
              ? `${t('Requests')}, ${requestCount} ${requestCount === 1 ? t('open request') : t('open requests')}`
              : undefined}
          >
            <CountBadge count={requestCount} />
          </NavItem>
          <NavItem to="/people" icon={UsersRound} label={t('Contacts')} collapsed={collapsed} onClick={closeAnd()} />
        </nav>

        <div className="border-t border-sidebar-border/70" />

        {config ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {/* The dapp card doubles as the entry to sync diagnostics and deletion —
                there is deliberately no separate "Sync" nav item. */}
            <button
              type="button"
              onClick={closeAnd(onOpenSync)}
              aria-label={`${config.meta.name}: ${t('Sync status & manage')}`}
              title={collapsed ? `${config.meta.name} · ${peers.length} ${t('connected')}` : undefined}
              className={cn(
                'group relative flex min-w-0 w-full cursor-pointer items-center rounded-xl border border-sidebar-border bg-card text-left transition-[border-color,background-color] hover:border-foreground/20 hover:bg-card/80 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25',
                collapsed ? 'justify-center p-1.5' : 'gap-2.5 px-2.5 py-2',
              )}
            >
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base"
                style={{ backgroundColor: `${config.meta.color}1a`, color: config.meta.color }}
                aria-hidden="true"
              >
                {config.meta.icon}
              </span>
              {!collapsed ? (
                <>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] font-semibold leading-tight text-foreground">{config.meta.name}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', peers.length > 0 ? 'bg-success' : 'bg-muted-foreground/40')} aria-hidden="true" />
                      <span className="truncate">{role ?? t('Connecting…')}</span>
                      <span aria-hidden="true">·</span>
                      <span className="flex items-center gap-1 whitespace-nowrap tabular-nums">
                        <Users className="h-3 w-3 shrink-0" aria-hidden="true" />
                        {peers.length} {t('connected')}
                      </span>
                    </span>
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden="true" />
                </>
              ) : (
                <span className="sr-only">{config.meta.name} · {peers.length} {t('connected')}</span>
              )}
            </button>

            <nav aria-label="Dapp navigation" className="flex flex-col gap-0.5">
              {!collapsed && <p className={sectionHeadingClass}>{t('Views')}</p>}
              {codeAppManifest.routes.filter((route) => !route.hidden).map((route) => (
                <NavItem
                  key={route.path}
                  to={codeAppRouteUrl(id ?? '', route.path)}
                  icon={codeRouteIcons[route.icon as keyof typeof codeRouteIcons] || Code2}
                  label={route.label}
                  collapsed={collapsed}
                  onClick={closeAnd()}
                />
              ))}
              {manifestError && !collapsed && (
                <p className="px-2.5 py-1.5 text-xs text-destructive">manifest.yaml: {manifestError}</p>
              )}
              {codeAppManifest.permissions?.host?.files === true && (
                <NavItem to={`/dapp/${id}/files`} icon={FolderOpen} label={t('Files')} collapsed={collapsed} onClick={closeAnd()} />
              )}

              {role === 'owner' && (
                <>
                  <div className="my-2.5 border-t border-sidebar-border/70" />
                  {!collapsed && <p className={sectionHeadingClass}>{t('Manage')}</p>}
                  <NavItem
                    to={`/dapp/${id}/share`}
                    icon={UserPlus}
                    label={t('Share & invite')}
                    collapsed={collapsed}
                    badgeDot={waitingHere > 0}
                    onClick={closeAnd()}
                    ariaLabel={waitingHere > 0
                      ? `${t('Share & invite')}, ${waitingHere} ${waitingHere === 1 ? t('device waiting') : t('devices waiting')}`
                      : undefined}
                  >
                    <CountBadge count={waitingHere} />
                  </NavItem>
                  <NavItem to={`/dapp/${id}/code`} icon={Code2} label={t('Code editor')} collapsed={collapsed} onClick={closeAnd()} />
                  <NavItem to={`/dapp/${id}/theme`} icon={Palette} label={t('Theme')} collapsed={collapsed} onClick={closeAnd()} />
                  <NavItem
                    to={`/dapp/${id}/settings`}
                    icon={Settings}
                    label={t('Dapp settings')}
                    collapsed={collapsed}
                    onClick={closeAnd()}
                    ariaLabel={sourceUpdateAvailable ? `${t('Dapp settings')}, ${t('source update available')}` : undefined}
                  >
                    {sourceUpdateAvailable && (
                      <span data-testid="dapp-settings-update-dot" aria-hidden="true" className="ml-auto h-2 w-2 shrink-0 rounded-full bg-destructive" />
                    )}
                  </NavItem>
                </>
              )}
            </nav>
          </div>
        ) : (
          // Outside a dapp the sidebar is the way INTO one: your apps (with the
          // devices waiting in each), a new app, and joining through a link.
          <nav aria-label={t('Your apps')} className="flex min-h-0 flex-1 flex-col gap-0.5">
            {!collapsed && <p className={sectionHeadingClass}>{t('Your apps')}</p>}
            {apps.slice(0, SIDEBAR_APP_LIMIT).map((dapp) => {
              const waiting = requestsByDapp[dapp.id] ?? 0;
              return (
                <Link
                  key={dapp.id}
                  to={`/dapp/${dapp.id}`}
                  onClick={closeAnd()}
                  aria-label={waiting > 0
                    ? `${dapp.name}, ${waiting} ${waiting === 1 ? t('device waiting') : t('devices waiting')}`
                    : collapsed ? dapp.name : undefined}
                  title={collapsed ? dapp.name : undefined}
                  className={cn(navItemBase, collapsed && navItemCollapsed, navItemTone(false))}
                >
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[13px]"
                    style={{ backgroundColor: `${dapp.color}1c`, color: dapp.color }}
                    aria-hidden="true"
                  >
                    {dapp.icon}
                  </span>
                  {!collapsed && <span className="truncate">{dapp.name}</span>}
                  {!collapsed && <CountBadge count={waiting} />}
                  {collapsed && waiting > 0 && (
                    <span aria-hidden="true" className="absolute right-2 top-2 h-2 w-2 rounded-full bg-primary ring-2 ring-sidebar" />
                  )}
                </Link>
              );
            })}
            {apps.length === 0 && !collapsed && (
              <p className="px-2.5 py-1 text-xs text-muted-foreground">{t('No apps yet.')}</p>
            )}
            {apps.length > SIDEBAR_APP_LIMIT && !collapsed && (
              <Link to="/" onClick={closeAnd()} className="px-2.5 py-1.5 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                {t('All apps')} ({apps.length})
              </Link>
            )}
            <div className="my-2 border-t border-sidebar-border/70" />
            <button
              type="button"
              title={collapsed ? t('New app') : undefined}
              className={cn(navItemBase, collapsed && navItemCollapsed, 'cursor-pointer', navItemTone(false))}
              onClick={closeAnd(() => window.dispatchEvent(new Event('open-new-dapp')))}
            >
              <Plus className="h-4 w-4 shrink-0 text-sidebar-foreground/55 group-hover:text-sidebar-foreground" aria-hidden="true" />
              <span className={collapsed ? 'sr-only' : undefined}>{t('New app')}</span>
            </button>
            <button
              type="button"
              title={collapsed ? t('Join with link') : undefined}
              className={cn(navItemBase, collapsed && navItemCollapsed, 'cursor-pointer', navItemTone(false))}
              onClick={closeAnd(() => window.dispatchEvent(new Event('open-scan-invite')))}
            >
              <Link2 className="h-4 w-4 shrink-0 text-sidebar-foreground/55 group-hover:text-sidebar-foreground" aria-hidden="true" />
              <span className={collapsed ? 'sr-only' : undefined}>{t('Join with link')}</span>
            </button>
          </nav>
        )}
      </div>

      {/* Compact studio utility footer: Settings + Theme + Language in one clean row */}
      <div className={cn('mt-auto shrink-0 border-t border-sidebar-border/80', collapsed ? 'flex flex-col items-center gap-1 p-2' : 'p-2.5')}>
        <div className={cn('flex items-center gap-1', collapsed && 'flex-col')}>
          <button
            type="button"
            className={cn(
              navItemBase,
              'cursor-pointer',
              collapsed ? navItemCollapsed : 'h-8 flex-1 px-2.5',
              navItemTone(false),
            )}
            onClick={closeAnd(onOpenSettings)}
            aria-label={t('Settings')}
            title={collapsed ? t('Settings') : undefined}
          >
            <Settings className="h-4 w-4 shrink-0 text-sidebar-foreground/55 group-hover:text-sidebar-foreground" aria-hidden="true" />
            <span className={collapsed ? 'sr-only' : undefined}>{t('Settings')}</span>
          </button>

          <button
            type="button"
            title={theme === 'dark' ? t('Light mode') : t('Dark mode')}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-sidebar-foreground/65 transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25"
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
            <span className="sr-only">{theme === 'dark' ? t('Light mode') : t('Dark mode')}</span>
          </button>

          <button
            type="button"
            title={language === 'de' ? 'English' : 'Deutsch'}
            onClick={() => setLanguage(language === 'de' ? 'en' : 'de')}
            className="flex h-8 min-w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg px-1.5 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/65 transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25"
          >
            <span aria-hidden="true">{language === 'de' ? 'EN' : 'DE'}</span>
            <span className="sr-only">{language === 'de' ? 'English' : 'Deutsch'}</span>
          </button>
        </div>

        {/* Legal pages stay reachable from the whole app. */}
        {!collapsed && (
          <div className="mt-2 flex items-center gap-3 px-2.5 text-[11px] text-muted-foreground/65">
            <a href="/privacy.html" className="text-muted-foreground/65 hover:text-foreground hover:underline">{t('Privacy')}</a>
            <a href="/terms.html" className="text-muted-foreground/65 hover:text-foreground hover:underline">{t('Terms')}</a>
          </div>
        )}
      </div>
    </div>
  );
}

interface AppShellProps {
  identity: DeviceIdentity;
  onIdentityUpdate: (identity: DeviceIdentity) => void;
}

export default function AppShell({ identity, onIdentityUpdate }: AppShellProps) {
  const [open, setOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(readSidebarCollapsed);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [codeEditorOpen, setCodeEditorOpen] = useState(false);
  const [codeEditorInitialFile, setCodeEditorInitialFile] = useState<string | undefined>(undefined);
  const [relationshipSurface, setRelationshipSurface] = useState<CodeAppRelationshipSurfaceEventDetail | null>(null);
  const [invitePickerOpen, setInvitePickerOpen] = useState(false);
  const [pairContactOpen, setPairContactOpen] = useState(false);
  const relationshipSurfaceRef = useRef<CodeAppRelationshipSurfaceEventDetail | null>(null);
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const config = useDappConfig(id);
  const { manifest: codeAppManifest } = useCodeAppManifest(id);
  const allDapps = useDappsList();
  const activeApps = allDapps.filter((dapp) => !dapp.archivedAt);
  const dappItem = allDapps.find((dapp) => dapp.id === id);
  const peers = usePeers(id);
  // Same rule as the Home cards: only devices that joined through an invite can leave.
  const canLeave = dappItem?.joinMethod === 'lobby' || dappItem?.joinMethod === 'direct';
  const { pendingInvites } = useChannelSharingCatalog();
  const pairingRequests = usePairingRequests();
  const accessRequests = useDappAccessRequests();
  // Same rule as the Requests page: devices a 1-step invite admits on its own need nobody's decision.
  const requestCount = pendingInvites.length + pairingRequests.length + approvableAccessRequests(accessRequests).length;
  const requestsByDapp = countAccessRequestsByDapp(accessRequests);
  const dappPrimary = config?.theme?.primary;
  const dappRadius = config?.theme?.radius;
  const { t } = useI18n();

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      writeSidebarCollapsed(next);
      return next;
    });
  };

  // Requests from Code App code ($ui.openSettings/$ui.openCodeEditor) arrive as a window
  // CustomEvent — see docs/code-apps/README.md's "$ui" section — rather than threaded
  // through the router, since the runtime lives under DappPage but these dialogs live here.
  const hostSurfaceRequestIdRef = useRef<string | null>(null);
  const closeHostSurfaceRequest = () => {
    if (!hostSurfaceRequestIdRef.current) return;
    window.dispatchEvent(new CustomEvent(CODE_APP_HOST_SURFACE_CLOSED_EVENT, {
      detail: { requestId: hostSurfaceRequestIdRef.current },
    }));
    hostSurfaceRequestIdRef.current = null;
  };

  useEffect(() => {
    const handleHostSurface = (event: Event) => {
      const detail = (event as CustomEvent<CodeAppHostSurfaceEventDetail>).detail;
      if (!detail || detail.dappId !== id) return; // Stale request from a dapp no longer showing; its own unmount resolves it.
      hostSurfaceRequestIdRef.current = detail.requestId;
      if (detail.surface === 'settings') {
        setSettingsOpen(true);
      } else if (detail.surface === 'codeEditor') {
        setCodeEditorInitialFile(typeof detail.params.file === 'string' ? detail.params.file : undefined);
        setCodeEditorOpen(true);
      }
    };
    window.addEventListener(CODE_APP_HOST_SURFACE_EVENT, handleHostSurface);
    return () => window.removeEventListener(CODE_APP_HOST_SURFACE_EVENT, handleHostSurface);
  }, [id]);

  const resolveRelationshipSurface = (request: CodeAppRelationshipSurfaceEventDetail, result: unknown) => {
    window.dispatchEvent(new CustomEvent(CODE_APP_RELATIONSHIP_SURFACE_RESOLVED_EVENT, {
      detail: { requestId: request.requestId, result },
    }));
    if (relationshipSurfaceRef.current?.requestId === request.requestId) {
      relationshipSurfaceRef.current = null;
      setRelationshipSurface(null);
      setInvitePickerOpen(false);
    }
  };

  useEffect(() => {
    const handleRelationshipSurface = (event: Event) => {
      const detail = (event as CustomEvent<CodeAppRelationshipSurfaceEventDetail>).detail;
      if (!detail || detail.dappId !== id) return;
      if (relationshipSurfaceRef.current) {
        window.dispatchEvent(new CustomEvent(CODE_APP_RELATIONSHIP_SURFACE_RESOLVED_EVENT, {
          detail: { requestId: detail.requestId, result: cancelledRelationshipSurfaceResult(detail.surface) },
        }));
        return;
      }
      if (detail.surface === 'contactInvite') {
        // "Add contact" first; once that dialog closes the picker lets the app's
        // user choose the (new) contact. It used to open Settings, which has no
        // pairing UI at all — a dead end.
        relationshipSurfaceRef.current = detail;
        setRelationshipSurface(detail);
        setInvitePickerOpen(false);
        setPairContactOpen(true);
        return;
      }
      relationshipSurfaceRef.current = detail;
      setRelationshipSurface(detail);
    };
    window.addEventListener(CODE_APP_RELATIONSHIP_SURFACE_EVENT, handleRelationshipSurface);
    return () => window.removeEventListener(CODE_APP_RELATIONSHIP_SURFACE_EVENT, handleRelationshipSurface);
  }, [id]);

  // Fullscreen chrome is presentation only, derived purely from the /full URL family —
  // see docs/code-apps/README.md's "App display and chrome" section.
  const fullPrefix = id ? `/dapp/${id}/full` : null;
  const appPrefix = id ? `/dapp/${id}/app` : null;
  const chromeHidden = Boolean(fullPrefix) && (location.pathname === fullPrefix || location.pathname.startsWith(`${fullPrefix}/`));
  const onStandardAppRoute = Boolean(appPrefix) && (location.pathname === appPrefix || location.pathname.startsWith(`${appPrefix}/`));
  const standardChromeUrl = chromeHidden && fullPrefix
    ? `/dapp/${id}/app${location.pathname.slice(fullPrefix.length)}${location.search}`
    : null;
  const fullscreenUrl = onStandardAppRoute && id && appPrefix
    ? `${codeAppFullscreenRouteUrl(id, location.pathname.slice(appPrefix.length) || '/')}${location.search}`
    : null;
  // The manifest may opt out of the corner button (display.frameButton: false); the
  // /app URL family still works, so this is presentation only, never a lock-in.
  const frameButtonVisible = codeAppManifest.display?.frameButton !== false;

  // Contextual sub-section label shown in the top breadcrumb bar.
  const dappSubLabel = (() => {
    if (!id) return null;
    const base = `/dapp/${id}`;
    if (location.pathname === `${base}/share`) return t('Share & invite');
    if (location.pathname === `${base}/code`) return t('Code editor');
    if (location.pathname === `${base}/theme`) return t('Theme');
    if (location.pathname === `${base}/files`) return t('Files');
    if (location.pathname === `${base}/settings`) return t('Dapp settings');
    if (onStandardAppRoute && appPrefix) {
      const routePath = location.pathname.slice(appPrefix.length) || '/';
      const match = codeAppManifest.routes.find((route) => route.path === routePath && !route.hidden);
      if (match && codeAppManifest.routes.filter((route) => !route.hidden).length > 1) return match.label;
    }
    return null;
  })();

  const topLevelTitle = (() => {
    if (location.pathname === '/') return t('Your apps');
    if (location.pathname === '/requests') return t('Requests');
    if (location.pathname === '/people') return t('Contacts');
    if (location.pathname === '/invite') return t('Join with link');
    if (location.pathname === '/import') return t('Import');
    if (location.pathname === '/open-file') return t('Open a .dapp file');
    if (location.pathname === '/share-target') return t('Share with a dapp');
    return 'Dapp Builder';
  })();

  useEffect(() => {
    if (!id || !dappPrimary) return;

    const root = document.documentElement;
    const themeVariables: Record<string, string> = {
      '--primary': dappPrimary,
      '--ring': dappPrimary,
      '--sidebar-primary': dappPrimary,
      '--sidebar-ring': dappPrimary,
      '--chart-1': dappPrimary,
      // Companion surface tokens: neutral tint + mode-following foreground.
      // The dapp theme color is drawn ONLY as focused accents — saturated
      // theme-colored text on tinted pills reads badly.
      '--accent': 'color-mix(in oklab, var(--foreground) 7%, transparent)',
      '--accent-foreground': 'var(--foreground)',
      '--sidebar-accent': 'color-mix(in oklab, var(--foreground) 8%, transparent)',
      '--sidebar-accent-foreground': 'var(--foreground)',
      '--radius': dappRadius || '0.625rem',
    };
    const previousValues = new Map(
      Object.keys(themeVariables).map((name) => [name, root.style.getPropertyValue(name)])
    );

    Object.entries(themeVariables).forEach(([name, value]) => {
      root.style.setProperty(name, value);
    });

    return () => {
      previousValues.forEach((value, name) => {
        if (value) root.style.setProperty(name, value);
        else root.style.removeProperty(name);
      });
    };
  }, [id, dappPrimary, dappRadius]);

  return (
    // The shell is viewport-locked and <main> is the one scroll container, so
    // the sidebar and top bar stay put on every page (html/body overflow-x:hidden
    // made position:sticky unreliable when the document itself scrolled).
    <div className="flex h-dvh w-full overflow-hidden bg-background">
      {!chromeHidden && (
        <>
          {/* Desktop collapsible sidebar */}
          <aside
            className={cn(
              'hidden shrink-0 border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-out lg:block lg:h-full',
              sidebarCollapsed ? 'lg:w-[60px]' : 'lg:w-[244px]',
            )}
          >
            <AppNavigation
              collapsed={sidebarCollapsed}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenSync={() => setSyncOpen(true)}
              requestCount={requestCount}
              requestsByDapp={requestsByDapp}
            />
          </aside>

          {/* Mobile slide-over drawer (triggered from the top header bar) */}
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent side="left" className="w-[272px] border-sidebar-border bg-sidebar p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>{t('Navigation')}</SheetTitle>
                <SheetDescription>{t('App navigation and dapp management')}</SheetDescription>
              </SheetHeader>
              <AppNavigation
                onNavigate={() => setOpen(false)}
                onOpenSettings={() => setSettingsOpen(true)}
                onOpenSync={() => setSyncOpen(true)}
                requestCount={requestCount}
                requestsByDapp={requestsByDapp}
              />
            </SheetContent>

            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {/* Unified top context bar: mobile menu trigger, desktop sidebar toggle, quick app switcher & status */}
              <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/80 bg-background/90 px-3 backdrop-blur-md lg:px-4">
                <div className="flex min-w-0 items-center gap-2">
                  <SheetTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="relative lg:hidden"
                        aria-label={t('Open navigation')}
                      >
                        <Menu className="h-4 w-4" aria-hidden="true" />
                        {requestCount > 0 && (
                          <span aria-hidden="true" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary" />
                        )}
                      </Button>
                    }
                  />

                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="hidden lg:inline-flex"
                    onClick={toggleSidebarCollapsed}
                    aria-label={sidebarCollapsed ? t('Expand sidebar') : t('Collapse sidebar')}
                    title={sidebarCollapsed ? t('Expand sidebar') : t('Collapse sidebar')}
                  >
                    {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" aria-hidden="true" /> : <PanelLeftClose className="h-4 w-4" aria-hidden="true" />}
                  </Button>

                  <span className="h-4 w-px shrink-0 bg-border/80" aria-hidden="true" />

                  {id && config ? (
                    <div className="flex min-w-0 items-center gap-1.5 text-sm">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={t('Switch app')}
                              className="h-8 max-w-[200px] gap-2 px-2 font-medium text-foreground sm:max-w-[260px]"
                            />
                          }
                        >
                          <span
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-xs"
                            style={{ backgroundColor: `${config.meta.color}1c`, color: config.meta.color }}
                            aria-hidden="true"
                          >
                            {config.meta.icon}
                          </span>
                          <span className="truncate">{config.meta.name}</span>
                          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-60">
                          {activeApps.map((app) => {
                            const waiting = requestsByDapp[app.id] ?? 0;
                            const isCurrent = app.id === id;
                            return (
                              <DropdownMenuItem
                                key={app.id}
                                onClick={() => { void navigate(`/dapp/${app.id}`); }}
                                className="gap-2.5"
                              >
                                <span
                                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-xs"
                                  style={{ backgroundColor: `${app.color}1c`, color: app.color }}
                                  aria-hidden="true"
                                >
                                  {app.icon}
                                </span>
                                <span className="min-w-0 flex-1 truncate">{app.name}</span>
                                {waiting > 0 && (
                                  <span className="rounded-full bg-primary/15 px-1.5 text-[11px] font-semibold tabular-nums text-primary">{waiting}</span>
                                )}
                                {isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />}
                              </DropdownMenuItem>
                            );
                          })}
                          {activeApps.length > 0 && <DropdownMenuSeparator />}
                          <DropdownMenuItem onClick={() => { void navigate('/'); }}>
                            <Home className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                            <span>{t('All apps')}</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => window.dispatchEvent(new Event('open-new-dapp'))}>
                            <Plus className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                            <span>{t('New app')}</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => window.dispatchEvent(new Event('open-scan-invite'))}>
                            <Link2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                            <span>{t('Join with link')}</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>

                      {dappSubLabel && (
                        <>
                          <span className="text-muted-foreground/50" aria-hidden="true">/</span>
                          <span className="truncate text-sm text-muted-foreground">{dappSubLabel}</span>
                        </>
                      )}
                    </div>
                  ) : (
                    <span className="truncate text-sm font-medium text-foreground">{topLevelTitle}</span>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {id && config && (
                    <>
                      <button
                        type="button"
                        onClick={() => setSyncOpen(true)}
                        title={t('Sync status & manage')}
                        className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25"
                      >
                        <span
                          className={cn('h-1.5 w-1.5 rounded-full', peers.length > 0 ? 'bg-success' : 'bg-muted-foreground/45')}
                          aria-hidden="true"
                        />
                        <span className="tabular-nums">{peers.length}</span>
                        <span className="hidden sm:inline">{t('connected')}</span>
                      </button>

                      {fullscreenUrl && (
                        <Link
                          to={fullscreenUrl}
                          aria-label={t('Fullscreen')}
                          title={t('Fullscreen')}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25"
                        >
                          <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </Link>
                      )}
                    </>
                  )}
                </div>
              </header>

              <main className="min-w-0 flex-1 overflow-auto">
                <StorageWarning />
                <UpdateNotice />
                {/* A page that fails keeps the sidebar, and leaving the page clears the error. */}
                <ErrorBoundary resetKey={location.pathname}>
                  <Outlet />
                </ErrorBoundary>
              </main>
            </div>
          </Sheet>
        </>
      )}

      {chromeHidden && (
        <main className="min-w-0 flex-1 overflow-auto">
          <StorageWarning />
          <UpdateNotice />
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      )}

      {chromeHidden && standardChromeUrl && frameButtonVisible && (
        <Link
          to={standardChromeUrl}
          aria-label={t('Show app framework')}
          className="fixed right-3 top-3 z-50 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card/90 text-muted-foreground shadow-md backdrop-blur-sm transition-colors hover:bg-card hover:text-foreground"
        >
          <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
        </Link>
      )}

      <Dialog
        open={settingsOpen}
        onOpenChange={(nextOpen) => {
          setSettingsOpen(nextOpen);
          if (!nextOpen) closeHostSurfaceRequest();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="bottom-2 left-2 right-2 top-2 h-auto min-w-0 max-h-none w-auto max-w-none translate-x-0 translate-y-0 gap-0 overflow-y-hidden rounded-xl bg-background p-0 shadow-2xl sm:bottom-auto sm:left-1/2 sm:right-auto sm:top-1/2 sm:h-[min(720px,calc(100dvh-2rem))] sm:w-[min(960px,calc(100vw-2rem))] sm:max-w-none sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t('Settings')}</DialogTitle>
            <DialogDescription>{t('Code App bindings, device identity, local data, and application information.')}</DialogDescription>
          </DialogHeader>
          <SettingsWorkspace identity={identity} onIdentityUpdate={onIdentityUpdate} />
        </DialogContent>
      </Dialog>

      {id && config && (
        <Dialog open={syncOpen} onOpenChange={setSyncOpen}>
          <DialogContent
            className="flex h-[calc(100dvh-1rem)] max-h-[860px] w-[calc(100vw-1rem)] max-w-none flex-col gap-0 overflow-y-hidden rounded-xl p-0 sm:h-[min(84dvh,860px)] sm:w-[min(1100px,calc(100vw-2rem))] sm:max-w-[1100px] sm:rounded-2xl"
          >
            <DialogHeader className="sr-only">
              <DialogTitle>{config.meta.name}: {t('Sync status & manage')}</DialogTitle>
              <DialogDescription>{t('Live sync diagnostics for this dapp, plus leaving it or deleting it from this device.')}</DialogDescription>
            </DialogHeader>
            <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">{t('Loading…')}</div>}>
              <DappSyncPanel
                dappId={id}
                canLeave={canLeave}
                onExit={() => {
                  setSyncOpen(false);
                  void navigate('/');
                }}
              />
            </Suspense>
          </DialogContent>
        </Dialog>
      )}

      {id && (
        <Dialog
          open={codeEditorOpen}
          onOpenChange={(nextOpen) => {
            setCodeEditorOpen(nextOpen);
            if (!nextOpen) closeHostSurfaceRequest();
          }}
        >
          <DialogContent
            className="h-[calc(100dvh-1rem)] max-h-[900px] w-[calc(100vw-1rem)] max-w-none overflow-y-hidden rounded-xl p-4 sm:h-[min(88dvh,900px)] sm:w-[min(1180px,calc(100vw-2rem))] sm:max-w-[1180px] sm:rounded-2xl"
          >
            <DialogHeader className="sr-only">
              <DialogTitle>Code editor</DialogTitle>
              <DialogDescription>Edit this Code App's source files.</DialogDescription>
            </DialogHeader>
            <CodeAppEditor dappId={id} initialFile={codeEditorInitialFile} />
          </DialogContent>
        </Dialog>
      )}

      <PairContactDialog
        open={pairContactOpen}
        onOpenChange={(nextOpen) => {
          setPairContactOpen(nextOpen);
          // Whether or not someone was paired: let the app's user pick (or cancel) next.
          if (!nextOpen && relationshipSurfaceRef.current?.surface === 'contactInvite') setInvitePickerOpen(true);
        }}
      />

      {relationshipSurface?.surface === 'contactPicker' && (
        <ContactPickerDialog
          open
          dappId={relationshipSurface.dappId}
          label={typeof relationshipSurface.params.label === 'string' ? relationshipSurface.params.label : undefined}
          min={typeof relationshipSurface.params.min === 'number' ? relationshipSurface.params.min : 0}
          max={typeof relationshipSurface.params.max === 'number' ? relationshipSurface.params.max : 16}
          onResolve={(contacts) => resolveRelationshipSurface(relationshipSurface, contacts)}
        />
      )}

      {relationshipSurface?.surface === 'contactInvite' && invitePickerOpen && (
        <ContactPickerDialog
          open
          dappId={relationshipSurface.dappId}
          label={t('Choose the newly paired contact')}
          min={0}
          max={1}
          onResolve={(contacts) => resolveRelationshipSurface(relationshipSurface, contacts[0] ?? null)}
        />
      )}

      {relationshipSurface?.surface === 'shareConsent' && (
        <ShareConsentDialog
          open
          appName={config?.meta.name || t('This Code App')}
          shareLabel={typeof relationshipSurface.params.shareLabel === 'string' ? relationshipSurface.params.shareLabel : t('this share')}
          contacts={Array.isArray(relationshipSurface.params.contacts) ? relationshipSurface.params.contacts as DappContactHandle[] : []}
          events={Array.isArray(relationshipSurface.params.events) ? relationshipSurface.params.events.filter(Boolean) as CodeAppBindingDeclaration[] : []}
          actions={Array.isArray(relationshipSurface.params.actions) ? relationshipSurface.params.actions.filter(Boolean) as CodeAppBindingDeclaration[] : []}
          onResolve={(result) => resolveRelationshipSurface(relationshipSurface, result)}
        />
      )}
    </div>
  );
}
