// @vitest-environment happy-dom

import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('../components/DappContent.tsx', () => ({ DappContent: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../components/code-app/DefinitionInstallDialog.tsx', () => ({ default: () => null }));
vi.mock('../services/dappDeletionFlow.ts', () => ({ confirmAndDeleteDapp: vi.fn() }));
vi.mock('../services/dappLeaveFlow.ts', () => ({ confirmAndLeaveDapp: vi.fn() }));

import HomePage from '../pages/HomePage.tsx';
import { useDappsList } from '../hooks/useYjs.ts';
import { getDappsList, getRootDoc } from '../services/store/docs.ts';
import { createFolderFromDapps, moveDapp, readHomeLayout, homeNodeId } from '../services/store/homeLayout.ts';

/** The real root doc drives the page — the Move menu is the keyboard path to everything drag and drop does. */
describe('Home Move menu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    const doc = getRootDoc();
    doc.transact(() => {
      const list = getDappsList();
      list.delete(0, list.length);
      doc.getMap('dappFolders').clear();
      ['a', 'b', 'c'].forEach((id, index) => {
        const item = new Y.Map<string>();
        Object.entries({ id, name: `App ${id.toUpperCase()}`, icon: '🧩', roomId: `room-${id}`, roomPassword: `secret-${id}`, sortOrder: String(index + 1) })
          .forEach(([key, value]) => item.set(key, value));
        list.push([item]);
      });
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<MemoryRouter><HomePage /></MemoryRouter>));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  const cardNames = () => Array.from(container.querySelectorAll('[data-grid-container="home"] h3')).map((heading) => heading.textContent);
  const storeOrder = () => readHomeLayout().map(homeNodeId);

  async function chooseFromMenu(triggerLabel: string, ...itemLabels: string[]) {
    const trigger = container.querySelector<HTMLElement>(`button[aria-label="${triggerLabel}"]`);
    if (!trigger) throw new Error(`Missing menu trigger "${triggerLabel}"`);
    await act(async () => { trigger.click(); await Promise.resolve(); });
    for (const label of itemLabels) {
      const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((candidate) => candidate.textContent === label);
      if (!item) throw new Error(`Missing menu item "${label}"`);
      await act(async () => { item.click(); await Promise.resolve(); });
    }
  }

  it('renders every card as a focusable link to its dapp', () => {
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('[data-grid-container="home"] a'));
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/dapp/a', '/dapp/b', '/dapp/c']);
    expect(links[1].getAttribute('draggable')).toBe('false');
    links[1].focus();
    expect(document.activeElement).toBe(links[1]);
    // The link is stretched over the card; the actions stay above it.
    expect(links[1].className).toContain('after:absolute');
    expect(links[1].className).toContain('after:inset-0');
    expect(container.querySelector('button[aria-label="Move App B"]')?.closest('.z-10')).not.toBeNull();
  });

  it('moves a card up from the menu, keeps its catalog item and announces the move', async () => {
    const before = getDappsList().toArray().find((item) => item.get('id') === 'c');
    await chooseFromMenu('Move App C', 'Move up');
    expect(storeOrder()).toEqual(['a', 'c', 'b']);
    expect(cardNames()).toEqual(['App A', 'App C', 'App B']);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('App C moved to position 2 of 3.');
    expect(getDappsList().toArray().find((item) => item.get('id') === 'c')).toBe(before);
    expect(before?.get('roomPassword')).toBe('secret-c');

    await chooseFromMenu('Move App B', 'Move to top');
    expect(cardNames()).toEqual(['App B', 'App A', 'App C']);
  });

  it('disables the moves that lead nowhere', async () => {
    await chooseFromMenu('Move App A');
    const item = (label: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((candidate) => candidate.textContent === label);
    expect(item('Move up')?.getAttribute('aria-disabled')).toBe('true');
    expect(item('Move to top')?.getAttribute('aria-disabled')).toBe('true');
    expect(item('Move down')?.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('creates a folder through "New folder…", and removing a dapp from it dissolves the folder', async () => {
    await chooseFromMenu('Move App C', 'Move to folder', 'New folder…');
    const form = document.querySelector('form');
    if (!form) throw new Error('Missing new-folder form');
    expect(form.querySelector('select')?.value).toBe('a');
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve(); });

    const layout = readHomeLayout();
    expect(layout.map((node) => node.kind)).toEqual(['folder', 'dapp']);
    expect(layout[0].kind === 'folder' && layout[0].dapps.map((dapp) => dapp.id)).toEqual(['a', 'c']);
    expect(cardNames()).toEqual(['Folder', 'App B']);
    expect(container.textContent).toContain('Folder · 2 apps');

    // Open the folder: the same cards, with "Remove from folder".
    const open = Array.from(container.querySelectorAll<HTMLElement>('h3 button')).find((button) => button.textContent === 'Folder');
    await act(async () => { open?.click(); await Promise.resolve(); });
    const dialog = document.querySelector('[data-slot="dialog-content"]');
    expect(Array.from(dialog?.querySelectorAll('h3') ?? []).map((heading) => heading.textContent)).toEqual(['App A', 'App C']);
    expect(dialog?.querySelector<HTMLInputElement>('input[aria-label="Folder name"]')?.value).toBe('Folder');

    const trigger = dialog?.querySelector<HTMLElement>('button[aria-label="Move App C"]');
    await act(async () => { trigger?.click(); await Promise.resolve(); });
    const remove = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((candidate) => candidate.textContent === 'Remove from folder');
    await act(async () => { remove?.click(); await Promise.resolve(); });

    expect(readHomeLayout().map(homeNodeId)).toEqual(['a', 'b', 'c']);
    expect(getRootDoc().getMap('dappFolders').size).toBe(0);
    expect(cardNames()).toEqual(['App A', 'App B', 'App C']);
  });

  it('hands every other dapp list (share target, settings) the same order through useDappsList', () => {
    let listed: string[] = [];
    function Probe() {
      listed = useDappsList().map((dapp) => dapp.id);
      return null;
    }
    const probeRoot = createRoot(document.createElement('div'));
    act(() => probeRoot.render(<Probe />));
    expect(listed).toEqual(['a', 'b', 'c']);
    act(() => {
      moveDapp('c', { beforeId: 'a' });
      createFolderFromDapps('b', 'c');
      getDappsList().get(0).set('archivedAt', '2026-01-01T00:00:00.000Z');
    });
    expect(listed).toEqual(['b', 'c', 'a']); // folder members inline, the archived copy last
    act(() => probeRoot.unmount());
  });

  it('ungroups a folder from its card menu', async () => {
    await chooseFromMenu('Move App B', 'Move to folder', 'New folder…');
    const form = document.querySelector('form');
    await act(async () => { form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve(); });
    expect(cardNames()).toEqual(['Folder', 'App C']);
    await chooseFromMenu('Move Folder', 'Ungroup');
    expect(cardNames()).toEqual(['App A', 'App B', 'App C']);
  });
});
