import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { de } from './de.ts';

type Language = 'en' | 'de';

const STORAGE_KEY = 'language';

function getInitialLanguage(): Language {
  if (typeof window === 'undefined') return 'en';
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'en' || stored === 'de') return stored;
  // No explicit choice yet: follow the browser once, then persist on first change.
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('de')
    ? 'de'
    : 'en';
}

function translate(language: Language, key: string): string {
  if (language === 'en') return key;
  return de[key] ?? key;
}

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  /** Translate an English source string into the active language. */
  t: (key: string) => string;
}

// Pass-through defaults so components render plain English outside a provider
// (tests, isolated stories) — mirrors useTheme's inert default context.
const I18nContext = createContext<I18nContextValue>({
  language: 'en',
  setLanguage: () => {},
  t: (key) => key,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(getInitialLanguage);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, language);
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo<I18nContextValue>(
    () => ({ language, setLanguage: setLanguageState, t: (key: string) => translate(language, key) }),
    [language],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
