// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DappConfig, DappListItem, DeviceIdentity } from '../types.ts';
import { must } from './helpers/must.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({
  manifest: { routes: [] as Array<{ path: string; label: string; icon?: string; hidden?: boolean }>, display: undefined as { chrome?: 'standard' | 'fullscreen'; frameButton?: boolean } | undefined },
  manifestError: null as string | null,
  config: undefined as DappConfig | undefined,
  role: undefined as 'owner' | 'editor' | 'viewer' | undefined,
  dapps: [] as DappListItem[],
  sourceUpdateAvailable: false,
  accessRequests: [] as Array<{ dappId: string; autoApprove: boolean }>,
}));

vi.mock('../hooks/useYjs.ts', () => ({
  useCodeAppManifest: () => ({ manifest: mocks.manifest, error: mocks.manifestError }),
  useDappConfig: () => mocks.config,
  useMyRole: () => mocks.role,
  useDappsList: () => mocks.dapps,
  usePeers: () => [],
}));

vi.mock('../hooks/useTheme.tsx', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}));

vi.mock('../hooks/useSharing.ts', () => ({
  useChannelSharingCatalog: () => ({ pendingInvites: [], shares: [] }),
}));

vi.mock('../hooks/useRequestsInbox.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useRequestsInbox.ts')>();
  return {
    // The counting helpers are the real ones — the badge must agree with the Requests page.
    approvableAccessRequests: actual.approvableAccessRequests,
    countAccessRequestsByDapp: actual.countAccessRequestsByDapp,
    usePairingRequests: () => [],
    useDappAccessRequests: () => mocks.accessRequests,
  };
});

vi.mock('../components/sharing/PairContactDialog.tsx', () => ({ default: () => null }));

vi.mock('../hooks/useGithubUpdate.ts', () => ({
  useGithubUpdate: () => ({ origin: null, check: null, updateAvailable: mocks.sourceUpdateAvailable }),
}));

vi.mock('../components/settings/SettingsWorkspace.tsx', () => ({
  default: () => <div>Unified settings workspace</div>,
}));

vi.mock('../components/DappSyncPanel.tsx', () => ({
  default: ({ dappId, canLeave }: { dappId: string; canLeave?: boolean }) => (
    <div>Sync panel for {dappId}{canLeave ? ' (can leave)' : ' (cannot leave)'}</div>
  ),
}));

import AppShell from '../components/AppShell.tsx';

const identity: DeviceIdentity = {
  displayName: 'Test User',
  publicKey: 'public-key',
  privateKey: 'private-key',
  deviceId: 'device-id',
};

const codeAppConfig = {
  meta: { name: 'Game', icon: '🎮', color: '#7c6aff', createdAt: '', createdBy: '' },
  schema: { entities: [] },
};

