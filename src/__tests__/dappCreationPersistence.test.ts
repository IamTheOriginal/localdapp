import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { flushLocalPersistence } from '../services/store/docs.ts';
import { getStorageHealth } from '../services/store/storageHealth.ts';

/**
 * A dapp created a moment before a hard reload kept its catalog entry and lost
 * its document: the new document's database was still opening. The creation
 * paths wait for `persistNewDapp`, built on this flush, before reporting the
 * dapp as created.
 */

async function storedState(name: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(name, doc);
  await persistence.whenSynced;
  await persistence.destroy();
  return doc;
}

describe('flushLocalPersistence', () => {
  it('resolves once content written before the database opened is stored', async () => {
    const name = `creation-flush-${crypto.randomUUID()}`;
    const doc = new Y.Doc();
    const persistence = new IndexeddbPersistence(name, doc);
    doc.getMap('config').set('name', 'Brand new'); // written while the database is still opening
    doc.getMap('data').set('tasks', new Y.Map());

    expect(await flushLocalPersistence(persistence)).toBe(true);
    doc.getMap('config').set('icon', '🚀'); // and a write after the open
    expect(await flushLocalPersistence(persistence)).toBe(true);
    await persistence.destroy();

    const reloaded = await storedState(name);
    expect(reloaded.getMap('config').get('name')).toBe('Brand new');
    expect(reloaded.getMap('config').get('icon')).toBe('🚀');
    expect(reloaded.getMap('data').get('tasks')).toBeInstanceOf(Y.Map);
  });

  it('does not wait forever when the local database never opens', async () => {
    const stuck = { whenSynced: new Promise<never>(() => undefined) } as unknown as IndexeddbPersistence;
    expect(await flushLocalPersistence(stuck, 20)).toBe(false);
    expect(getStorageHealth()).toBe('unavailable');
    expect(await flushLocalPersistence(null)).toBe(true);
  });
});
