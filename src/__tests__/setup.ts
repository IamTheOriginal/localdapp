/**
 * Shared Vitest setup.
 *
 * Normalizes `localStorage`/`sessionStorage` across environments:
 * - Node >= 25 ships a global `localStorage` that collides with happy-dom's
 *   environment population, leaving a method-less plain object behind.
 * - Node < 25 has no global at all, which breaks suites that exercise code
 *   touching storage directly (e.g. identity key custody) in the node env.
 * In both cases install a spec-shaped in-memory Storage so tests and services
 * can rely on the normal API everywhere. Healthy DOM storages are untouched.
 */

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  const storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(String(key)) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(String(key)),
    setItem: (key: string, value: string) => void data.set(String(key), String(value)),
  };
  return storage;
}

function isUsable(candidate: unknown): boolean {
  return typeof (candidate as Storage | undefined)?.getItem === 'function';
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  const globalRef = globalThis as unknown as Record<string, unknown>;
  if (!isUsable(globalRef[name])) {
    Object.defineProperty(globalThis, name, { value: createMemoryStorage(), configurable: true });
  }
}

/**
 * happy-dom eagerly fetches `<link rel="stylesheet">` and `<script src>`
 * targets — even in `DOMParser` documents, which real browsers keep inert.
 * Code App tests parse authored HTML that links local files (the runtime
 * inlines them from the file map; nothing is ever fetched), so those loads
 * only produce ECONNREFUSED noise. Disable them where the environment is happy-dom.
 */
const happyDom = (globalThis as { happyDOM?: { settings?: Record<string, unknown> } }).happyDOM;
if (happyDom?.settings) {
  happyDom.settings.disableCSSFileLoading = true;
  happyDom.settings.disableJavaScriptFileLoading = true;
  // …and don't log the disabled loads as errors either.
  happyDom.settings.handleDisabledFileLoadingAsSuccess = true;
}
