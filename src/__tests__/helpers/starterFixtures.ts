import {
  parseStarterCatalog,
  type CodeAppStarterDefinition,
  type CodeAppStarterSummary,
} from '../../services/store/starters.ts';

/**
 * Loads the shipped starter content from `public/starters/` for tests. Tests
 * exercising these fixtures are validating the exact static files a deployment
 * serves — content defects fail here, before any user fetches them.
 *
 * Uses `import.meta.glob` (bundled eagerly by vitest's vite pipeline) instead
 * of `node:fs` so the repo keeps its browser-only type surface.
 */
const files = import.meta.glob('/public/starters/**/*', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function file(path: string): string {
  const content = files[`/public/starters/${path}`];
  if (typeof content !== 'string') throw new Error(`starter fixtures: missing public/starters/${path}`);
  return content;
}

export function loadStarterCatalog(): CodeAppStarterSummary[] {
  return parseStarterCatalog(JSON.parse(file('index.json')));
}

/** Every file that exists on disk under `public/starters/<id>/`, as canonical starter-relative paths. */
export function loadStarterFilePathsOnDisk(starterId: string): string[] {
  const prefix = `/public/starters/${starterId}/`;
  return Object.keys(files).filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length)).sort();
}

export function loadStarterDefinitions(): CodeAppStarterDefinition[] {
  return loadStarterCatalog().map((summary) => ({
    ...summary,
    source: Object.fromEntries(summary.files.map((path) => [path, file(`${summary.id}/${path}`)])),
  }));
}

/**
 * The executable source of a starter in load order: every inline `<script>`
 * of `index.html` plus every linked local script, resolved from the file map
 * the way the runtime does (`<script src>` → inlined file). Only the
 * executable scripts a browser would run; JSON/data blocks are skipped.
 */
export function starterScripts(starter: CodeAppStarterDefinition): Array<{ path: string; code: string }> {
  const html = starter.source['index.html'];
  const scripts: Array<{ path: string; code: string }> = [];
  for (const match of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1] ?? '';
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1]?.toLowerCase();
    if (type && type !== 'text/javascript' && type !== 'application/javascript') continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    if (src) {
      const code = starter.source[src];
      if (typeof code !== 'string') throw new Error(`starter fixtures: ${starter.id} links missing script ${src}`);
      scripts.push({ path: src, code });
    } else {
      scripts.push({ path: 'index.html', code: match[2] });
    }
  }
  return scripts;
}
