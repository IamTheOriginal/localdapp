// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeAppDefinitionBundle, DappContactHandle } from '../types.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const contacts: DappContactHandle[] = [
  { handle: 'opaque-alice', displayName: 'Alice', verified: true },
  { handle: 'opaque-bob', displayName: 'Bob', verified: false },
];
const rootMap = { observeDeep: vi.fn(), unobserveDeep: vi.fn() };

vi.mock('../services/store/contacts.ts', () => ({ listDappContacts: vi.fn(() => Promise.resolve(contacts)) }));
vi.mock('../services/store/docs.ts', () => ({ getRootDoc: () => ({ getMap: () => rootMap }) }));

import ContactPickerDialog from '../components/sharing/ContactPickerDialog.tsx';
import ShareConsentDialog from '../components/sharing/ShareConsentDialog.tsx';
import DefinitionInstallDialog from '../components/code-app/DefinitionInstallDialog.tsx';

describe('host-mediated sharing dialogs', () => {
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
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('returns only explicitly selected opaque contacts and enforces the maximum', async () => {
    const resolved = vi.fn();
    await act(async () => {
      root.render(<ContactPickerDialog open dappId="app-1" label="Choose players" min={1} max={1} onResolve={resolved} />);
      await Promise.resolve();
    });

    const alice = document.querySelector<HTMLButtonElement>('[aria-label="Select Alice"]');
    const bob = document.querySelector<HTMLButtonElement>('[aria-label="Select Bob"]');
    if (!alice || !bob) throw new Error('Expected contact choices');
    act(() => {
      alice.closest('label')?.click();
    });
    act(() => {
      document.querySelector<HTMLElement>('[aria-label="Select Bob"]')?.closest('label')?.click();
    });

    const choose = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim().startsWith('Choose') && button.textContent?.trim() !== 'Choose players');
    if (!choose) throw new Error('Expected choose button');
    act(() => choose.click());

    expect(resolved).toHaveBeenCalledWith([contacts[0]]);
    expect(resolved.mock.calls[0]?.[0]).not.toContainEqual(contacts[1]);
  });

  it('shows exact permissions and returns explicit consent only', () => {
    const resolved = vi.fn();
    act(() => {
      root.render(
        <ShareConsentDialog
          open
          appName="Chess"
          shareLabel="Game"
          contacts={[contacts[0]]}
          events={[{ id: 'move.sent', label: 'Move sent', payload: [{ name: 'square', type: 'string', required: true }] }]}
          actions={[{ id: 'move.apply', label: 'Apply move', payload: [{ name: 'square', type: 'string', required: true }] }]}
          onResolve={resolved}
        />,
      );
    });

    expect(document.body.textContent).toContain('move.sent');
    expect(document.body.textContent).toContain('move.apply');
    expect(document.body.textContent).toContain('Alice');
    const allow = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === 'Allow sharing');
    if (!allow) throw new Error('Expected consent button');
    act(() => allow.click());
    expect(resolved).toHaveBeenCalledWith({ confirmed: true });
  });

  it('previews signed definition capabilities and requires an explicit install action', () => {
    const installed = vi.fn();
    const manifest = {
      routes: [{ path: '/', label: 'Dashboard' }],
      permissions: { host: { sharing: true }, network: { connect: ['https://api.example'] } },
      bindings: {
        events: [{ id: 'game.move', label: 'Move' }],
        actions: [{ id: 'game.apply', label: 'Apply' }],
      },
      channels: { shares: [{
        id: 'game', label: 'Game channel', events: ['game.move'], actions: ['game.apply'],
        routes: [{ eventId: 'game.move', actionId: 'game.apply' }],
      }] },
    };
    const bundle: CodeAppDefinitionBundle = {
      protocol: 'code-app-definition', schemaVersion: 1, name: 'Chess', icon: '♟️', color: '#123456',
      files: { 'index.html': '<main>Chess</main>', 'manifest.yaml': JSON.stringify(manifest) },
      manifestVersion: '12345678', createdAt: '2026-08-20T12:00:00.000Z',
      authorPublicKey: 'ab'.repeat(32), signature: 'cd'.repeat(64),
    };

    act(() => {
      root.render(
        <DefinitionInstallDialog
          bundle={bundle}
          installing={false}
          confirmLabel="Install app & accept share"
          onCancel={vi.fn()}
          onInstall={installed}
        />,
      );
    });

    expect(document.body.textContent).toContain('Install ♟️ Chess?');
    expect(document.body.textContent).toContain('Dashboard');
    expect(document.body.textContent).toContain('sharing');
    expect(document.body.textContent).toContain('https://api.example');
    expect(document.body.textContent).toContain('Game channel');
    expect(document.body.textContent).toContain('Records, app data, members, room credentials, and sharing credentials are not imported');
    const install = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Install app & accept share');
    if (!install) throw new Error('Expected explicit definition install button');
    act(() => install.click());
    expect(installed).toHaveBeenCalledOnce();
  });
});
