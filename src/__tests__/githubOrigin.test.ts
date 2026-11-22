import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const state = vi.hoisted(() => {
  const role: string = 'owner';
  return {
    dappDocs: new Map<string, unknown>(),
    sourceDocs: new Map<string, unknown>(),
    role,
    createDapp: vi.fn(),
    removeDappCatalogEntry: vi.fn(),
    purgeDappLocalResources: vi.fn(),
  };
});

vi.mock('../services/store/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/store/config.ts')>();
  return { ...actual, createDapp: state.createDapp, removeDappCatalogEntry: state.removeDappCatalogEntry };
});
vi.mock('../services/store/docs.ts', () => ({
  getDappDoc: (id: string) => state.dappDocs.get(id),
  getDappsList: () => new Y.Doc().getArray('dapps'),
  getDappSourceDoc: (id: string) => state.sourceDocs.get(id),
  purgeDappLocalResources: state.purgeDappLocalResources,
  persistNewDapp: () => Promise.resolve(true),
}));
// The real source.ts runs against the in-memory source docs; only the role gate is scripted.
vi.mock('../services/store/auth.ts', () => ({
  requireRole: (_dappId: string, required: string) => {
    if (required === 'owner' && state.role !== 'owner') throw new Error('auth: owner role required');
  },
}));

import {
  applyGithubUpdate, createGithubDapp, diffGithubSnapshot, disconnectGithubOrigin, getGithubOrigin, githubSnapshotIdentity,
} from '../services/store/githubOrigin.ts';
import { getCodeAppFiles } from '../services/store/source.ts';
import type { GithubSourceSnapshot } from '../services/githubSource.ts';

const manifest = (name: string, extra = '') => `name: ${name}\nicon: "🧪"\ncolor: "#123456"\nroutes:\n  - path: /\n    label: Home\n${extra}`;
const ENTITIES = 'entities:\n  - id: tasks\n    name: Tasks\n    fields:\n      - id: title\n        name: Title\n        type: text\n';

function snapshot(overrides: Partial<GithubSourceSnapshot> = {}): GithubSourceSnapshot {
  return {
    location: { owner: 'acme', repo: 'app', ref: 'main', path: 'apps/todo' },
    commitSha: 'a'.repeat(40),
    fingerprint: '1'.repeat(64),
    blobs: {},
    skipped: [],
    files: { 'index.html': '<h1>v1</h1>', 'manifest.yaml': manifest('Todo'), 'app/main.js': 'one()' },
    ...overrides,
  };
}

function initializedDappDoc(): Y.Doc {
  const doc = new Y.Doc();
  const config = doc.getMap('config');
  const schema = new Y.Map<unknown>();
  schema.set('entities', new Y.Map());
  config.set('schema', schema);
  const meta = new Y.Map<string>();
  config.set('meta', meta);
  return doc;
}

