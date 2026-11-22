// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { buildCodeAppDocument } from '../services/codeAppRuntime.ts';
import {
  fetchStarterDefinition,
  parseStarterCatalog,
  validateStarterDefinition,
  type CodeAppStarterSummary,
} from '../services/store/starters.ts';
import { loadStarterDefinitions } from './helpers/starterFixtures.ts';

const ENTRY = { id: 'demo', name: 'Demo', icon: '🧪', color: '#123456', pitch: 'A demo' };
const MANIFEST = 'name: Demo\nroutes:\n  - path: /\n    label: Home\n';

function catalog(entry: Record<string, unknown>): unknown {
  return { schemaVersion: 1, starters: [entry] };
}

function fakeFetch(files: Record<string, string>) {
  return vi.fn((input: string | URL | Request) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = files[path];
    return Promise.resolve(body === undefined
      ? new Response('missing', { status: 404 })
      : new Response(body, { status: 200 }));
  });
}

describe('starter catalog file lists', () => {
  it('defaults to index.html + manifest.yaml and prepends them to a declared list', () => {
    expect(parseStarterCatalog(catalog(ENTRY))[0].files).toEqual(['index.html', 'manifest.yaml']);
    expect(parseStarterCatalog(catalog({ ...ENTRY, files: ['styles.css', 'app/main.js'] }))[0].files)
      .toEqual(['index.html', 'manifest.yaml', 'styles.css', 'app/main.js']);
  });

  it('rejects malformed, non-canonical, escaping and duplicate paths', () => {
    for (const files of [
      'styles.css',
      ['./styles.css'],
      ['/styles.css'],
      ['app/../styles.css'],
      ['app//main.js'],
      ['styles.css', 'styles.css'],
      ['index.html'],
      [''],
      [42],
    ]) {
      expect(() => parseStarterCatalog(catalog({ ...ENTRY, files })), JSON.stringify(files)).toThrow(/starter catalog/);
    }
  });

  it('fetches every listed file into the definition source and validates it as Code App source', async () => {
    const [summary] = parseStarterCatalog(catalog({ ...ENTRY, files: ['styles.css', 'app/main.js'] }));
    const fetchImpl = fakeFetch({
      '/starters/demo/index.html': '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><script src="app/main.js"></script></body></html>',
      '/starters/demo/manifest.yaml': MANIFEST,
      '/starters/demo/styles.css': 'body{margin:0}',
      '/starters/demo/app/main.js': 'globalThis.ran = true',
    });

    const definition = await fetchStarterDefinition(summary, fetchImpl);

    expect(Object.keys(definition.source)).toEqual(['index.html', 'manifest.yaml', 'styles.css', 'app/main.js']);
    expect(definition.source['app/main.js']).toBe('globalThis.ran = true');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('fails closed when a listed file is missing from the deployment', async () => {
    const [summary] = parseStarterCatalog(catalog({ ...ENTRY, files: ['app/main.js'] }));
    const fetchImpl = fakeFetch({
      '/starters/demo/index.html': '<!doctype html><html></html>',
      '/starters/demo/manifest.yaml': MANIFEST,
    });
    await expect(fetchStarterDefinition(summary, fetchImpl)).rejects.toThrow(/Failed to load \/starters\/demo\/app\/main\.js \(404\)/);
  });

  it('re-validates a hand-built summary file list before fetching', async () => {
    const summary: CodeAppStarterSummary = { ...ENTRY, files: ['index.html', 'manifest.yaml', '../escape.js'] };
    await expect(fetchStarterDefinition(summary, fakeFetch({}))).rejects.toThrow(/invalid file path/);
  });

  it('rejects a definition whose source does not match its file list', () => {
    const source = { 'index.html': '<!doctype html><html></html>', 'manifest.yaml': MANIFEST, 'extra.js': '' };
    expect(() => validateStarterDefinition({ ...ENTRY, files: ['index.html', 'manifest.yaml'], source }))
      .toThrow(/does not match its file list/);
    expect(() => validateStarterDefinition({ ...ENTRY, files: ['index.html', 'manifest.yaml', 'missing.js'], source: { 'index.html': source['index.html'], 'manifest.yaml': MANIFEST } }))
      .toThrow(/does not match its file list/);
  });
});

describe('multi-file starters at runtime', () => {
  it('assembles the shipped To-Do List into one self-contained sandbox document', () => {
    const todo = loadStarterDefinitions().find((starter) => starter.id === 'todo-list');
    if (!todo) throw new Error('todo-list starter missing');
    expect(todo.files.length).toBeGreaterThan(2);

    const bundle = buildCodeAppDocument(todo.source, 'runtime-todo');
    try {
      const documentNode = new DOMParser().parseFromString(bundle.srcdoc, 'text/html');
      // Every linked script and stylesheet was inlined; nothing is left to fetch.
      expect(documentNode.querySelectorAll('script[src], link').length).toBe(0);
      const scripts = [...documentNode.querySelectorAll('script')].map((script) => script.textContent || '');
      const linked = todo.files.filter((path) => path.endsWith('.js'));
      for (const path of linked) {
        expect(scripts.some((code) => code === todo.source[path]), path).toBe(true);
      }
      // Document order is preserved: the state module runs before the wiring that uses it.
      const stateIndex = scripts.findIndex((code) => code === todo.source['app/tasks.js']);
      const mainIndex = scripts.findIndex((code) => code === todo.source['app/main.js']);
      expect(stateIndex).toBeGreaterThan(-1);
      expect(mainIndex).toBeGreaterThan(stateIndex);
      expect(documentNode.querySelector('style')?.textContent).toContain('min-height: 44px');
    } finally {
      bundle.dispose();
    }
  });
});
