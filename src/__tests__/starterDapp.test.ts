import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const state = vi.hoisted(() => {
  const files = new Map<string, Record<string, string>>();
  return {
    docs: new Map<string, unknown>(),
    files,
    createDapp: vi.fn(),
    removeDappCatalogEntry: vi.fn(),
    purgeDappLocalResources: vi.fn(),
    persistNewDapp: vi.fn((id: string) => Promise.resolve(id.length > 0)),
    replaceCodeAppFiles: vi.fn((id: string, snapshot: Record<string, string>) => { files.set(id, snapshot); }),
  };
});

vi.mock('../services/store/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/store/config.ts')>();
  // The real seedDappSchema runs against the mocked docs, so the entity
  // assertions below exercise the shared seeding path.
  return { ...actual, createDapp: state.createDapp, removeDappCatalogEntry: state.removeDappCatalogEntry };
});
vi.mock('../services/store/docs.ts', () => ({
  getDappDoc: (id: string) => state.docs.get(id),
  // syncManifestMeta mirrors the manifest identity into the catalog after install.
  getDappsList: () => new Y.Doc().getArray('dapps'),
  getDappSourceDoc: vi.fn(),
  purgeDappLocalResources: state.purgeDappLocalResources,
  persistNewDapp: state.persistNewDapp,
}));
vi.mock('../services/store/source.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/store/source.ts')>();
  return {
    ...actual,
    replaceCodeAppFiles: state.replaceCodeAppFiles,
    // syncManifestEntities reads the manifest back after installation.
    getCodeAppFile: (id: string, path: string) => state.files.get(id)?.[path] ?? '',
  };
});

import { createStarterDapp } from '../services/store/starters.ts';
import { parseCodeAppManifest } from '../services/codeAppManifest.ts';
import { loadStarterDefinitions } from './helpers/starterFixtures.ts';

const CODE_APP_STARTERS = loadStarterDefinitions();

function initializedDoc(): Y.Doc {
  const doc = new Y.Doc();
  const config = doc.getMap('config');
  const schema = new Y.Map<unknown>();
  schema.set('entities', new Y.Map());
  config.set('schema', schema);
  doc.getMap('data');
  doc.getMap('appData');
  doc.getMap('recordTombstones');
  return doc;
}

describe('createStarterDapp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.docs.clear();
    state.files.clear();
    let nextId = 0;
    state.createDapp.mockImplementation(() => {
      nextId += 1;
      const id = `starter-${nextId}`;
      state.docs.set(id, initializedDoc());
      return id;
    });
  });

  it('creates every starter with its declared schema metadata and one complete source replacement', async () => {
    for (const starter of CODE_APP_STARTERS) {
      const id = await createStarterDapp(starter);
      const doc = state.docs.get(id) as Y.Doc;
      const config = doc.getMap('config');
      const schema = config.get('schema') as Y.Map<unknown>;
      const entities = schema.get('entities') as Y.Map<Y.Map<unknown>>;
      const declared = parseCodeAppManifest(starter.source['manifest.yaml']).manifest.entities ?? [];
      if (declared.length > 0) {
        expect([...entities.keys()]).toEqual(declared.map((entity) => entity.id));
      } else {
        // Runtime-managed-schema starters keep the seeded schema empty.
        expect(starter.id).toBe('app-studio');
        expect(entities.size).toBe(0);
      }
      expect(doc.getMap('data').size).toBe(0);
      expect(doc.getMap('appData').size).toBe(0);
      expect(doc.getMap('recordTombstones').size).toBe(0);
      expect(state.createDapp).toHaveBeenLastCalledWith(starter.name, starter.icon, starter.color);
      expect(state.replaceCodeAppFiles).toHaveBeenLastCalledWith(id, starter.source);
      // Stored before it is reported as created (a reload right after must not lose it).
      expect(state.persistNewDapp).toHaveBeenLastCalledWith(id);
    }
    expect(state.replaceCodeAppFiles).toHaveBeenCalledTimes(11);
  });

  it('rejects an invalid starter definition before creating catalog state', async () => {
    const broken = { ...CODE_APP_STARTERS[0], source: { ...CODE_APP_STARTERS[0].source, 'manifest.yaml': '{ not valid yaml' } };
    await expect(createStarterDapp(broken)).rejects.toThrow(/invalid starter manifest/i);
    expect(state.createDapp).not.toHaveBeenCalled();
    expect(state.replaceCodeAppFiles).not.toHaveBeenCalled();
  });

  it('rolls back catalog and local resources when source installation fails', async () => {
    state.replaceCodeAppFiles.mockImplementationOnce(() => { throw new Error('source failed'); });

    await expect(createStarterDapp(CODE_APP_STARTERS[0])).rejects.toThrow('source failed');

    expect(state.removeDappCatalogEntry).toHaveBeenCalledWith('starter-1');
    expect(state.purgeDappLocalResources).toHaveBeenCalledWith('starter-1');
  });
});
