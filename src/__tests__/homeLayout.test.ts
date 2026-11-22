import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  between,
  buildHomeLayout,
  createFolderFromDapps,
  flattenHomeOrder,
  homeNodeId,
  moveDapp,
  moveFolder,
  nextTopLevelSortOrder,
  pruneFolders,
  readCatalogItems,
  readFolders,
  readHomeLayout,
  renameFolder,
  stepTarget,
  ungroupFolder,
} from '../services/store/homeLayout.ts';

/** A plain catalog doc; `sortOrder` omitted unless given (legacy `1..n` by default). */
function catalogDoc(ids: string[], fields: (id: string, index: number) => Record<string, string> = (_id, index) => ({ sortOrder: String(index + 1) })): Y.Doc {
  const doc = new Y.Doc();
  const list = doc.getArray<Y.Map<string>>('dapps');
  ids.forEach((id, index) => {
    const item = new Y.Map<string>();
    const all = { id, name: id.toUpperCase(), roomId: `room-${id}`, roomPassword: `secret-${id}`, ...fields(id, index) };
    Object.entries(all).forEach(([key, value]) => item.set(key, value));
    list.push([item]);
  });
  return doc;
}

function item(doc: Y.Doc, id: string): Y.Map<string> {
  const found = doc.getArray<Y.Map<string>>('dapps').toArray().find((entry) => entry.get('id') === id);
  if (!found) throw new Error(`no catalog item ${id}`);
  return found;
}

const order = (doc: Y.Doc) => readHomeLayout(doc).map(homeNodeId);
const flat = (doc: Y.Doc) => flattenHomeOrder(readHomeLayout(doc)).map((dapp) => dapp.id);

describe('between', () => {
  it('spaces by 1024 at the ends, bisects in between and reports an exhausted gap', () => {
    expect(between(null, null)).toBe(1024);
    expect(between(null, 1024)).toBe(0);
    expect(between(2048, null)).toBe(3072);
    expect(between(1024, 2048)).toBe(1536);
    expect(between(1, 2)).toBeNull();
    expect(between(5, 5)).toBeNull();
  });
});

