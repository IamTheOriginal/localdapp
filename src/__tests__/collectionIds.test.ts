import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// Review 5.8: auth.ts and readModel.ts key records as `entityId:recordId` and
// split on the first `:` — a collection id containing `:` must never reach
// the store, neither from the `$store` bridge nor from a manifest.

const mocks = vi.hoisted(() => ({
  docs: new Map<string, unknown>(),
  getEntityRecords: vi.fn(),
  addRecord: vi.fn(),
  updateRecord: vi.fn(),
  deleteRecord: vi.fn(),
}));

vi.mock('../services/store/docs.ts', () => ({
  getDappDoc: (dappId: string) => {
    const doc = mocks.docs.get(dappId);
    if (!doc) throw new Error(`Missing test doc ${dappId}`);
    return doc;
  },
}));

vi.mock('../services/store/data.ts', () => ({
  getEntityRecords: mocks.getEntityRecords,
  addRecord: mocks.addRecord,
  updateRecord: mocks.updateRecord,
  deleteRecord: mocks.deleteRecord,
}));

import { handleStoreOperation, resolveStoreCollectionId } from '../services/codeAppStoreBridge.ts';
import { collectionIdProblem, parseCodeAppManifest } from '../services/codeAppManifest.ts';
import { loadStarterDefinitions } from './helpers/starterFixtures.ts';

function createDappDoc(): Y.Doc {
  const doc = new Y.Doc();
  const schema = new Y.Map<unknown>();
  schema.set('entities', new Y.Map<unknown>());
  doc.getMap('config').set('schema', schema);
  return doc;
}

function declareEntity(doc: Y.Doc, id: string, name: string) {
  const entity = new Y.Map<unknown>();
  entity.set('name', name);
  ((doc.getMap('config').get('schema') as Y.Map<unknown>).get('entities') as Y.Map<unknown>).set(id, entity);
}

describe('collection ids at the $store bridge', () => {
  let doc: Y.Doc;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.docs.clear();
    doc = createDappDoc();
    mocks.docs.set('dapp-1', doc);
    mocks.getEntityRecords.mockReturnValue([]);
    mocks.addRecord.mockResolvedValue(undefined);
    mocks.deleteRecord.mockResolvedValue(undefined);
  });

  it('rejects an app-owned collection name containing ":" before anything is written', async () => {
    expect(() => resolveStoreCollectionId('dapp-1', 'app:items')).toThrow(/cannot contain ":"/);
    await expect(handleStoreOperation('dapp-1', 'create', ['app:items', { title: 'x' }])).rejects.toThrow(/cannot contain ":"/);
    await expect(handleStoreOperation('dapp-1', 'delete', ['app:items', 'r1'])).rejects.toThrow(/cannot contain ":"/);
    await expect(handleStoreOperation('dapp-1', 'query', ['app:items'])).rejects.toThrow(/cannot contain ":"/);
    expect(mocks.addRecord).not.toHaveBeenCalled();
    expect(mocks.deleteRecord).not.toHaveBeenCalled();
  });

  it('rejects a ":" id even when it already exists in the doc or an old schema', () => {
    doc.getMap('data').set('left:over', new Y.Map());
    declareEntity(doc, 'old:entity', 'Old');
    expect(() => resolveStoreCollectionId('dapp-1', 'left:over')).toThrow(/cannot contain ":"/);
    expect(() => resolveStoreCollectionId('dapp-1', 'old:entity')).toThrow(/cannot contain ":"/);
    expect(() => resolveStoreCollectionId('dapp-1', 'Old')).toThrow(/cannot contain ":"/);
  });

  it('still resolves a display name with ":" that maps to a clean entity id, and ids with ":" in the record id', async () => {
    declareEntity(doc, 'notes', 'Notes: inbox');
    expect(resolveStoreCollectionId('dapp-1', 'Notes: inbox')).toBe('notes');
    await handleStoreOperation('dapp-1', 'delete', ['notes', 'record:with:colons']);
    expect(mocks.deleteRecord).toHaveBeenCalledWith('dapp-1', 'notes', 'record:with:colons');
  });

  it('names the separator in the shared check', () => {
    expect(collectionIdProblem('tasks')).toBeNull();
    expect(collectionIdProblem('a:b')).toBe('cannot contain ":"');
  });
});

describe('collection ids in the manifest', () => {
  const manifestWith = (id: string) => JSON.stringify({
    routes: [{ path: '/', label: 'Home' }],
    entities: [{ id, name: 'Items', fields: [{ id: 'title', name: 'Title', type: 'text' }] }],
  });

  it('fails closed on an entity id containing ":"', () => {
    const result = parseCodeAppManifest(manifestWith('app:items'));
    expect(result.error).toMatch(/cannot contain ":"/);
    expect(result.manifest.entities).toBeUndefined();
  });

  it('accepts a clean entity id', () => {
    expect(parseCodeAppManifest(manifestWith('items')).error).toBeNull();
  });

  it('keeps every shipped starter valid', () => {
    const starters = loadStarterDefinitions();
    expect(starters.length).toBeGreaterThan(0);
    for (const starter of starters) {
      const result = parseCodeAppManifest(starter.source['manifest.yaml']);
      expect(result.error, starter.id).toBeNull();
      for (const entity of result.manifest.entities ?? []) expect(collectionIdProblem(entity.id), `${starter.id}/${entity.id}`).toBeNull();
    }
  });
});