describe('AppShell utility dialogs', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.manifest = { routes: [], display: undefined };
    mocks.manifestError = null;
    mocks.config = undefined;
    mocks.role = undefined;
    mocks.dapps = [];
    mocks.accessRequests = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('fills the Home sidebar with the apps, a new-app action and the one join action', () => {
    mocks.dapps = [
      { id: 'a1', name: 'Shopping', icon: '🛒', color: '#ff0000' },
      { id: 'a2', name: 'Left app', icon: '📦', color: '#00ff00', archivedAt: '2026-01-01T00:00:00.000Z' },
    ] as DappListItem[];
    mocks.accessRequests = [
      { dappId: 'a1', autoApprove: false },
      { dappId: 'a1', autoApprove: true }, // a 1-step invite admits this one by itself — not counted
    ];
    const events: string[] = [];
    const record = (event: Event) => events.push(event.type);
    window.addEventListener('open-new-dapp', record);
    window.addEventListener('open-scan-invite', record);

    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/']}>
          <AppShell identity={identity} onIdentityUpdate={vi.fn()} />
        </MemoryRouter>,
      );
    });

    const apps = container.querySelector('nav[aria-label="Your apps"]');
    const appLink = apps?.querySelector<HTMLAnchorElement>('a[href="/dapp/a1"]');
    expect(appLink?.textContent).toContain('Shopping');
    expect(appLink?.getAttribute('aria-label')).toBe('Shopping, 1 device waiting');
    expect(apps?.querySelector('a[href="/dapp/a2"]')).toBeNull(); // left apps stay on the Home page

    // The Requests badge counts the same single approvable device.
    expect(container.querySelector('a[href="/requests"]')?.getAttribute('aria-label')).toBe('Requests, 1 open request');

    const buttons = Array.from(apps?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    act(() => buttons.find((button) => button.textContent?.trim() === 'New app')?.click());
    act(() => buttons.find((button) => button.textContent?.trim() === 'Join with link')?.click());
    expect(events).toEqual(['open-new-dapp', 'open-scan-invite']);
    window.removeEventListener('open-new-dapp', record);
    window.removeEventListener('open-scan-invite', record);
  });

  it('keeps one Settings action at the bottom, links Requests and Contacts below Home, and opens the unified workspace', () => {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/']}>
          <AppShell identity={identity} onIdentityUpdate={vi.fn()} />
        </MemoryRouter>,
      );
    });

    expect(container.querySelector('a[href="/shared"]')).toBeNull();
    expect(container.querySelector('a[href="/settings"]')).toBeNull();

    // The one inbox and the contacts live in the sidebar, directly below Home.
    const homeLink = container.querySelector<HTMLAnchorElement>('a[href="/"]');
    const requestsLink = container.querySelector<HTMLAnchorElement>('a[href="/requests"]');
    const peopleLink = container.querySelector<HTMLAnchorElement>('a[href="/people"]');
    expect(homeLink).not.toBeNull();
    expect(requestsLink).not.toBeNull();
    expect(peopleLink).not.toBeNull();
    expect(must(homeLink).compareDocumentPosition(must(requestsLink)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(must(requestsLink).compareDocumentPosition(must(peopleLink)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(must(requestsLink).textContent?.trim()).toBe('Requests');
    expect(must(peopleLink).textContent?.trim()).toBe('Contacts');

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
    const settingsButton = buttons.find((button) => button.textContent?.trim() === 'Settings');
    const themeButton = buttons.find((button) => button.textContent?.includes('Light mode'));
    if (!settingsButton || !themeButton) {
      throw new Error('Expected the Settings and theme controls');
    }

    expect(settingsButton.compareDocumentPosition(themeButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    act(() => settingsButton.click());

    const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
    expect(dialog?.textContent).toContain('Unified settings workspace');
    expect(dialog?.className).toContain('bottom-2');
    expect(dialog?.className).toContain('left-2');
    expect(dialog?.className).toContain('right-2');
    expect(dialog?.className).toContain('top-2');
    expect(dialog?.className).toContain('translate-x-0');
    expect(dialog?.className).toContain('sm:left-1/2');
    expect(dialog?.className).toContain('sm:-translate-x-1/2');
    expect(dialog?.className).toContain('sm:rounded-2xl');
  });
});

describe('AppShell hidden routes and fullscreen chrome', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.config = codeAppConfig;
    mocks.role = 'owner';
    mocks.manifest = {
      routes: [
        { path: '/', label: 'Overview', icon: 'home' },
        { path: '/secret', label: 'Secret Ops', icon: 'list', hidden: true },
      ],
      display: undefined,
    };
    mocks.manifestError = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('marks Dapp settings with a red dot while a GitHub source update is waiting for the owner', () => {
    const renderShell = () => act(() => {
      root.render(
        <MemoryRouter initialEntries={['/dapp/game-app/app']}>
          <Routes>
            <Route path="/dapp/:id/*" element={<AppShell identity={identity} onIdentityUpdate={vi.fn()} />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    const settingsLink = () => must(container.querySelector<HTMLAnchorElement>('a[href="/dapp/game-app/settings"]'));

    renderShell();
    expect(settingsLink().querySelector('[data-testid="dapp-settings-update-dot"]')).toBeNull();

    mocks.sourceUpdateAvailable = true;
    try {
      renderShell();
      expect(settingsLink().querySelector('[data-testid="dapp-settings-update-dot"]')).not.toBeNull();
      expect(settingsLink().getAttribute('aria-label')).toBe('Dapp settings, source update available');
    } finally {
      mocks.sourceUpdateAvailable = false;
    }
  });

  it('places Theme between Code editor and Dapp settings in the owner nav', () => {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/dapp/game-app/app']}>
          <Routes>
            <Route path="/dapp/:id/*" element={<AppShell identity={identity} onIdentityUpdate={vi.fn()} />} />
          </Routes>
        </MemoryRouter>,
      );
    });

    const codeLink = container.querySelector<HTMLAnchorElement>('a[href="/dapp/game-app/code"]');
    const themeLink = container.querySelector<HTMLAnchorElement>('a[href="/dapp/game-app/theme"]');
    const settingsLink = container.querySelector<HTMLAnchorElement>('a[href="/dapp/game-app/settings"]');
    expect(codeLink).not.toBeNull();
    expect(themeLink).not.toBeNull();
    expect(settingsLink).not.toBeNull();
    expect(must(themeLink).textContent?.trim()).toBe('Theme');
    expect(must(codeLink).compareDocumentPosition(must(themeLink)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(must(themeLink).compareDocumentPosition(must(settingsLink)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opens sync status from the dapp card instead of a separate Sync nav entry', async () => {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/dapp/game-app/app']}>
          <Routes>
            <Route path="/dapp/:id/*" element={<AppShell identity={identity} onIdentityUpdate={vi.fn()} />} />
          </Routes>
        </MemoryRouter>,
      );
    });

    expect(container.querySelector('a[href="/dapp/game-app/sync"]')).toBeNull();

    const card = container.querySelector<HTMLButtonElement>('button[aria-label="Game: Sync status & manage"]');
    if (!card) throw new Error('Expected the dapp card to be a button');
    expect(card.textContent).toContain('Game');
    expect(card.textContent).toContain('0 connected');

    act(() => card.click());
    // React.lazy resolves on a microtask; flush it before reading the dialog.
    await act(async () => { await Promise.resolve(); });

    const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
    expect(dialog?.textContent).toContain('Sync panel for game-app');
    // Not in the catalog as a joined member → no leave action offered.
    expect(dialog?.textContent).toContain('(cannot leave)');
  });

  it('offers Leave in the sync dialog only to devices that joined through an invite', async () => {
    mocks.dapps = [{ id: 'game-app', name: 'Game', icon: '🎮', color: '#000000', role: 'editor', joinMethod: 'lobby', sortOrder: 0 } as DappListItem];
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/dapp/game-app/app']}>
          <Routes>
            <Route path="/dapp/:id/*" element={<AppShell identity={identity} onIdentityUpdate={vi.fn()} />} />
          </Routes>
        </MemoryRouter>,
      );
    });

    const card = container.querySelector<HTMLButtonElement>('button[aria-label="Game: Sync status & manage"]');
    if (!card) throw new Error('Expected the dapp card to be a button');
    act(() => card.click());
    await act(async () => { await Promise.resolve(); });

    const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
    expect(dialog?.textContent).toContain('Sync panel for game-app (can leave)');
    mocks.dapps = [];
  });

  it('omits a hidden route from the sidebar while the visible route still renders', () => {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/dapp/game-app/app']}>
          <Routes>
            <Route path="/dapp/:id/*" element={<AppShell identity={identity} onIdentityUpdate={vi.fn()} />} />
          </Routes>
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain('Overview');
    expect(container.textContent).not.toContain('Secret Ops');
    expect(container.querySelector('a[href="/dapp/game-app/app/secret"]')).toBeNull();
  });

  it('renders no sidebar on a /full URL and shows an escape link back to the equivalent /app URL', () => {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/dapp/game-app/full/secret?x=1']}>
          <Routes>
            <Route path="/dapp/:id/*" element={<AppShell identity={identity} onIdentityUpdate={vi.fn()} />} />
          </Routes>
        </MemoryRouter>,
      );
    });

    expect(container.querySelector('aside')).toBeNull();
    expect(container.querySelector('button[aria-label="Open navigation"]')).toBeNull();

    const escapeLink = container.querySelector<HTMLAnchorElement>('a[aria-label="Show app framework"]');
    expect(escapeLink).not.toBeNull();
    expect(escapeLink?.getAttribute('href')).toBe('/dapp/game-app/app/secret?x=1');
  });

  it('omits the escape link on a /full URL when the manifest sets display.frameButton to false', () => {
    mocks.manifest.display = { chrome: 'fullscreen', frameButton: false };
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/dapp/game-app/full/secret']}>
          <Routes>
            <Route path="/dapp/:id/*" element={<AppShell identity={identity} onIdentityUpdate={vi.fn()} />} />
          </Routes>
        </MemoryRouter>,
      );
    });

    expect(container.querySelector('aside')).toBeNull();
    expect(container.querySelector('a[aria-label="Show app framework"]')).toBeNull();
  });

  it('renders the sidebar as usual on a standard /app URL', () => {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/dapp/game-app/app']}>
          <Routes>
            <Route path="/dapp/:id/*" element={<AppShell identity={identity} onIdentityUpdate={vi.fn()} />} />
          </Routes>
        </MemoryRouter>,
      );
    });

    expect(container.querySelector('aside')).not.toBeNull();
    expect(container.querySelector('a[aria-label="Show app framework"]')).toBeNull();
  });

  it('collapses and expands the desktop sidebar and persists the preference', () => {
    localStorage.removeItem('shell:sidebar-collapsed');
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/dapp/game-app/app']}>
          <Routes>
            <Route path="/dapp/:id/*" element={<AppShell identity={identity} onIdentityUpdate={vi.fn()} />} />
          </Routes>
        </MemoryRouter>,
      );
    });

    const aside = () => must(container.querySelector('aside'));
    expect(aside().className).toContain('lg:w-[244px]');

    const collapseBtn = must(container.querySelector<HTMLButtonElement>('button[aria-label="Collapse sidebar"]'));
    act(() => collapseBtn.click());
    expect(aside().className).toContain('lg:w-[60px]');
    expect(localStorage.getItem('shell:sidebar-collapsed')).toBe('1');

    const expandBtn = must(container.querySelector<HTMLButtonElement>('button[aria-label="Expand sidebar"]'));
    act(() => expandBtn.click());
    expect(aside().className).toContain('lg:w-[244px]');
    expect(localStorage.getItem('shell:sidebar-collapsed')).toBe('0');
    localStorage.removeItem('shell:sidebar-collapsed');
  });

  it('offers a top-bar app switcher and fullscreen toggle while inside a dapp', async () => {
    mocks.dapps = [
      { id: 'game-app', name: 'Game', icon: '🎮', color: '#7c6aff' },
      { id: 'notes-app', name: 'Notes', icon: '📝', color: '#10b981' },
    ] as DappListItem[];

    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/dapp/game-app/app']}>
          <Routes>
            <Route path="/dapp/:id/*" element={<AppShell identity={identity} onIdentityUpdate={vi.fn()} />} />
          </Routes>
        </MemoryRouter>,
      );
    });

    const fullscreenLink = container.querySelector<HTMLAnchorElement>('a[aria-label="Fullscreen"]');
    expect(fullscreenLink?.getAttribute('href')).toBe('/dapp/game-app/full');

    const switcher = must(container.querySelector<HTMLButtonElement>('button[aria-label="Switch app"]'));
    await act(async () => { switcher.click(); await Promise.resolve(); });
    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((node) => node.textContent?.trim());
    expect(items).toEqual(expect.arrayContaining([
      expect.stringContaining('Game'),
      expect.stringContaining('Notes'),
      'All apps',
      'New app',
      'Join with link',
    ]));
  });
});