describe('dapp order', () => {
  it('keeps the legacy 1..n order and falls back to the array index without a sortOrder', () => {
    expect(order(catalogDoc(['a', 'b', 'c']))).toEqual(['a', 'b', 'c']);
    expect(order(catalogDoc(['a', 'b', 'c'], () => ({})))).toEqual(['a', 'b', 'c']);
    expect(order(catalogDoc(['a', 'b', 'c'], (_id, index) => ({ sortOrder: String(30 - index) })))).toEqual(['c', 'b', 'a']);
  });

  it('renumbers the sibling set when the gap is exhausted', () => {
    const doc = catalogDoc(['a', 'b', 'c']);
    expect(moveDapp('c', { beforeId: 'b' }, doc)).toBe(true);
    expect(order(doc)).toEqual(['a', 'c', 'b']);
    expect(['a', 'c', 'b'].map((id) => item(doc, id).get('sortOrder'))).toEqual(['0', '1024', '2048']);

    // With room between neighbours only the moved item is written.
    expect(moveDapp('b', { beforeId: 'c' }, doc)).toBe(true);
    expect(order(doc)).toEqual(['a', 'b', 'c']);
    expect(item(doc, 'b').get('sortOrder')).toBe('512');
    expect(item(doc, 'a').get('sortOrder')).toBe('0');
  });

  it('moves to the top and to the end, and writes nothing for a no-op or a stale target', () => {
    const doc = catalogDoc(['a', 'b', 'c']);
    moveDapp('c', { beforeId: 'a' }, doc);
    expect(order(doc)).toEqual(['c', 'a', 'b']);
    moveDapp('c', {}, doc);
    expect(order(doc)).toEqual(['a', 'b', 'c']);

    let updates = 0;
    doc.on('update', () => { updates++; });
    expect(moveDapp('a', { beforeId: 'b' }, doc)).toBe(false); // already there
    expect(moveDapp('a', { beforeId: 'a' }, doc)).toBe(false); // dropped on itself
    expect(moveDapp('a', { beforeId: 'gone' }, doc)).toBe(false);
    expect(moveDapp('gone', { beforeId: 'a' }, doc)).toBe(false);
    expect(moveDapp('a', { folderId: 'no-folder' }, doc)).toBe(false);
    expect(updates).toBe(0);
  });

  it('never re-creates a catalog item: map identity, array length and credentials survive a move', () => {
    const doc = catalogDoc(['a', 'b', 'c']);
    const before = item(doc, 'c');
    moveDapp('c', { beforeId: 'a' }, doc);
    expect(item(doc, 'c')).toBe(before);
    expect(doc.getArray('dapps').length).toBe(3);
    expect(doc.getArray<Y.Map<string>>('dapps').toArray().map((entry) => entry.get('id'))).toEqual(['a', 'b', 'c']);
    expect(item(doc, 'c').get('roomId')).toBe('room-c');
    expect(item(doc, 'c').get('roomPassword')).toBe('secret-c');
  });

  it('merges concurrent moves from two docs without duplicates', () => {
    const one = catalogDoc(['a', 'b', 'c', 'd']);
    const two = new Y.Doc();
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));

    moveDapp('d', { beforeId: 'a' }, one);
    moveDapp('a', {}, two);
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two));

    expect(one.getArray('dapps').length).toBe(4);
    expect([...order(one)].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(order(one)).toEqual(order(two));
  });

  it('leaves archived items out of the layout', () => {
    const doc = catalogDoc(['a', 'b', 'c'], (id, index) => ({
      sortOrder: String(index + 1),
      ...(id === 'b' ? { archivedAt: '2026-01-01T00:00:00.000Z' } : {}),
    }));
    expect(order(doc)).toEqual(['a', 'c']);
    expect(moveDapp('b', { beforeId: 'a' }, doc)).toBe(false);
    expect(readCatalogItems(doc).filter((entry) => entry.archivedAt).map((entry) => entry.id)).toEqual(['b']);
  });

  it('appends new entries after every top-level dapp and folder', () => {
    const doc = catalogDoc(['a', 'b', 'c']);
    expect(nextTopLevelSortOrder(new Y.Doc())).toBe('1024');
    expect(nextTopLevelSortOrder(doc)).toBe(String(3 + 1024));
    createFolderFromDapps('c', 'a', 'Work', doc);
    doc.getMap<Y.Map<string>>('dappFolders').forEach((folder) => folder.set('sortOrder', '9000'));
    expect(nextTopLevelSortOrder(doc)).toBe(String(9000 + 1024));
  });

  it('maps menu steps to drop positions', () => {
    const ids = ['a', 'b', 'c'];
    expect(stepTarget(ids, 'b', 'up')).toBe('a');
    expect(stepTarget(ids, 'a', 'up')).toBeUndefined();
    expect(stepTarget(ids, 'a', 'down')).toBe('c');
    expect(stepTarget(ids, 'b', 'down')).toBeNull();
    expect(stepTarget(ids, 'c', 'down')).toBeUndefined();
    expect(stepTarget(ids, 'c', 'top')).toBe('a');
    expect(stepTarget(ids, 'a', 'top')).toBeUndefined();
  });
});

