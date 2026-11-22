import * as Y from 'yjs';
import { getDappSourceDoc } from './docs.ts';
import { requireRole } from './auth.ts';
import { buildDefaultCodeAppManifestYaml, parseCodeAppManifest } from '../codeAppManifest.ts';
import { validateCodeAppI18nFiles } from '../codeAppI18n.ts';
import { scheduleSourceSeal } from './sourceSeal.ts';

export const MAX_CODE_APP_FILES = 64;
const MAX_CODE_APP_FILE_PATH_BYTES = 1_024;
const MAX_CODE_APP_SOURCE_BYTES = 4_000_000;

// The commented starter manifest lives next to the parser (see
// buildDefaultCodeAppManifestYaml); this is the build for the default identity.
export const DEFAULT_CODE_APP_MANIFEST_YAML = buildDefaultCodeAppManifestYaml();

export const DEFAULT_CODE_APP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>My Code App</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: #0f172a; color: #f8fafc; }
    main { max-width: 42rem; margin: 0 auto; }
    nav { display: flex; gap: .5rem; margin-bottom: 2rem; }
    button { border: 0; border-radius: .5rem; padding: .65rem 1rem; background: #334155; color: white; cursor: pointer; }
    button.active, #increment { background: #f97316; }
    [data-view][hidden] { display: none; }
    pre { padding: 1rem; border-radius: .75rem; background: #1e293b; overflow: auto; }
  </style>
</head>
<body>
  <main>
    <nav aria-label="App navigation">
      <button data-route="/">Overview</button>
      <button data-route="/counter">Shared counter</button>
    </nav>
    <section data-view="/">
      <h1>My Code App</h1>
      <p>Routes come from manifest.yaml and stay synchronized with the Builder navigation.</p>
    </section>
    <section data-view="/counter" hidden>
      <h1>Shared counter</h1>
      <button id="increment">Increment</button>
      <pre id="output">Connecting…</pre>
    </section>
  </main>
  <script>
    Dapp.onReady(async () => {
      document.querySelectorAll('[data-route]').forEach((button) => {
        button.addEventListener('click', () => $router.navigate(button.dataset.route));
      });
      $router.subscribe((path) => {
        document.querySelectorAll('[data-view]').forEach((view) => { view.hidden = view.dataset.view !== path; });
        document.querySelectorAll('[data-route]').forEach((button) => { button.classList.toggle('active', button.dataset.route === path); });
      });

      const output = document.getElementById('output');
      await $data.subscribe((state) => { output.textContent = JSON.stringify(state, null, 2); });
      document.getElementById('increment').addEventListener('click', async () => {
        const count = (await $data.get('count')) || 0;
        await $data.set('count', count + 1);
      });
    });
  </script>
</body>
</html>`;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function normalizeCodeAppFilePath(path: string): string {
  if (path.length > MAX_CODE_APP_FILE_PATH_BYTES) throw new Error('Code App file path is too long');
  const normalized = path.trim();
  const segments = normalized.split('/');
  if (
    !normalized
    || new TextEncoder().encode(normalized).byteLength > MAX_CODE_APP_FILE_PATH_BYTES
    || normalized.startsWith('/')
    || normalized.includes('\\')
    || containsControlCharacter(normalized)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid Code App file path');
  }
  return normalized;
}

function assertCodeAppFileSize(content: string): void {
  if (content.length > 1_000_000) throw new Error('Code App files are limited to 1 MB');
}

export function getCodeAppFiles(dappId: string): Record<string, string> {
  const files = getDappSourceDoc(dappId).getMap<Y.Text>('files');
  const snapshot: Record<string, string> = {};
  files.forEach((value, path) => {
    Object.defineProperty(snapshot, path, {
      value: value instanceof Y.Text ? value.toJSON() : '', enumerable: true, configurable: true, writable: true,
    });
  });
  return snapshot;
}

export function getCodeAppFile(dappId: string, path: string): string {
  const files = getDappSourceDoc(dappId).getMap<Y.Text>('files');
  const file = files.get(normalizeCodeAppFilePath(path));
  return file instanceof Y.Text ? file.toJSON() : '';
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Bring `text` to `content` by replacing only the part that differs (common prefix and
 * suffix stay). Deleting everything and inserting the new content made two owner devices
 * that saved the same file while apart end up with BOTH versions one after the other:
 * each delete only covered what that device knew, each insert survived. With a minimal
 * change the two saves merge like ordinary concurrent edits.
 */
export function replaceTextMinimal(text: Y.Text, content: string): void {
  const current = text.toJSON();
  if (current === content) return;
  const limit = Math.min(current.length, content.length);
  let prefix = 0;
  while (prefix < limit && current.charCodeAt(prefix) === content.charCodeAt(prefix)) prefix += 1;
  // Never cut a surrogate pair in half.
  if (prefix > 0 && isHighSurrogate(current.charCodeAt(prefix - 1))) prefix -= 1;
  let suffix = 0;
  while (suffix < limit - prefix
    && current.charCodeAt(current.length - 1 - suffix) === content.charCodeAt(content.length - 1 - suffix)) suffix += 1;
  if (suffix > 0 && isHighSurrogate(current.charCodeAt(current.length - suffix - 1))) suffix -= 1;
  const removed = current.length - prefix - suffix;
  if (removed > 0) text.delete(prefix, removed);
  const inserted = content.slice(prefix, content.length - suffix);
  if (inserted) text.insert(prefix, inserted);
}

export function setCodeAppFile(dappId: string, path: string, content: string): void {
  requireRole(dappId, 'owner');
  assertCodeAppFileSize(content);
  const normalized = normalizeCodeAppFilePath(path);
  const doc = getDappSourceDoc(dappId);
  const files = doc.getMap<Y.Text>('files');
  let text = files.get(normalized);
  doc.transact(() => {
    if (!text) {
      text = new Y.Text();
      files.set(normalized, text);
    }
    replaceTextMinimal(text, content);
  });
  scheduleSourceSeal(dappId); // every owner write re-seals (sourceSeal.ts) — members run sealed source only
}

export function createCodeAppFile(dappId: string, path: string, content: string): void {
  requireRole(dappId, 'owner');
  assertCodeAppFileSize(content);
  const normalized = normalizeCodeAppFilePath(path);
  const doc = getDappSourceDoc(dappId);
  const files = doc.getMap<Y.Text>('files');
  if (files.has(normalized)) throw new Error(`Code App file already exists: ${normalized}`);

  const text = new Y.Text();
  text.insert(0, content);
  files.set(normalized, text);
  scheduleSourceSeal(dappId);
}

export function renameCodeAppFile(dappId: string, path: string, nextPath: string): void {
  requireRole(dappId, 'owner');
  const normalized = normalizeCodeAppFilePath(path);
  const normalizedNext = normalizeCodeAppFilePath(nextPath);
  const doc = getDappSourceDoc(dappId);
  const files = doc.getMap<Y.Text>('files');
  const current = files.get(normalized);
  if (!(current instanceof Y.Text)) throw new Error(`Code App file does not exist: ${normalized}`);
  if (files.has(normalizedNext)) throw new Error(`Code App file already exists: ${normalizedNext}`);

  const renamed = new Y.Text();
  renamed.insert(0, current.toJSON());
  doc.transact(() => {
    files.set(normalizedNext, renamed);
    files.delete(normalized);
  });
  scheduleSourceSeal(dappId);
}

export function deleteCodeAppFile(dappId: string, path: string): void {
  requireRole(dappId, 'owner');
  const normalized = normalizeCodeAppFilePath(path);
  const files = getDappSourceDoc(dappId).getMap<Y.Text>('files');
  if (!files.has(normalized)) throw new Error(`Code App file does not exist: ${normalized}`);
  files.delete(normalized);
  scheduleSourceSeal(dappId);
}

export function validateCodeAppFiles(snapshot: Record<string, string>): Record<string, string> {
  const entries = Object.entries(snapshot);
  if (entries.length === 0 || entries.length > MAX_CODE_APP_FILES) {
    throw new Error(`Code App source must contain 1–${MAX_CODE_APP_FILES} files`);
  }

  const normalized: Record<string, string> = {};
  let totalBytes = 0;
  const encoder = new TextEncoder();
  for (const [path, content] of entries) {
    if (typeof content !== 'string') throw new Error('Code App file contents must be strings');
    assertCodeAppFileSize(content);
    const normalizedPath = normalizeCodeAppFilePath(path);
    if (normalizedPath !== path || Object.hasOwn(normalized, normalizedPath)) {
      throw new Error('Code App source contains a non-canonical or duplicate path');
    }
    totalBytes += encoder.encode(normalizedPath).byteLength + encoder.encode(content).byteLength;
    if (totalBytes > MAX_CODE_APP_SOURCE_BYTES) {
      throw new Error(`Code App source is limited to ${MAX_CODE_APP_SOURCE_BYTES} bytes`);
    }
    Object.defineProperty(normalized, normalizedPath, {
      value: content, enumerable: true, configurable: true, writable: true,
    });
  }

  if (!Object.hasOwn(normalized, 'index.html') || !Object.hasOwn(normalized, 'manifest.yaml')) {
    throw new Error('Code App source requires index.html and manifest.yaml');
  }
  const manifest = parseCodeAppManifest(normalized['manifest.yaml']);
  if (manifest.error) throw new Error(`Invalid Code App manifest: ${manifest.error}`);
  validateCodeAppI18nFiles(normalized);
  return normalized;
}

/** Replace the complete source snapshot in one Yjs transaction. */
export function replaceCodeAppFiles(dappId: string, snapshot: Record<string, string>): void {
  const normalized = validateCodeAppFiles(snapshot);
  requireRole(dappId, 'owner');
  const doc = getDappSourceDoc(dappId);
  const files = doc.getMap<Y.Text>('files');
  doc.transact(() => {
    for (const path of [...files.keys()]) files.delete(path);
    for (const [path, content] of Object.entries(normalized)) {
      const text = new Y.Text();
      text.insert(0, content);
      files.set(path, text);
    }
  });
  scheduleSourceSeal(dappId);
}

export function initializeCodeAppSource(
  dappId: string,
  indexHtml = DEFAULT_CODE_APP_HTML,
  manifestYaml = DEFAULT_CODE_APP_MANIFEST_YAML,
): void {
  const files = getDappSourceDoc(dappId).getMap<Y.Text>('files');
  if (!files.has('index.html')) setCodeAppFile(dappId, 'index.html', indexHtml);
  if (!files.has('manifest.yaml')) setCodeAppFile(dappId, 'manifest.yaml', manifestYaml);
}
