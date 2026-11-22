// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({
  dapps: [] as Array<{ id: string; name: string; icon: string; color: string; createdAt?: string }>,
  createStarterDapp: vi.fn(() => 'created-starter'),
  fetchStarterCatalog: vi.fn(),
  fetchStarterDefinition: vi.fn(),
  starters: [
    { id: 'todo-list', name: 'To-Do List', icon: '✅', color: '#6755e7', pitch: 'Tasks', files: ['index.html', 'manifest.yaml'] },
    { id: 'shared-expenses', name: 'Shared Expenses', icon: '💸', color: '#0d8f78', pitch: 'Expenses', files: ['index.html', 'manifest.yaml'] },
    { id: 'diary', name: 'Diary', icon: '📔', color: '#b14e75', pitch: 'Diary', files: ['index.html', 'manifest.yaml'] },
    { id: 'group-chat', name: 'Group Chat', icon: '💬', color: '#3478c8', pitch: 'Chat', files: ['index.html', 'manifest.yaml'] },
  ],
}));

vi.mock('../hooks/useYjs.ts', () => ({
  useDappsList: () => mocks.dapps,
  useHomeLayout: () => ({ nodes: mocks.dapps.map((dapp) => ({ kind: 'dapp', dapp })), leftDapps: [] }),
}));
vi.mock('../services/store/index.ts', () => ({
  fetchStarterCatalog: mocks.fetchStarterCatalog,
  fetchStarterDefinition: mocks.fetchStarterDefinition,
  createStarterDapp: mocks.createStarterDapp,
  importDefinitionBundle: vi.fn(),
  verifyDefinitionBundle: vi.fn(),
  // Home layout (order + folders) — HomePage only calls these from user actions.
  homeNodeId: (node: { dapp: { id: string } }) => node.dapp.id,
  readHomeLayout: vi.fn(() => []),
  stepTarget: vi.fn(),
  moveDapp: vi.fn(),
  moveFolder: vi.fn(),
  createFolderFromDapps: vi.fn(),
  renameFolder: vi.fn(),
  ungroupFolder: vi.fn(),
  FOLDER_NAME_MAX: 40,
}));
vi.mock('../services/dappDeletionRuntime.ts', () => ({ deleteDapp: vi.fn() }));
vi.mock('../components/DappContent.tsx', () => ({ DappContent: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../components/code-app/DefinitionInstallDialog.tsx', () => ({ default: () => null }));

import HomePage from '../pages/HomePage.tsx';
import CreateDappModal from '../components/CreateDappModal.tsx';

function RouteProbe() {
  return <div data-route>{useLocation().pathname}</div>;
}

describe('HomePage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.dapps = [];
    mocks.createStarterDapp.mockReset();
    mocks.createStarterDapp.mockReturnValue('created-starter');
    mocks.fetchStarterCatalog.mockReset();
    mocks.fetchStarterCatalog.mockResolvedValue(mocks.starters);
    mocks.fetchStarterDefinition.mockReset();
    mocks.fetchStarterDefinition.mockImplementation((starter: { id: string }) => Promise.resolve({
      ...starter, source: { 'index.html': '<!doctype html>', 'manifest.yaml': '{}' },
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  function renderHome() {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="*" element={<><HomePage /><RouteProbe /></>} />
          </Routes>
        </MemoryRouter>,
      );
    });
  }

  it.each([
    ['empty catalog', []],
    ['existing catalog', [{ id: 'existing', name: 'Existing', icon: '🧩', color: '#333333' }]],
  ])('no longer renders the starter gallery inline for an %s', (_label, dapps) => {
    mocks.dapps = dapps;
    renderHome();
    expect(container.querySelectorAll('[data-starter-id]')).toHaveLength(0);
    expect(container.textContent).not.toContain('Create To-Do List');
  });

  it('keeps blank creation behind the global new-dapp modal event', () => {
    const opened = vi.fn();
    window.addEventListener('open-new-dapp', opened, { once: true });
    renderHome();
    const blank = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Create Blank App'));
    if (!blank) throw new Error('Missing blank creation control');
    act(() => blank.click());
    expect(opened).toHaveBeenCalledTimes(1);
  });
});

describe('CreateDappModal starter gallery', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.dapps = [];
    mocks.createStarterDapp.mockReset();
    mocks.createStarterDapp.mockReturnValue('created-starter');
    mocks.fetchStarterCatalog.mockReset();
    mocks.fetchStarterCatalog.mockResolvedValue(mocks.starters);
    mocks.fetchStarterDefinition.mockReset();
    mocks.fetchStarterDefinition.mockImplementation((starter: { id: string }) => Promise.resolve({
      ...starter, source: { 'index.html': '<!doctype html>', 'manifest.yaml': '{}' },
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  function renderModal() {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="*" element={<><CreateDappModal onClose={() => undefined} onCreate={() => undefined} /><RouteProbe /></>} />
          </Routes>
        </MemoryRouter>,
      );
    });
  }

  async function openGallery() {
    const toggle = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Starter gallery'));
    if (!toggle) throw new Error('Missing starter gallery button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { toggle.click(); await Promise.resolve(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  }

  it('keeps a long typed name from widening the dialog (the live preview must not size its ancestors)', () => {
    renderModal();
    const input = document.querySelector<HTMLInputElement>('input[maxlength]');
    if (!input) throw new Error('Missing dapp name input');
    const longName = 'W'.repeat(input.maxLength);
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setValue?.call(input, longName);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // happy-dom does no layout, so the guard is on the classes that make the layout safe:
    // the no-wrap preview sits in a zero-basis flex item, and every grid ancestor up to the
    // form may shrink below its content (grid items default to min-width:auto).
    const preview = document.querySelector('[data-testid="dapp-name-preview"]');
    expect(preview?.textContent).toContain(longName);
    expect(preview?.querySelector('p')?.className).toContain('truncate');
    expect(preview?.className.split(' ')).toEqual(expect.arrayContaining(['w-0', 'min-w-0', 'flex-1']));
    const form = preview?.closest('form');
    for (let node = preview?.parentElement ?? null; node && node !== form?.parentElement; node = node.parentElement) {
      if (node.className.split(' ').includes('grid')) {
        expect(node.className.split(' '), node.className).toEqual(expect.arrayContaining(['min-w-0', 'grid-cols-1']));
      }
    }
    expect(input.className).toContain('w-full');
    expect(input.className).not.toContain('field-sizing');
  });

  it('hides the gallery until the dedicated button reveals every starter', async () => {
    renderModal();
    expect(document.querySelectorAll('[data-starter-id]')).toHaveLength(0);
    await openGallery();
    expect(document.querySelectorAll('[data-starter-id]')).toHaveLength(4);
    expect(document.body.textContent).toContain('Create To-Do List');
    expect(document.body.textContent).toContain('Create Group Chat');
  });

  it('creates once on a double tap and navigates directly into the live app', async () => {
    renderModal();
    await openGallery();
    const button = Array.from(document.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.trim() === 'Create Group Chat');
    if (!button) throw new Error('Missing Group Chat starter button');
    await act(async () => {
      button.click();
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.fetchStarterDefinition).toHaveBeenCalledTimes(1);
    expect(mocks.createStarterDapp).toHaveBeenCalledTimes(1);
    expect(mocks.createStarterDapp).toHaveBeenCalledWith(expect.objectContaining({ id: 'group-chat' }));
    expect(container.querySelector('[data-route]')?.textContent).toBe('/dapp/created-starter/app');
  });

  it('exposes starter creation failures accessibly without closing the modal', async () => {
    mocks.createStarterDapp.mockImplementation(() => { throw new Error('Starter failed safely'); });
    renderModal();
    await openGallery();
    const todo = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Create To-Do List');
    if (!todo) throw new Error('Missing To-Do List starter button');
    await act(async () => { todo.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Starter failed safely');
    expect(document.body.textContent).toContain('Create New Dapp');
    expect(container.querySelector('[data-route]')?.textContent).toBe('/');
  });
});
