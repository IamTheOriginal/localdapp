import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { IndexeddbPersistence, storeState } from 'y-indexeddb';
import type { RelationshipPairingProvider } from '../services/relationshipPairingRoomManager.ts';
import { RelationshipPairingRoomManager } from '../services/relationshipPairingRoomManager.ts';
import {
  clearIndexeddbDocument,
  compactRootPersistence,
  getRootDoc,
  getRootPersistence,
} from '../services/store/docs.ts';

async function persistedUpdates(databaseName: string): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onerror = () => reject(request.error ?? new Error(`Could not open ${databaseName}`));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('updates', 'readonly');
      const getAll = transaction.objectStore('updates').getAll();
      getAll.onerror = () => reject(getAll.error ?? new Error(`Could not read ${databaseName}`));
      getAll.onsuccess = () => {
        const values = (getAll.result as ArrayBuffer[]).map((value) => new Uint8Array(value));
        database.close();
        resolve(values);
      };
    };
  });
}

function containsText(updates: Uint8Array[], text: string): boolean {
  const decoder = new TextDecoder();
  return updates.some((update) => decoder.decode(update).includes(text));
}

describe('secure IndexedDB erasure', () => {
  it('deletes an unopened Yjs persistence database', async () => {
    const databaseName = `deletion-test-${crypto.randomUUID()}`;
    const writerDoc = new Y.Doc();
    const writer = new IndexeddbPersistence(databaseName, writerDoc);
    await writer.whenSynced;
    writerDoc.getMap<string>('secrets').set('roomPassword', 'deleted-room-password');
    await storeState(writer);
    await writer.destroy();

    await clearIndexeddbDocument(databaseName);

    const readerDoc = new Y.Doc();
    const reader = new IndexeddbPersistence(databaseName, readerDoc);
    await reader.whenSynced;
    expect(readerDoc.getMap<string>('secrets').get('roomPassword')).toBeUndefined();
    await reader.clearData();
  });

  it('compacts credential-bearing control messages out of control-room history', async () => {
    const noopProvider: RelationshipPairingProvider = {
      awareness: { setLocalStateField: () => undefined },
      connect: () => undefined, disconnect: () => undefined, destroy: () => undefined,
      on: () => undefined, off: () => undefined,
    };
    const manager = new RelationshipPairingRoomManager({
      createDoc: () => new Y.Doc(),
      createProvider: () => noopProvider,
      createPersistence: (key, doc) => new IndexeddbPersistence(key, doc),
    });
    const capability = {
      protocol: 'relationship-control-capability' as const, schemaVersion: 1 as const,
      capabilityId: crypto.randomUUID(), pairContextId: 'pair', roomId: 'room', roomPassword: 'control-password',
      createdAt: new Date().toISOString(),
    };
    const handle = manager.openControl(capability, 'relationship-public-key');
    await handle.persistenceReady;
    const databaseName = `relationship-control-v1:${capability.capabilityId}`;
    const secret = `encrypted-channel-offer-${crypto.randomUUID()}`;
    handle.doc.getMap<string>('relationshipChannelControlMessages').set('offer', secret);
    await manager.compact(handle.descriptor.id);
    expect(containsText(await persistedUpdates(databaseName), secret)).toBe(true);

    handle.doc.getMap<string>('relationshipChannelControlMessages').delete('offer');
    await manager.compact(handle.descriptor.id);
    expect(containsText(await persistedUpdates(databaseName), secret)).toBe(false);
    await manager.destroy(handle.descriptor.id, { clearPersistence: true });
  });

  it('compacts deleted root credentials out of historical CRDT updates', async () => {
    const secret = `historical-room-password-${crypto.randomUUID()}`;
    const rootDoc = getRootDoc();
    const persistence = getRootPersistence();
    expect(persistence).not.toBeNull();
    if (!persistence) throw new Error('Root persistence was not initialized');
    await persistence.whenSynced;

    rootDoc.getMap<string>('credentialCompactionTest').set('roomPassword', secret);
    await storeState(persistence);
    expect(containsText(await persistedUpdates('dapp-builder-root'), secret)).toBe(true);

    rootDoc.getMap<string>('credentialCompactionTest').delete('roomPassword');
    await compactRootPersistence();

    expect(containsText(await persistedUpdates('dapp-builder-root'), secret)).toBe(false);
  });
});
