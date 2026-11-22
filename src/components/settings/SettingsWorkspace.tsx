import { lazy, Suspense, useState, type ComponentType, type KeyboardEvent } from 'react';
import { Bell, Database, Fingerprint, Info, KeyRound, Link2, Radio, Settings, Users, X } from 'lucide-react';
import type { DeviceIdentity } from '@/types.ts';
import { Button } from '@/components/ui/button';
import { DialogClose } from '@/components/ui/dialog';
import SettingsPage from '@/pages/SettingsPage.tsx';
import SettingsSection from '@/components/settings/SettingsSection.tsx';
import { pushRelayUrl } from '@/services/pushNotifications.ts';
import { cn } from '@/lib/utils';

// These panels pull in the sharing/binding runtimes — heavy code most
// sessions never open Settings for. Loaded on demand.
const DirectBindingsSettings = lazy(() => import('@/components/settings/DirectBindingsSettings'));
const LocalDataSettings = lazy(() => import('@/components/settings/LocalDataSettings'));
const NotificationSettings = lazy(() => import('@/components/settings/NotificationSettings'));
const SignalingSettings = lazy(() => import('@/components/settings/SignalingSettings'));

interface SettingsWorkspaceProps {
  identity: DeviceIdentity;
  onIdentityUpdate: (identity: DeviceIdentity) => void;
}

type SettingsSectionId = 'bindings' | 'notifications' | 'identity' | 'backup' | 'signaling' | 'localData' | 'about';

interface SectionDef {
  id: SettingsSectionId;
  label: string;
  icon: typeof Users;
  /** Panel-only sections render inside a SettingsSection header; account sections render SettingsPage, which brings its own. */
  panel?: { title: string; description: string; component: ComponentType };
}

// What is shared with whom is NOT a setting: it lives with the app (Share & invite)
// and with the person (Contacts). Settings is about this device.
const sections: SectionDef[] = [
  { id: 'identity', label: 'Identity', icon: Fingerprint },
  {
    id: 'bindings', label: 'Code App Bindings', icon: Link2,
    panel: { title: 'Code App Bindings', description: 'Connect declared events and actions between local Code Apps.', component: DirectBindingsSettings },
  },
  // Without a configured relay the push feature does not exist on this deployment.
  ...(pushRelayUrl() ? [{
    id: 'notifications' as const, label: 'Notifications', icon: Bell,
    panel: { title: 'Notifications', description: 'Content-free wake-ups when a contact shares something with you.', component: NotificationSettings },
  }] : []),
  { id: 'backup', label: 'Restore a legacy identity', icon: KeyRound },
  {
    id: 'signaling', label: 'Signaling', icon: Radio,
    panel: {
      title: 'Signaling',
      description: 'Which signaling servers this device uses to find peers. Device-local, never synced.',
      component: SignalingSettings,
    },
  },
  {
    id: 'localData', label: 'Local Data', icon: Database,
    panel: { title: 'Local Data', description: 'Export everything this device stores, or wipe it for a clean start. Your identity always stays.', component: LocalDataSettings },
  },
  { id: 'about', label: 'About', icon: Info },
];

const tabBase = 'flex min-h-9 pointer-coarse:min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] font-medium transition-[background-color,color] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25';
const tabInactiveTone = 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground';
const tabActiveTone = (mobile: boolean) => mobile
  ? 'bg-sidebar-accent text-foreground'
  : 'bg-sidebar-accent text-foreground shadow-2xs';

export default function SettingsWorkspace({ identity, onIdentityUpdate }: SettingsWorkspaceProps) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('identity');
  const active = sections.find(({ id }) => id === activeSection);
  const activeLabel = active?.label ?? 'Settings';

  return (
    <div className="relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <SettingsHeader />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col sm:flex-row">
        <aside className="hidden w-[236px] shrink-0 flex-col border-r border-border/80 bg-sidebar sm:flex">
          <SettingsTabs activeSection={activeSection} onSelect={setActiveSection} variant="desktop" />
        </aside>

        <div className="flex min-w-0 shrink-0 flex-col overflow-hidden border-b border-border/80 bg-sidebar sm:hidden">
          <SettingsTabs activeSection={activeSection} onSelect={setActiveSection} variant="mobile" />
        </div>

        <div
          id="settings-panel"
          role="tabpanel"
          aria-label={`${activeLabel} settings`}
          tabIndex={0}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-background focus-visible:outline-none [&>*]:mx-auto [&>*]:max-w-5xl"
        >
          <Suspense fallback={<div className="p-8 text-sm text-muted-foreground">Loading…</div>}>
            {active?.panel ? (
              <SettingsSection icon={<active.icon className="h-5 w-5" aria-hidden="true" />} title={active.panel.title} description={active.panel.description}>
                <active.panel.component />
              </SettingsSection>
            ) : (
              <SettingsPage identity={identity} onUpdate={onIdentityUpdate} section={activeSection} />
            )}
          </Suspense>
        </div>
      </div>
    </div>
  );
}

function SettingsHeader() {
  return (
    <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-background px-4 sm:px-5">
      <div className="flex min-w-0 items-center gap-2.5">
        <Settings className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="truncate text-base font-semibold tracking-tight">Settings</span>
      </div>
      <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="Close settings" className="shrink-0 rounded-lg" />}>
        <X className="h-4 w-4" aria-hidden="true" />
      </DialogClose>
    </div>
  );
}

function SettingsTabs({ activeSection, onSelect, variant }: {
  activeSection: SettingsSectionId;
  onSelect: (section: SettingsSectionId) => void;
  variant: 'desktop' | 'mobile';
}) {
  const mobile = variant === 'mobile';
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const previousKey = mobile ? 'ArrowLeft' : 'ArrowUp';
    const nextKey = mobile ? 'ArrowRight' : 'ArrowDown';
    if (![previousKey, nextKey, 'Home', 'End'].includes(event.key)) return;

    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const currentIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (currentIndex < 0 || tabs.length === 0) return;

    event.preventDefault();
    let nextIndex = currentIndex;
    if (event.key === previousKey) nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === nextKey) nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    tabs[nextIndex]?.focus();
    tabs[nextIndex]?.click();
  };

  return (
    <nav
      role="tablist"
      aria-label="Settings sections"
      aria-orientation={mobile ? 'horizontal' : 'vertical'}
      onKeyDown={handleKeyDown}
      className={mobile
        ? 'flex min-w-0 gap-1 overflow-x-auto overscroll-x-contain px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
        : 'flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 py-3'}
    >
      {sections.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          id={`settings-tab-${variant}-${id}`}
          type="button"
          role="tab"
          aria-selected={activeSection === id}
          aria-controls="settings-panel"
          tabIndex={activeSection === id ? 0 : -1}
          className={cn(
            tabBase,
            mobile && 'h-10 min-h-10 w-auto shrink-0 gap-2 whitespace-nowrap px-3',
            activeSection === id ? tabActiveTone(mobile) : tabInactiveTone,
          )}
          onClick={() => onSelect(id)}
        >
          <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
