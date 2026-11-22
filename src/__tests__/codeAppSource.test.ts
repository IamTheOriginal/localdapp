import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const sourceDocs = new Map<string, Y.Doc>();
const requireRole = vi.fn();

vi.mock('../services/store/docs.ts', () => ({
  getDappSourceDoc: (dappId: string) => {
    let doc = sourceDocs.get(dappId);
    if (!doc) {
      doc = new Y.Doc();
      sourceDocs.set(dappId, doc);
    }
    return doc;
  },
}));

vi.mock('../services/store/auth.ts', () => ({ requireRole }));

const {
  createCodeAppFile,
  deleteCodeAppFile,
  getCodeAppFile,
  getCodeAppFiles,
  normalizeCodeAppFilePath,
  renameCodeAppFile,
  replaceCodeAppFiles,
  validateCodeAppFiles,
  DEFAULT_CODE_APP_MANIFEST_YAML,
} = await import('../services/store/source.ts');
const { DEFAULT_CODE_APP_MANIFEST, parseCodeAppManifest } = await import('../services/codeAppManifest.ts');

const dappId = 'source-test';

describe('Code App source file CRUD', () => {
  beforeEach(() => {
    sourceDocs.clear();
    requireRole.mockReset();
  });

  it('creates nested files and preserves empty contents', () => {
    createCodeAppFile(dappId, 'styles/theme/app.css', 'body { color: red; }');
    createCodeAppFile(dappId, 'scripts/empty.js', '');

    expect(getCodeAppFiles(dappId)).toEqual({
      'styles/theme/app.css': 'body { color: red; }',
      'scripts/empty.js': '',
    });
    expect(requireRole).toHaveBeenCalledTimes(2);
    expect(requireRole).toHaveBeenNthCalledWith(1, dappId, 'owner');
  });

  it('rejects duplicate creation without overwriting the existing file', () => {
    createCodeAppFile(dappId, 'app.js', 'original');

    expect(() => createCodeAppFile(dappId, 'app.js', 'replacement')).toThrow(/already exists/i);
    expect(getCodeAppFile(dappId, 'app.js')).toBe('original');
  });

  it('renames atomically in one Yjs transaction', () => {
    createCodeAppFile(dappId, 'old/path.js', 'const answer = 42;');
    const sourceDoc = sourceDocs.get(dappId);
    if (!sourceDoc) throw new Error('Expected source document to exist');
    const files = sourceDoc.getMap<Y.Text>('files');
    const updates: string[][] = [];
    files.observe((event) => updates.push(Array.from(event.keysChanged, String).sort()));

    renameCodeAppFile(dappId, 'old/path.js', 'new/path.js');

    expect(getCodeAppFiles(dappId)).toEqual({ 'new/path.js': 'const answer = 42;' });
    expect(updates).toEqual([['new/path.js', 'old/path.js']]);
  });

  it('rejects a duplicate rename target without changing either file', () => {
    createCodeAppFile(dappId, 'one.js', 'one');
    createCodeAppFile(dappId, 'two.js', 'two');

    expect(() => renameCodeAppFile(dappId, 'one.js', 'two.js')).toThrow(/already exists/i);
    expect(getCodeAppFiles(dappId)).toEqual({ 'one.js': 'one', 'two.js': 'two' });
  });

  it('rejects stale rename and delete operations', () => {
    expect(() => renameCodeAppFile(dappId, 'missing.js', 'renamed.js')).toThrow(/does not exist/i);
    expect(() => deleteCodeAppFile(dappId, 'missing.js')).toThrow(/does not exist/i);
  });

  it('deletes an existing file', () => {
    createCodeAppFile(dappId, 'assets/icon.svg', '<svg />');

    deleteCodeAppFile(dappId, 'assets/icon.svg');

    expect(getCodeAppFiles(dappId)).toEqual({});
  });

  it.each([
    '',
    '   ',
    '/absolute.js',
    'trailing/',
    'double//slash.js',
    './relative.js',
    '../outside.js',
    'nested/../outside.js',
    'nested/./file.js',
    'windows\\path.js',
    'control\0file.js',
  ])('rejects invalid path %j', (path) => {
    expect(() => normalizeCodeAppFilePath(path)).toThrow('Invalid Code App file path');
    expect(() => createCodeAppFile(dappId, path, '')).toThrow('Invalid Code App file path');
  });

  it('normalizes surrounding whitespace while preserving valid nested paths', () => {
    expect(normalizeCodeAppFilePath('  vendor/library.js  ')).toBe('vendor/library.js');
  });

  it('enforces the 1,000,000-character limit without creating a file', () => {
    createCodeAppFile(dappId, 'large.txt', 'x'.repeat(1_000_000));
    expect(getCodeAppFile(dappId, 'large.txt')).toHaveLength(1_000_000);

    expect(() => createCodeAppFile(dappId, 'too-large.txt', 'x'.repeat(1_000_001))).toThrow(
      'Code App files are limited to 1 MB',
    );
    expect(getCodeAppFiles(dappId)).not.toHaveProperty('too-large.txt');
  });

  it('replaces the complete source snapshot atomically and removes stale defaults', () => {
    createCodeAppFile(dappId, 'old.js', 'stale');
    const manifest = JSON.stringify({ version: 1, routes: [{ path: '/', label: 'Home' }] });
    replaceCodeAppFiles(dappId, {
      'index.html': '<main>Imported</main>',
      'manifest.yaml': manifest,
      'app.js': 'console.log("ready")',
    });

    expect(getCodeAppFiles(dappId)).toEqual({
      'index.html': '<main>Imported</main>',
      'manifest.yaml': manifest,
      'app.js': 'console.log("ready")',
    });
    expect(requireRole).toHaveBeenLastCalledWith(dappId, 'owner');
  });

  it('validates the complete snapshot before replacing any source', () => {
    createCodeAppFile(dappId, 'old.js', 'stale');

    expect(() => replaceCodeAppFiles(dappId, {
      'index.html': '<main>Broken</main>',
      'manifest.yaml': '{not-json',
    })).toThrow(/invalid code app manifest/i);
    expect(getCodeAppFiles(dappId)).toEqual({ 'old.js': 'stale' });
  });

  it('ships a commented default manifest that parses to DEFAULT_CODE_APP_MANIFEST', () => {
    const result = parseCodeAppManifest(DEFAULT_CODE_APP_MANIFEST_YAML);
    expect(result.error).toBeNull();
    expect(result.manifest).toEqual(DEFAULT_CODE_APP_MANIFEST);
    expect(DEFAULT_CODE_APP_MANIFEST_YAML).toContain('#'); // the comments are the point
  });

  it('requires both entry files and applies aggregate source limits', () => {
    expect(() => validateCodeAppFiles({ 'index.html': '<main />' })).toThrow(/requires index.html and manifest.yaml/i);
    const manifest = JSON.stringify({ version: 1, routes: [{ path: '/', label: 'Home' }] });
    const oversized: Record<string, string> = { 'index.html': '', 'manifest.yaml': manifest };
    for (let index = 0; index < 5; index += 1) oversized[`part-${index}.txt`] = 'x'.repeat(900_000);
    expect(() => validateCodeAppFiles(oversized)).toThrow(/source is limited/i);
  });

  it('bounds source file counts and UTF-8 path bytes', () => {
    const manifest = JSON.stringify({ version: 1, routes: [{ path: '/', label: 'Home' }] });
    const maximum: Record<string, string> = { 'index.html': '', 'manifest.yaml': manifest };
    for (let index = 0; index < 62; index += 1) maximum[`part-${index}.txt`] = '';
    expect(() => validateCodeAppFiles(maximum)).not.toThrow();
    expect(() => validateCodeAppFiles({ ...maximum, 'overflow.txt': '' })).toThrow(/1–64 files/i);
    expect(() => validateCodeAppFiles({ 'index.html': '', 'manifest.yaml': manifest, [`${'a'.repeat(1_025)}.js`]: '' })).toThrow(/path is too long/i);
    expect(() => validateCodeAppFiles({ 'index.html': '', 'manifest.yaml': manifest, [`${'é'.repeat(600)}.js`]: '' })).toThrow(/invalid code app file path/i);
  });

  it.each([
    ['create', () => createCodeAppFile(dappId, 'new.js', '')],
    ['rename', () => renameCodeAppFile(dappId, 'old.js', 'new.js')],
    ['delete', () => deleteCodeAppFile(dappId, 'old.js')],
  ])('requires owner role for %s', (_operation, run) => {
    requireRole.mockImplementationOnce(() => {
      throw new Error('auth: Only owners can perform this action');
    });

    expect(run).toThrow('auth: Only owners can perform this action');
    expect(requireRole).toHaveBeenCalledWith(dappId, 'owner');
    expect(getCodeAppFiles(dappId)).toEqual({});
  });
});