describe('GitHub-linked dapps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.dappDocs.clear();
    state.sourceDocs.clear();
    state.role = 'owner';
    let nextId = 0;
    state.createDapp.mockImplementation(() => {
      nextId += 1;
      const id = `github-${nextId}`;
      state.dappDocs.set(id, initializedDappDoc());
      state.sourceDocs.set(id, new Y.Doc());
      return id;
    });
  });

  it('installs the snapshot as a new dapp named by its manifest and remembers the pinned origin', async () => {
    const id = await createGithubDapp(snapshot());
    expect(state.createDapp).toHaveBeenCalledWith('Todo', '🧪', '#123456');
    expect(getCodeAppFiles(id)).toEqual(snapshot().files);
    expect(getGithubOrigin(id)).toEqual(expect.objectContaining({
      owner: 'acme', repo: 'app', ref: 'main', path: 'apps/todo', commitSha: 'a'.repeat(40), fingerprint: '1'.repeat(64),
    }));
  });

  it('falls back to the repository name when the manifest declares no identity', () => {
    const bare = snapshot({ files: { 'index.html': 'x', 'manifest.yaml': 'routes:\n  - path: /\n    label: Home\n' } });
    expect(githubSnapshotIdentity(bare)).toEqual({ name: 'app', icon: '📦', color: '#6366f1' });
  });

  it('rolls the new dapp back when the sources are not a valid Code App', async () => {
    await expect(createGithubDapp(snapshot({ files: { 'index.html': 'x', 'manifest.yaml': 'routes: nope' } }))).rejects.toThrow();
    expect(state.createDapp).not.toHaveBeenCalled();

    // Valid files, but the install itself fails (not an owner): catalog entry and local resources are removed again.
    state.role = 'editor';
    await expect(createGithubDapp(snapshot())).rejects.toThrow('owner role required');
    expect(state.removeDappCatalogEntry).toHaveBeenCalledWith('github-1');
    expect(state.purgeDappLocalResources).toHaveBeenCalledWith('github-1');
  });

  it('lets only an owner apply a reviewed update, and re-pins the origin', async () => {
    const id = await createGithubDapp(snapshot());
    const next = snapshot({
      commitSha: 'b'.repeat(40),
      fingerprint: '2'.repeat(64),
      files: { 'index.html': '<h1>v2</h1>', 'manifest.yaml': manifest('Todo 2', ENTITIES), 'styles.css': 'body{}' },
    });
    expect(diffGithubSnapshot(id, next)).toEqual({ added: ['styles.css'], changed: ['index.html', 'manifest.yaml'], removed: ['app/main.js'], unchanged: 0 });

    state.role = 'editor';
    expect(() => applyGithubUpdate(id, next)).toThrow('owner role required');
    expect(getCodeAppFiles(id)).toEqual(snapshot().files);
    expect(getGithubOrigin(id)?.commitSha).toBe('a'.repeat(40));

    state.role = 'owner';
    applyGithubUpdate(id, next);
    expect(getCodeAppFiles(id)).toEqual(next.files);
    expect(getGithubOrigin(id)).toEqual(expect.objectContaining({ commitSha: 'b'.repeat(40), fingerprint: '2'.repeat(64) }));
    // The manifest stays the authority: name and entity schema follow the update.
    const dappDoc = state.dappDocs.get(id) as Y.Doc;
    expect((dappDoc.getMap('config').get('meta') as Y.Map<string>).get('name')).toBe('Todo 2');
    expect(((dappDoc.getMap('config').get('schema') as Y.Map<unknown>).get('entities') as Y.Map<unknown>).has('tasks')).toBe(true);
    expect(diffGithubSnapshot(id, next)).toEqual({ added: [], changed: [], removed: [], unchanged: 3 });
  });

  it('refuses updates that come from a different repository location or are not a valid Code App', async () => {
    const id = await createGithubDapp(snapshot());
    expect(() => applyGithubUpdate(id, snapshot({ location: { owner: 'mallory', repo: 'app', ref: 'main', path: 'apps/todo' } })))
      .toThrow('does not belong to the linked repository');
    expect(() => applyGithubUpdate(id, snapshot({ files: { 'index.html': 'x' } }))).toThrow('requires index.html and manifest.yaml');
    expect(getCodeAppFiles(id)).toEqual(snapshot().files);
  });

  it('treats a malformed (peer-tampered) origin as no origin', async () => {
    const id = await createGithubDapp(snapshot());
    const origin = (state.sourceDocs.get(id) as Y.Doc).getMap('origin');
    for (const [key, value] of [['owner', 'acme/../evil'], ['path', '../up'], ['commitSha', 'HEAD'], ['fingerprint', 'x'], ['provider', 'gitlab'], ['repo', 42]] as const) {
      const before = origin.get(key);
      origin.set(key, value);
      expect(getGithubOrigin(id), key).toBeNull();
      origin.set(key, before);
    }
    expect(getGithubOrigin(id)).not.toBeNull();
  });

  it('disconnects without touching the installed files — owners only', async () => {
    const id = await createGithubDapp(snapshot());
    state.role = 'viewer';
    expect(() => disconnectGithubOrigin(id)).toThrow('owner role required');
    state.role = 'owner';
    disconnectGithubOrigin(id);
    expect(getGithubOrigin(id)).toBeNull();
    expect(getCodeAppFiles(id)).toEqual(snapshot().files);
    expect(() => applyGithubUpdate(id, snapshot())).toThrow('not linked to a GitHub repository');
  });
});
