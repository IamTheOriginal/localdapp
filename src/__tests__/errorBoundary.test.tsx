// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ErrorBoundary, { isStaleBuildError } from '../components/ErrorBoundary.tsx';
import { I18nProvider } from '../i18n/index.tsx';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Broken({ message }: { message: string }): never {
  throw new Error(message);
}

describe('ErrorBoundary', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    vi.restoreAllMocks();
  });

  const show = (resetKey: string | undefined, child: React.ReactNode) => {
    act(() => {
      root.render(<I18nProvider><ErrorBoundary resetKey={resetKey}>{child}</ErrorBoundary></I18nProvider>);
    });
  };
  const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;

  it('shows the failure and recovers when the route changes', () => {
    show('/dapp/1/files', <Broken message="files page exploded" />);
    expect(alertText()).toContain('files page exploded');

    // Same route, new render: the error stays (and there is no render loop).
    show('/dapp/1/files', <p>files</p>);
    expect(alertText()).toContain('files page exploded');

    show('/', <p>home works</p>);
    expect(alertText()).toBeNull();
    expect(container.textContent).toContain('home works');
  });

  it('keeps showing an error when it has no reset key', () => {
    show(undefined, <Broken message="boom" />);
    show(undefined, <p>fine</p>);
    expect(alertText()).toContain('boom');
  });

  it('recognises a page file that disappeared with a deploy', () => {
    expect(isStaleBuildError(new Error('Failed to fetch dynamically imported module: https://x/assets/FilesPage-abc.js'))).toBe(true);
    expect(isStaleBuildError(new Error('Importing a module script failed.'))).toBe(true);
    expect(isStaleBuildError(new Error('Cannot read properties of undefined'))).toBe(false);
  });
});
