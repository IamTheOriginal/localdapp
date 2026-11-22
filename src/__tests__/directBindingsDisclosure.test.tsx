// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({
  dapps: [
    { id: 'source-app', name: 'Source App', icon: '🧩', color: '#333', role: 'owner' },
    { id: 'dest-app', name: 'Dest App', icon: '📦', color: '#444', role: 'owner' },
  ],
  approve: vi.fn(() => Promise.resolve({})),
  bindings: [] as unknown[],
  deliveries: [] as unknown[],
}));

const sourceManifest = {
  routes: [{ path: '/', label: 'S', icon: 'code' }],
  bindings: { events: [{ id: 'item-added', label: 'Item added', payload: [{ name: 'title', label: 'Title', type: 'string', required: true }] }] },
};
const destManifest = {
  routes: [{ path: '/', label: 'D', icon: 'code' }],
  bindings: { actions: [{ id: 'log-item', label: 'Log item', payload: [{ name: 'name', label: 'Name', type: 'string', required: true }] }] },
};

vi.mock('@/hooks/useYjs', () => ({ useDappsList: () => mocks.dapps }));
vi.mock('@/services/store/source', () => ({
  getCodeAppFile: (dappId: string, path: string) => {
    if (path !== 'manifest.yaml') return undefined;
    return JSON.stringify(dappId === 'source-app' ? sourceManifest : destManifest);
  },
}));
vi.mock('@/services/store/docs', () => ({
  getRootDoc: () => new Y.Doc(),
  getDappSourceDoc: () => new Y.Doc(),
  getDappSourcePersistence: () => null,
}));
vi.mock('@/services/store/directBindings', () => ({
  listDirectBindings: () => mocks.bindings,
  listDirectDeliveries: () => mocks.deliveries,
  pauseDirectBinding: vi.fn(),
  resumeDirectBinding: vi.fn(),
  deleteDirectBinding: vi.fn(),
}));
vi.mock('@/services/directCodeBindingRuntime', () => ({ approveDirectCodeBinding: mocks.approve }));

import DirectBindingsSettings from '../components/settings/DirectBindingsSettings.tsx';

describe('DirectBindingsSettings attribute disclosure', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.approve.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  const buttonByText = (text: string) => Array.from(document.querySelectorAll('button'))
    .find((button) => button.textContent?.includes(text));

  it('hides event attributes until pressed and reveals them on demand', () => {
    act(() => root.render(<DirectBindingsSettings />));

    const sourceSelect = document.getElementById('binding-source') as HTMLSelectElement;
    act(() => {
      sourceSelect.value = 'source-app:item-added';
      sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(document.body.textContent).not.toContain('Title (string)');
    expect(document.body.textContent).toContain('Attributes (1)');

    act(() => buttonByText('Attributes (1)')?.click());
    expect(document.body.textContent).toContain('Title (string)');

    act(() => buttonByText('Attributes (1)')?.click());
    expect(document.body.textContent).not.toContain('Title (string)');
  });

  it('keeps field mapping collapsed until pressed, showing a mapped-count summary', () => {
    act(() => root.render(<DirectBindingsSettings />));
    const sourceSelect = document.getElementById('binding-source') as HTMLSelectElement;
    act(() => {
      sourceSelect.value = 'source-app:item-added';
      sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const destSelect = document.getElementById('binding-destination') as HTMLSelectElement;
    act(() => {
      destSelect.value = 'dest-app:log-item';
      destSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('Field mapping (1/1 mapped)');
    expect(document.querySelector('#binding-field-mapping')).toBeNull();

    act(() => buttonByText('Field mapping')?.click());
    expect(document.querySelector('#binding-field-mapping')).not.toBeNull();
    expect(document.body.textContent).toContain('Name *');
  });
});
