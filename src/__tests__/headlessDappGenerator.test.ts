import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DappGenerator, extractJsonObject, parseGeneratedDapp } from '../headless/dappGenerator.ts';
import { RevisionStore } from '../headless/revisions.ts';
import type { LlmChatResult, LlmMessage } from '../headless/llm.ts';

const VALID_MANIFEST = 'name: Notes\nicon: 📝\ncolor: "#112233"\nroutes:\n  - path: /\n    label: Notes\n';
const VALID_HTML = '<!doctype html><html><body><h1>Notes</h1><script>Dapp.onReady(() => {});</script></body></html>';

function fakeLlm(answers: string[]) {
  const seen: LlmMessage[][] = [];
  return {
    seen,
    chat: (messages: LlmMessage[]): Promise<LlmChatResult> => {
      seen.push(messages.map((message) => ({ ...message })));
      const content = answers.shift() ?? '';
      return Promise.resolve({ content, model: 'fake-model', usage: null });
    },
  };
}

describe('dapp generator', () => {
  it('extracts JSON from fenced or chatty answers', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Sure! Here it is: {"a":{"b":[1,2]}} Enjoy.')).toEqual({ a: { b: [1, 2] } });
    expect(() => extractJsonObject('no json here')).toThrow('no JSON object');
  });

  it('validates the file map like an imported dapp and fills identity from the manifest', () => {
    const dapp = parseGeneratedDapp({ files: { 'index.html': VALID_HTML, 'manifest.yaml': VALID_MANIFEST } }, { name: 'x', icon: 'y', color: '#000000' });
    expect(dapp).toMatchObject({ name: 'Notes', icon: '📝', color: '#112233' });
    expect(Object.keys(dapp.files).sort()).toEqual(['index.html', 'manifest.yaml']);
    expect(() => parseGeneratedDapp({ files: { 'index.html': VALID_HTML } }, { name: 'x', icon: 'y', color: '#000000' })).toThrow();
    expect(() => parseGeneratedDapp({ files: { 'index.html': VALID_HTML, 'manifest.yaml': 'routes: [' } }, { name: 'x', icon: 'y', color: '#000000' })).toThrow(/manifest/i);
    expect(() => parseGeneratedDapp({ files: 'nope' }, { name: 'x', icon: 'y', color: '#000000' })).toThrow('"files"');
  });

  it('sends the docs as system prompt, the current source for edits, and repairs once on validation errors', async () => {
    const good = JSON.stringify({ name: 'Notes', icon: '📝', color: '#112233', files: { 'index.html': VALID_HTML, 'manifest.yaml': VALID_MANIFEST } });
    const llm = fakeLlm(['{"files": {"index.html": "<!doctype html>"}}', good]);
    const generator = new DappGenerator({ llm, docs: () => Promise.resolve('THE DOCS'), repairRounds: 1 });
    const result = await generator.generate({ prompt: 'add tags', current: { name: 'Old', icon: '🗒️', color: '#ffffff', files: { 'index.html': '<!doctype html><p>old</p>', 'manifest.yaml': 'name: Old' } } });

    expect(result.name).toBe('Notes');
    expect(llm.seen).toHaveLength(2);
    expect(llm.seen[0][0].role).toBe('system');
    expect(llm.seen[0][0].content).toContain('THE DOCS');
    expect(llm.seen[0][1].content).toContain('<p>old</p>');
    expect(llm.seen[0][1].content).toContain('add tags');
    expect(llm.seen[1]).toHaveLength(4);
    expect(llm.seen[1][3].content).toContain('failed validation');
  });

  it('gives up after the repair budget with the last validation error', async () => {
    const llm = fakeLlm(['garbage', 'still garbage']);
    const generator = new DappGenerator({ llm, docs: 'docs', repairRounds: 1 });
    await expect(generator.generate({ prompt: 'anything' })).rejects.toThrow('failed validation: answer contains no JSON object');
  });

  it('repairs an edit that drops an existing camera permission', async () => {
    const cameraManifest = `${VALID_MANIFEST}permissions:\n  device:\n    camera: true\n`;
    const withoutCamera = JSON.stringify({ files: { 'index.html': VALID_HTML, 'manifest.yaml': VALID_MANIFEST } });
    const withCamera = JSON.stringify({ files: { 'index.html': VALID_HTML, 'manifest.yaml': cameraManifest } });
    const llm = fakeLlm([withoutCamera, withCamera]);
    const generator = new DappGenerator({ llm, docs: 'docs', repairRounds: 1 });

    const result = await generator.generate({
      prompt: 'make the camera preview larger',
      current: { name: 'Notes', icon: '📝', color: '#112233', files: { 'index.html': VALID_HTML, 'manifest.yaml': cameraManifest } },
    });

    expect(result.files['manifest.yaml']).toContain('camera: true');
    expect(llm.seen).toHaveLength(2);
    expect(llm.seen[1][3].content).toContain('removed the existing permissions.device.camera');
  });

  it('surfaces missing docs without calling the model', async () => {
    const llm = fakeLlm(['{}']);
    const generator = new DappGenerator({ llm, docs: () => Promise.reject(new Error('ENOENT')) });
    await expect(generator.generate({ prompt: 'x' })).rejects.toThrow('docs unavailable');
    expect(llm.seen).toHaveLength(0);
  });
});

