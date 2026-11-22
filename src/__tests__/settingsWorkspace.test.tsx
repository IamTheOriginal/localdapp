// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceIdentity } from '../types.ts';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog.tsx';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('../components/settings/DirectBindingsSettings.tsx', () => ({
  default: () => <div>Bindings section</div>,
}));

vi.mock('../components/settings/LocalDataSettings.tsx', () => ({
  default: () => <div>Local data section</div>,
}));

vi.mock('../components/settings/SignalingSettings.tsx', () => ({
  default: () => <div>Signaling section</div>,
}));

vi.mock('../pages/SettingsPage.tsx', () => ({
  default: ({ section }: { section?: string }) => <div>Account section: {section}</div>,
}));

import SettingsWorkspace from '../components/settings/SettingsWorkspace.tsx';

const identity: DeviceIdentity = {
  displayName: 'Test User',
  publicKey: 'public-key',
  privateKey: 'private-key',
  deviceId: 'device-id',
};

describe('SettingsWorkspace', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('provides all sections and switches the visible panel', async () => {
    await act(async () => {
      await Promise.resolve();
      root.render(
        <Dialog open>
          <DialogContent showCloseButton={false}>
            <DialogHeader className="sr-only">
              <DialogTitle>Settings</DialogTitle>
              <DialogDescription>Settings workspace</DialogDescription>
            </DialogHeader>
            <SettingsWorkspace identity={identity} onIdentityUpdate={vi.fn()} />
          </DialogContent>
        </Dialog>,
      );
    });

    const desktopTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[id^="settings-tab-desktop-"]'));
    // What is shared with whom is not a setting any more — it lives with the app and with the contact.
    expect(desktopTabs.map((tab) => tab.textContent?.trim())).toEqual([
      'Identity',
      'Code App Bindings',
      'Restore a legacy identity',
      'Signaling',
      'Local Data',
      'About',
    ]);

    const panel = document.querySelector<HTMLElement>('[role="tabpanel"]');
    const workspace = panel?.parentElement?.parentElement;
    const mobileTabs = document.querySelector<HTMLElement>('[aria-orientation="horizontal"]');
    expect(workspace?.className).toContain('min-w-0');
    expect(workspace?.className).toContain('overflow-hidden');
    expect(mobileTabs?.parentElement?.className).toContain('min-w-0');
    expect(mobileTabs?.parentElement?.className).toContain('overflow-hidden');
    expect(mobileTabs?.className).toContain('overflow-x-auto');
    expect(panel?.textContent).toContain('Account section: identity');
    expect(desktopTabs[0]?.getAttribute('aria-selected')).toBe('true');

    const bindingsTab = document.querySelector<HTMLButtonElement>('#settings-tab-desktop-bindings');
    if (!bindingsTab) throw new Error('Expected Code App Bindings tab');
    await act(async () => { bindingsTab.click(); await Promise.resolve(); });
    expect(panel?.textContent).toContain('Bindings section');
    expect(bindingsTab.getAttribute('aria-selected')).toBe('true');

    const backupTab = document.querySelector<HTMLButtonElement>('#settings-tab-desktop-backup');
    if (!backupTab) throw new Error('Expected backup tab');
    await act(async () => { backupTab.click(); await Promise.resolve(); });
    expect(panel?.textContent).toContain('Account section: backup');
    expect(panel?.getAttribute('aria-label')).toBe('Restore a legacy identity settings');
  });

  it('supports arrow-key navigation through the desktop tabs', async () => {
    await act(async () => {
      await Promise.resolve();
      root.render(
        <Dialog open>
          <DialogContent showCloseButton={false}>
            <DialogHeader className="sr-only">
              <DialogTitle>Settings</DialogTitle>
              <DialogDescription>Settings workspace</DialogDescription>
            </DialogHeader>
            <SettingsWorkspace identity={identity} onIdentityUpdate={vi.fn()} />
          </DialogContent>
        </Dialog>,
      );
    });

    const identityTab = document.querySelector<HTMLButtonElement>('#settings-tab-desktop-identity');
    const bindingsTab = document.querySelector<HTMLButtonElement>('#settings-tab-desktop-bindings');
    if (!identityTab || !bindingsTab) throw new Error('Expected desktop settings tabs');

    identityTab.focus();
    await act(async () => {
      identityTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(bindingsTab);
    expect(bindingsTab.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector<HTMLElement>('[role="tabpanel"]')?.textContent).toContain('Bindings section');
  });
});
