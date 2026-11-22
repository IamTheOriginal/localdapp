import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';

function makeRecordMap(doc: Y.Doc, entityId: string, data: Record<string, unknown>): Y.Map<unknown> {
  const dataMap = doc.getMap('data');
  let arr = dataMap.get(entityId) as Y.Array<Y.Map<unknown>> | undefined;
  if (!arr) {
    arr = new Y.Array<Y.Map<unknown>>();
    dataMap.set(entityId, arr);
  }
  const map = new Y.Map<unknown>();
  Object.entries(data).forEach(([k, v]) => map.set(k, v));
  arr.push([map]);
  return map;
}

describe('data store primitives', () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  it('stores and retrieves records from a Y.Array inside doc.getMap("data")', () => {
    const dataMap = doc.getMap('data');
    const arr = new Y.Array<Y.Map<unknown>>();
    dataMap.set('tasks', arr);
    const rec = new Y.Map<unknown>();
    rec.set('id', 'r1');
    rec.set('title', 'Test task');
    arr.push([rec]);
    const records = dataMap.get('tasks') as Y.Array<Y.Map<unknown>>;
    expect(records.length).toBe(1);
    expect(records.get(0).get('title')).toBe('Test task');
  });

  it('updates a record by id', () => {
    const dataMap = doc.getMap('data');
    const arr = new Y.Array<Y.Map<unknown>>();
    dataMap.set('tasks', arr);
    makeRecordMap(doc, 'tasks', { id: 'r1', title: 'Old', status: 'todo' });
    const records = dataMap.get('tasks') as Y.Array<Y.Map<unknown>>;
    for (let i = 0; i < records.length; i++) {
      if (records.get(i).get('id') === 'r1') {
        records.get(i).set('title', 'Updated');
        break;
      }
    }
    expect(records.get(0).get('title')).toBe('Updated');
  });

  it('deletes a record by id', () => {
    const dataMap = doc.getMap('data');
    const arr = new Y.Array<Y.Map<unknown>>();
    dataMap.set('tasks', arr);
    makeRecordMap(doc, 'tasks', { id: 'r1', title: 'Delete me' });
    const records = dataMap.get('tasks') as Y.Array<Y.Map<unknown>>;
    for (let i = 0; i < records.length; i++) {
      if (records.get(i).get('id') === 'r1') {
        records.delete(i, 1);
        break;
      }
    }
    expect((dataMap.get('tasks') as Y.Array<Y.Map<unknown>>).length).toBe(0);
  });
});