describe('RevisionStore', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  it('saves, lists newest-first, and loads snapshots per dapp', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'revisions-'));
    dirs.push(dir);
    const store = new RevisionStore(dir);
    const first = await store.save('dapp-a', { 'index.html': 'v1' }, 'created', new Date('2026-09-09T10:00:00.000Z'));
    const second = await store.save('dapp-a', { 'index.html': 'v2' }, 'before: change', new Date('2026-09-09T11:00:00.000Z'));
    expect(await store.list('dapp-a')).toEqual([
      { id: second, at: '2026-09-09T11:00:00.000Z', note: 'before: change' },
      { id: first, at: '2026-09-09T10:00:00.000Z', note: 'created' },
    ]);
    expect(await store.load('dapp-a', first)).toEqual({ 'index.html': 'v1' });
    expect(await store.list('dapp-b')).toEqual([]);
    await expect(store.load('dapp-a', '../etc')).rejects.toThrow('invalid revision id');
    await expect(store.load('dapp-a', '2026-01-01T00-00-00.000Z')).rejects.toThrow();
  });

  it('serves the summaries from memory until the next save', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'revisions-'));
    dirs.push(dir);
    const store = new RevisionStore(dir);
    await store.save('dapp-a', { 'index.html': 'v1' }, 'created', new Date('2026-09-09T10:00:00.000Z'));
    const readdir = vi.spyOn(fs, 'readdir');
    const readFile = vi.spyOn(fs, 'readFile');
    try {
      const listed = await store.list('dapp-a');
      expect(listed).toHaveLength(1);
      expect(await store.list('dapp-b')).toEqual([]);
      const reads = readdir.mock.calls.length + readFile.mock.calls.length;
      expect(reads).toBeGreaterThan(0);

      // The status tick: repeated lists of unchanged dapps touch no disk,
      // and a caller mutating its copy does not reach the cache.
      listed.pop();
      expect(await store.list('dapp-a')).toHaveLength(1);
      expect(await store.list('dapp-b')).toEqual([]);
      expect(readdir.mock.calls.length + readFile.mock.calls.length).toBe(reads);

      const second = await store.save('dapp-a', { 'index.html': 'v2' }, 'before: change', new Date('2026-09-09T11:00:00.000Z'));
      expect((await store.list('dapp-a')).map((summary) => summary.id)).toEqual([second, '2026-09-09T10-00-00.000Z']);
      expect(readFile.mock.calls.length).toBeGreaterThan(0);
      // Only the saved dapp was read again.
      const afterSave = readdir.mock.calls.length + readFile.mock.calls.length;
      expect(await store.list('dapp-b')).toEqual([]);
      expect(readdir.mock.calls.length + readFile.mock.calls.length).toBe(afterSave);
    } finally {
      readdir.mockRestore();
      readFile.mockRestore();
    }
  });

  it('prunes to the newest 20 snapshots per dapp on save', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'revisions-'));
    dirs.push(dir);
    const store = new RevisionStore(dir);
    const ids: string[] = [];
    for (let minute = 0; minute < 23; minute++) {
      ids.push(await store.save('dapp-a', { 'index.html': `v${minute}` }, `note ${minute}`, new Date(Date.UTC(2026, 8, 9, 10, minute))));
    }
    await store.save('dapp-b', { 'index.html': 'other' }, 'created', new Date(Date.UTC(2026, 8, 9, 9, 0)));

    const newest = ids.slice(-20).reverse();
    expect((await store.list('dapp-a')).map((summary) => summary.id)).toEqual(newest);
    expect((await fs.readdir(path.join(dir, 'revisions', 'dapp-a'))).sort()).toEqual(newest.map((id) => `${id}.json`).sort());
    await expect(store.load('dapp-a', ids[0])).rejects.toThrow();
    expect(await store.load('dapp-a', ids[3])).toEqual({ 'index.html': 'v3' });
    // Pruning is per dapp.
    expect(await store.list('dapp-b')).toHaveLength(1);
  });

  it('never prunes the snapshot it just wrote, even when its timestamp sorts oldest', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'revisions-'));
    dirs.push(dir);
    const store = new RevisionStore(dir);
    for (let minute = 0; minute < 20; minute++) {
      await store.save('dapp-a', { 'index.html': `v${minute}` }, `note ${minute}`, new Date(Date.UTC(2026, 8, 9, 10, minute)));
    }
    const early = await store.save('dapp-a', { 'index.html': 'early' }, 'clock jumped back', new Date(Date.UTC(2026, 8, 9, 9, 0)));
    expect(await store.load('dapp-a', early)).toEqual({ 'index.html': 'early' });
  });
});
