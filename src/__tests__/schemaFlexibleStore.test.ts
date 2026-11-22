import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

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

function createDappDoc(): Y.Doc {
  const doc = new Y.Doc();
  const schema = new Y.Map<unknown>();
  schema.set('entities', new Y.Map<unknown>());
  doc.getMap('config').set('schema', schema);
  return doc;
}

function entities(doc: Y.Doc): Y.Map<unknown> {
  const schema = doc.getMap('config').get('schema') as Y.Map<unknown>;
  return schema.get('entities') as Y.Map<unknown>;
}

describe('schema-flexible Code App $store collections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.docs.clear();
    mocks.docs.set('dapp-1', createDappDoc());
    mocks.getEntityRecords.mockReturnValue([]);
    mocks.addRecord.mockResolvedValue(undefined);
    mocks.updateRecord.mockResolvedValue(undefined);
    mocks.deleteRecord.mockResolvedValue(undefined);
  });

  it('uses an undeclared collection directly and creates it lazily through the Yjs record layer', async () => {
    const created = await handleStoreOperation('dapp-1', 'create', ['tasks', { title: 'Buy milk', done: false }]);

    expect(created).toMatchObject({ title: 'Buy milk', done: false, id: expect.any(String) as unknown });
    expect(mocks.addRecord).toHaveBeenCalledWith('dapp-1', 'tasks', created);
  });

  it('queries undeclared collections without requiring a visual schema entity', async () => {
    mocks.getEntityRecords.mockReturnValue([{ id: 'task-1', done: false }]);

    const records = await handleStoreOperation('dapp-1', 'query', ['tasks', { done: false }]);

    expect(records).toEqual([{ id: 'task-1', done: false }]);
    expect(mocks.getEntityRecords).toHaveBeenCalledWith('dapp-1', 'tasks');
  });

  it('preserves visual entity ID and display-name resolution', () => {
    const doc = mocks.docs.get('dapp-1') as Y.Doc;
    const entity = new Y.Map<unknown>();
    entity.set('name', 'Tasks');
    entities(doc).set('entity-uuid', entity);

    expect(resolveStoreCollectionId('dapp-1', 'entity-uuid')).toBe('entity-uuid');
    expect(resolveStoreCollectionId('dapp-1', 'Tasks')).toBe('entity-uuid');
  });

  it('keeps an existing app-owned collection stable when a visual entity later uses the same name', () => {
    const doc = mocks.docs.get('dapp-1') as Y.Doc;
    doc.getMap('data').set('tasks', new Y.Array());
    const entity = new Y.Map<unknown>();
    entity.set('name', 'tasks');
    entities(doc).set('visual-tasks', entity);

    expect(resolveStoreCollectionId('dapp-1', 'tasks')).toBe('tasks');
  });

  it('only writes plain, bounded JSON objects — a record is signed and replicated to every member forever', async () => {
    const create = (data: unknown) => handleStoreOperation('dapp-1', 'create', ['tasks', data]);
    await expect(create('just a string')).rejects.toThrow('plain object');
    await expect(create(['an', 'array'])).rejects.toThrow('plain object');
    await expect(create(new Map([['a', 1]]))).rejects.toThrow('plain object');
    await expect(create(new Uint8Array(8))).rejects.toThrow('plain object');
    await expect(create({ blob: 'x'.repeat(300_000) })).rejects.toThrow('256 KB');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(create(circular)).rejects.toThrow('JSON serializable');
    expect(mocks.addRecord).not.toHaveBeenCalled();

    // Non-JSON values inside an otherwise fine object are normalized away, not stored.
    await create({ title: 'ok', when: new Date(0), skip: undefined });
    expect(mocks.addRecord).toHaveBeenCalledTimes(1);
    const written = mocks.addRecord.mock.calls[0][2] as Record<string, unknown>;
    expect(written).toMatchObject({ title: 'ok', when: '1970-01-01T00:00:00.000Z' });
    expect('skip' in written).toBe(false);

    await expect(handleStoreOperation('dapp-1', 'update', ['tasks', { not: 'an id' }, { title: 'x' }])).rejects.toThrow('record id');
    await expect(handleStoreOperation('dapp-1', 'delete', ['tasks', 42])).rejects.toThrow('record id');
  });

  it('rejects invalid collection identifiers', () => {
    expect(() => resolveStoreCollectionId('dapp-1', '   ')).toThrow('1–128 characters');
    expect(() => resolveStoreCollectionId('dapp-1', 'bad\nname')).toThrow('control characters');
    expect(() => resolveStoreCollectionId('dapp-1', 42)).toThrow('must be a string');
  });
});
