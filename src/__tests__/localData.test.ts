// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import {
  completePendingLocalDataReset,
  exportLocalData,
  isLocalDataResetPending,
  listLocalDocDatabases,
} from '../services/localData.ts';

async function persistDoc(name: string, fill: (doc: Y.Doc) => void): Promise<void> {
  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(name, doc);
  await persistence.whenSynced;
  fill(doc);
  await persistence.destroy();
  doc.destroy();
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function databaseNames(): Promise<string[]> {
  return indexedDB.databases().then((dbs) => dbs.map((db) => db.name).filter(Boolean) as string[]);
}

beforeEach(async () => {
  localStorage.clear();
  for (const name of await databaseNames()) {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('request failed'));
    });
  }
});

describe('exportLocalData', () => {
  it('exports every doc database as a re-appliable Yjs update, excluding the key vault', async () => {
    await persistDoc('dapp-builder-root', (doc) => {
      doc.getArray('dapps').push(['catalog-entry']);
    });
    await persistDoc('dapp-abc', (doc) => {
      doc.getMap('config').set('meta', 'hello');
    });
    // Simulate the protected key vault.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('dapp-builder-keys', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error ?? new Error('request failed'));
    });

    expect(await listLocalDocDatabases()).toEqual(['dapp-abc', 'dapp-builder-root']);

    const bundle = await exportLocalData();
    expect(bundle.format).toBe('dapp-builder-local-export');
    expect(Object.keys(bundle.docs).sort()).toEqual(['dapp-abc', 'dapp-builder-root']);
    expect(bundle.docs['dapp-builder-keys']).toBeUndefined();

    const restored = new Y.Doc();
    Y.applyUpdate(restored, base64ToBytes(bundle.docs['dapp-abc']));
    expect(restored.getMap('config').get('meta')).toBe('hello');

    const restoredRoot = new Y.Doc();
    Y.applyUpdate(restoredRoot, base64ToBytes(bundle.docs['dapp-builder-root']));
    expect(restoredRoot.getArray('dapps').toArray()).toEqual(['catalog-entry']);
  });
});

describe('local data reset', () => {
  it('does nothing when no reset is pending', async () => {
    await persistDoc('dapp-abc', (doc) => doc.getMap('config').set('meta', 'x'));
    expect(isLocalDataResetPending()).toBe(false);
    expect(await completePendingLocalDataReset()).toBe(false);
    expect(await databaseNames()).toContain('dapp-abc');
  });

  it('deletes all doc databases but keeps the key vault, then clears the flag', async () => {
    await persistDoc('dapp-abc', (doc) => doc.getMap('config').set('meta', 'x'));
    await persistDoc('dapp-abc-source-v1', (doc) => doc.getMap('files').set('index.html', 'y'));
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('dapp-builder-keys', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error ?? new Error('request failed'));
    });

    localStorage.setItem('dapp-builder-pending-reset', '1');
    localStorage.setItem('dapp-builder-identity', '{"publicKey":"keep-me"}');
    expect(isLocalDataResetPending()).toBe(true);

    expect(await completePendingLocalDataReset()).toBe(true);

    const remaining = await databaseNames();
    expect(remaining).toEqual(['dapp-builder-keys']);
    expect(isLocalDataResetPending()).toBe(false);
    expect(localStorage.getItem('dapp-builder-identity')).toBe('{"publicKey":"keep-me"}');
  });
});
