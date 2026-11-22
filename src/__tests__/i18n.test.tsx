// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { de } from '../i18n/de.ts';
import { I18nProvider, useI18n } from '../i18n/index.tsx';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type I18nValue = ReturnType<typeof useI18n>;

// Exposes the hook's current value to the test via a mutable holder.
function Probe({ onValue }: { onValue: (value: I18nValue) => void }) {
  onValue(useI18n());
  return null;
}

// Shell strings that must exist in the German dictionary — guards against
// typos silently falling back to English.
const REQUIRED_SHELL_KEYS = [
  'General',
  'Home',
  'People & Sharing',
  'Views',
  'Manage',
  'Code editor',
  'Dapp settings',
  'Settings',
  'Light mode',
  'Dark mode',
  'Open navigation',
  'Navigation',
  'App navigation and dapp management',
  'Show app framework',
  'Choose the newly paired contact',
  'Presets',
  'Primary Color',
  'Corner Radius',
  'Share with a dapp',
  'Nothing to share',
  'Delivering…',
  // Home: manual order and folders
  'Done',
  'Move {name}',
  'Move up',
  'Move down',
  'Move to top',
  'Move to folder',
  'New folder…',
  'New folder',
  'Remove from folder',
  'Ungroup',
  'Folder',
  'Folder name',
  'Folder {name}',
  'Folder · {count} apps',
  'Second app',
  'Create folder',
  '{name} moved to position {position} of {total}.',
  '{name} moved to position {position} of {total} in folder {folder}.',
  '{name} removed from folder.',
  'Folder {name} ungrouped.',
];

describe('i18n core', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.removeItem('language');
    delete (window.navigator as unknown as Record<string, unknown>).language;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.removeItem('language');
    delete (window.navigator as unknown as Record<string, unknown>).language;
  });

  const renderProvider = (): { current: I18nValue } => {
    const ref: { current?: I18nValue } = {};
    act(() => {
      root.render(
        <I18nProvider>
          <Probe onValue={(value) => (ref.current = value)} />
        </I18nProvider>,
      );
    });
    return {
      get current() {
        if (!ref.current) throw new Error('i18n value was not captured during render');
        return ref.current;
      },
    };
  };

  it('defaults to English with pass-through translation outside German', () => {
    const value = renderProvider().current;
    expect(value.language).toBe('en');
    expect(value.t('Settings')).toBe('Settings');
    expect(value.t('not a real key')).toBe('not a real key');
  });

  it('detects German from the browser language when nothing is stored', () => {
    Object.defineProperty(window.navigator, 'language', {
      value: 'de-DE',
      configurable: true,
      writable: true,
    });
    const value = renderProvider().current;
    expect(value.language).toBe('de');
    expect(value.t('Settings')).toBe('Einstellungen');
  });

  it('honours an explicit stored preference over browser detection', () => {
    Object.defineProperty(window.navigator, 'language', {
      value: 'de-AT',
      configurable: true,
      writable: true,
    });
    localStorage.setItem('language', 'en');
    const value = renderProvider().current;
    expect(value.language).toBe('en');
    expect(value.t('Settings')).toBe('Settings');
  });

  it('persists the choice, translates, and updates <html lang>', () => {
    const holder = renderProvider();
    expect(holder.current.language).toBe('en');

    act(() => holder.current.setLanguage('de'));

    expect(holder.current.language).toBe('de');
    expect(holder.current.t('People & Sharing')).toBe('Personen & Freigaben');
    expect(holder.current.t('still unknown')).toBe('still unknown'); // graceful fallback
    expect(localStorage.getItem('language')).toBe('de');
    expect(document.documentElement.lang).toBe('de');
  });

  it('keeps a complete German dictionary for all shell strings', () => {
    for (const key of REQUIRED_SHELL_KEYS) {
      const entry = de[key];
      expect(entry, `missing German translation for ${key}`).toBeTruthy();
      expect(entry.trim().length).toBeGreaterThan(0);
    }
  });
});
