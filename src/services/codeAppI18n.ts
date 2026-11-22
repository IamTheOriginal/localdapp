/**
 * Code App translations: a dapp's source file map may carry dictionaries under
 * `i18n/<language>.json` (e.g. `i18n/de.json`). Keys are the app's source
 * strings (conventionally English, mirroring the host shell's i18n) or any
 * stable ids the author prefers; values are the translated texts. The runtime
 * embeds every dictionary into the sandbox document at build time and exposes
 * them through `$i18n` / `$t`, keyed by the host shell's active language.
 *
 * Owners edit these files like any other source file in the code editor —
 * adding `i18n/fr.json` is all it takes to add a language.
 */

const CODE_APP_I18N_DIR = 'i18n/';

export const MAX_CODE_APP_I18N_LANGUAGES = 24;
const MAX_CODE_APP_I18N_ENTRIES = 5_000;
const MAX_CODE_APP_I18N_KEY_LENGTH = 256;
const MAX_CODE_APP_I18N_VALUE_LENGTH = 4_096;

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;

/** `i18n/de.json` → `de`; null when the path is not a language file. */
export function codeAppI18nLanguageOf(path: string): string | null {
  if (!path.startsWith(CODE_APP_I18N_DIR) || !path.endsWith('.json')) return null;
  const name = path.slice(CODE_APP_I18N_DIR.length, -'.json'.length).toLowerCase();
  return LANGUAGE_CODE_PATTERN.test(name) ? name : null;
}

function parseDictionary(path: string, content: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object mapping source strings to translations`);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_CODE_APP_I18N_ENTRIES) {
    throw new Error(`${path} exceeds ${MAX_CODE_APP_I18N_ENTRIES} entries`);
  }
  const dictionary: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof value !== 'string') throw new Error(`${path}: value of "${key.slice(0, 60)}" must be a string`);
    if (key.length === 0 || key.length > MAX_CODE_APP_I18N_KEY_LENGTH) {
      throw new Error(`${path}: keys must be 1–${MAX_CODE_APP_I18N_KEY_LENGTH} characters`);
    }
    if (value.length > MAX_CODE_APP_I18N_VALUE_LENGTH) {
      throw new Error(`${path}: value of "${key.slice(0, 60)}" exceeds ${MAX_CODE_APP_I18N_VALUE_LENGTH} characters`);
    }
    Object.defineProperty(dictionary, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return dictionary;
}

/**
 * Strict validation for save/install paths: every `i18n/*.json` file must be a
 * well-formed flat dictionary, and its name a plausible language code. Fails
 * closed so a typo surfaces in the editor instead of silently dropping a
 * language at runtime.
 */
export function validateCodeAppI18nFiles(files: Readonly<Record<string, string>>): void {
  let languages = 0;
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith(CODE_APP_I18N_DIR) || !path.endsWith('.json')) continue;
    if (!codeAppI18nLanguageOf(path)) {
      throw new Error(`${path}: i18n files must be named i18n/<language>.json (e.g. i18n/de.json)`);
    }
    languages += 1;
    if (languages > MAX_CODE_APP_I18N_LANGUAGES) {
      throw new Error(`Code Apps are limited to ${MAX_CODE_APP_I18N_LANGUAGES} i18n languages`);
    }
    parseDictionary(path, content);
  }
}

/**
 * Tolerant extraction for the runtime: malformed dictionaries are skipped (the
 * app still boots; the strings fall back), valid ones are returned keyed by
 * language code.
 */
export function extractCodeAppI18n(files: Readonly<Record<string, string>>): Record<string, Record<string, string>> {
  const dictionaries: Record<string, Record<string, string>> = {};
  for (const [path, content] of Object.entries(files)) {
    const language = codeAppI18nLanguageOf(path);
    if (!language || Object.keys(dictionaries).length >= MAX_CODE_APP_I18N_LANGUAGES) continue;
    try {
      Object.defineProperty(dictionaries, language, {
        value: parseDictionary(path, content), enumerable: true, configurable: true, writable: true,
      });
    } catch {
      // Runtime stays tolerant: a broken dictionary must not brick the app.
    }
  }
  return dictionaries;
}