describe('folders', () => {
  function folderDoc(): { doc: Y.Doc; folderId: string } {
    const doc = catalogDoc(['a', 'b', 'c', 'd']);
    const folderId = createFolderFromDapps('b', 'd', 'Work', doc);
    if (!folderId) throw new Error('folder was not created');
    return { doc, folderId };
  }

  it('creates a folder at the target position holding both dapps, target first', () => {
    const { doc, folderId } = folderDoc();
    expect(order(doc)).toEqual(['a', folderId, 'c']);
    expect(flat(doc)).toEqual(['a', 'b', 'd', 'c']);
    expect(readFolders(doc)).toEqual([expect.objectContaining({ id: folderId, name: 'Work', sortOrder: 2 })]);
    expect(item(doc, 'd').get('roomPassword')).toBe('secret-d');
  });

  it('refuses a folder inside a folder and a dapp dropped on itself', () => {
    const { doc } = folderDoc();
    expect(createFolderFromDapps('b', 'a', 'Nested', doc)).toBeNull(); // b already sits in a folder
    expect(createFolderFromDapps('a', 'a', 'Self', doc)).toBeNull();
    expect(readFolders(doc)).toHaveLength(1);
  });

  it('adds to a folder, reorders inside it and moves back out', () => {
    const { doc, folderId } = folderDoc();
    expect(moveDapp('a', { folderId }, doc)).toBe(true);
    expect(flat(doc)).toEqual(['b', 'd', 'a', 'c']);
    expect(moveDapp('a', { folderId, beforeId: 'b' }, doc)).toBe(true);
    expect(flat(doc)).toEqual(['a', 'b', 'd', 'c']);
    expect(moveDapp('a', { beforeId: 'c' }, doc)).toBe(true);
    expect(order(doc)).toEqual([folderId, 'a', 'c']);
    expect(item(doc, 'a').get('folderId')).toBeUndefined();
  });

  it('dissolves at one member — the survivor takes the folder position — on read and physically on the next write', () => {
    const { doc, folderId } = folderDoc();
    moveFolder(folderId, null, doc);
    expect(order(doc)).toEqual(['a', 'c', folderId]);

    // "Leave": the archive path knows nothing about folders.
    item(doc, 'b').set('archivedAt', '2026-01-01T00:00:00.000Z');
    expect(order(doc)).toEqual(['a', 'c', 'd']);
    expect(readHomeLayout(doc).every((node) => node.kind === 'dapp' && !node.dapp.folderId)).toBe(true);
    expect(doc.getMap('dappFolders').size).toBe(1); // still stored

    moveDapp('a', {}, doc); // any layout write prunes
    expect(doc.getMap('dappFolders').size).toBe(0);
    expect(item(doc, 'd').get('folderId')).toBeUndefined();
    expect(item(doc, 'b').get('folderId')).toBeUndefined();
    expect(order(doc)).toEqual(['c', 'd', 'a']);
  });

  it('dissolves when the second-to-last member is dragged out', () => {
    const { doc } = folderDoc();
    moveDapp('d', { beforeId: 'a' }, doc);
    expect(order(doc)).toEqual(['d', 'a', 'b', 'c']);
    expect(doc.getMap('dappFolders').size).toBe(0);
  });

  it('dissolves at zero members, e.g. after the dapps were deleted from the catalog', () => {
    const { doc } = folderDoc();
    const list = doc.getArray<Y.Map<string>>('dapps');
    list.delete(3, 1); // d
    list.delete(1, 1); // b
    expect(order(doc)).toEqual(['a', 'c']);
    pruneFolders(doc);
    expect(doc.getMap('dappFolders').size).toBe(0);
  });

  it('treats a folder of only archived members as absent', () => {
    const { doc } = folderDoc();
    item(doc, 'b').set('archivedAt', 'x');
    item(doc, 'd').set('archivedAt', 'x');
    expect(order(doc)).toEqual(['a', 'c']);
  });

  it('treats a dangling folderId as top level', () => {
    const doc = catalogDoc(['a', 'b'], (id, index) => ({ sortOrder: String(index + 1), ...(id === 'a' ? { folderId: 'gone' } : {}) }));
    expect(order(doc)).toEqual(['a', 'b']);
    const [first] = readHomeLayout(doc);
    expect(first.kind === 'dapp' ? first.dapp.folderId : first.kind).toBeUndefined();
    pruneFolders(doc);
    expect(item(doc, 'a').get('folderId')).toBeUndefined();
  });

  it('buildHomeLayout is pure: plain items and folders in, nodes out', () => {
    const base = { name: '', icon: '', color: '', roomId: '', roomPassword: '', role: 'owner' as const, createdAt: '' };
    const nodes = buildHomeLayout(
      [
        { ...base, id: 'x', sortOrder: 5 },
        { ...base, id: 'y', sortOrder: 1, folderId: 'f' },
        { ...base, id: 'z', sortOrder: 0, folderId: 'f' },
        { ...base, id: 'w', sortOrder: 0, folderId: 'solo' },
      ],
      [
        { id: 'f', name: 'F', sortOrder: 3, createdAt: '' },
        { id: 'solo', name: 'S', sortOrder: 9, createdAt: '' },
      ],
    );
    expect(nodes.map(homeNodeId)).toEqual(['f', 'x', 'w']);
    expect(flattenHomeOrder(nodes).map((dapp) => dapp.id)).toEqual(['z', 'y', 'x', 'w']);
  });

  it('renames with a trimmed, capped name and a default for an empty one', () => {
    const { doc, folderId } = folderDoc();
    renameFolder(folderId, `  ${'n'.repeat(60)}  `, doc);
    expect(readFolders(doc)[0].name).toBe('n'.repeat(40));
    renameFolder(folderId, '   ', doc);
    expect(readFolders(doc)[0].name).toBe('Folder');
    expect(renameFolder('gone', 'x', doc)).toBe(false);
  });

  it('ungroups in place, keeping the member order', () => {
    const { doc, folderId } = folderDoc();
    expect(ungroupFolder(folderId, doc)).toBe(true);
    expect(order(doc)).toEqual(['a', 'b', 'd', 'c']);
    expect(doc.getMap('dappFolders').size).toBe(0);
    expect(ungroupFolder(folderId, doc)).toBe(false);
  });

  it('moves a folder among top-level dapps', () => {
    const { doc, folderId } = folderDoc();
    expect(moveFolder(folderId, 'a', doc)).toBe(true);
    expect(order(doc)).toEqual([folderId, 'a', 'c']);
    expect(moveFolder('a', null, doc)).toBe(false); // not a folder
  });
});
