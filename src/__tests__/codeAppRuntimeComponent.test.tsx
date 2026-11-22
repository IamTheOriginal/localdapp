// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({
  attachCodeAppBridge: vi.fn(() => ({
    setRoute: vi.fn(),
    setChrome: vi.fn(),
    destroy: vi.fn(),
  })),
  // A stable reference, matching how the real useCodeAppFiles only produces a
  // new object when the underlying Yjs data actually changes.
  files: { 'index.html': '<html></html>', 'manifest.yaml': '' },
}));

vi.mock('@/hooks/useYjs', () => ({
  useCodeAppFiles: () => ({ files: mocks.files, localReady: true }),
  useRunnableCodeApp: () => ({ files: mocks.files, localReady: true, status: 'sealed', reason: undefined }),
}));

vi.mock('@/services/codeAppRuntime', () => ({
  attachCodeAppBridge: mocks.attachCodeAppBridge,
  buildCodeAppDocument: () => ({ srcdoc: '<html></html>', dispose: vi.fn() }),
  CODE_APP_SANDBOX: 'allow-scripts',
}));

import CodeAppRuntime from '../components/code-app/CodeAppRuntime.tsx';

describe('CodeAppRuntime chrome toggling', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestBridge: ReturnType<typeof mocks.attachCodeAppBridge>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.attachCodeAppBridge.mockClear();
    mocks.files = { 'index.html': '<html></html>', 'manifest.yaml': '' };
    latestBridge = { setRoute: vi.fn(), setChrome: vi.fn(), destroy: vi.fn() };
    mocks.attachCodeAppBridge.mockImplementation(() => latestBridge);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('does not recreate the iframe when chrome, route, or search change — only the bridge is updated', () => {
    act(() => {
      root.render(
        <CodeAppRuntime dappId="game-app" role="owner" route="/" search="" chrome="standard" onNavigate={vi.fn()} onSetChrome={vi.fn()} />,
      );
    });

    expect(mocks.attachCodeAppBridge).toHaveBeenCalledTimes(1);
    const iframeAfterFirstRender = container.querySelector('iframe');
    expect(iframeAfterFirstRender).not.toBeNull();

    act(() => {
      root.render(
        <CodeAppRuntime dappId="game-app" role="owner" route="/" search="" chrome="fullscreen" onNavigate={vi.fn()} onSetChrome={vi.fn()} />,
      );
    });

    expect(mocks.attachCodeAppBridge).toHaveBeenCalledTimes(1);
    expect(latestBridge.setChrome).toHaveBeenCalledWith('fullscreen');
    expect(container.querySelector('iframe')).toBe(iframeAfterFirstRender);

    act(() => {
      root.render(
        <CodeAppRuntime dappId="game-app" role="owner" route="/tasks" search="?x=1" chrome="fullscreen" onNavigate={vi.fn()} onSetChrome={vi.fn()} />,
      );
    });

    expect(mocks.attachCodeAppBridge).toHaveBeenCalledTimes(1);
    expect(latestBridge.setRoute).toHaveBeenCalledWith('/tasks', '?x=1');
    expect(container.querySelector('iframe')).toBe(iframeAfterFirstRender);
  });

  it('keeps native capture blocked: camera apps use the host bridge without same-origin access', () => {
    mocks.files = {
      'index.html': '<html></html>',
      'manifest.yaml': 'routes:\n  - path: /\n    label: Scanner\npermissions:\n  device:\n    camera: true\n',
    };
    act(() => {
      root.render(
        <CodeAppRuntime dappId="scanner-app" role="owner" route="/" search="" chrome="standard" onNavigate={vi.fn()} onSetChrome={vi.fn()} />,
      );
    });
    expect(container.querySelector('iframe')?.getAttribute('allow')).toBe("camera 'none'; microphone 'none'");
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });
});
