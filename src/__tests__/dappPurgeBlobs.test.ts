// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { getDappDoc, getDappsList, purgeDappLocalResources } from '../services/store/docs.ts';
import { getVerifiedMembers, setupAuthObserver, whenAuthObserversIdle } from '../services/store/auth.ts';
import { getBlobStore } from '../services/blobStore.ts';
import { isBlobStillReferenced } from '../services/store/blobReferences.ts';

const askedDuringPurge: Y.Doc[] = [];
vi.mock('../services/store/readModel.ts', () => ({
  destroyReadModel: (dappId: string) => { askedDuringPurge.push(getDappDoc(dappId)); },
}));

function addCatalogEntry(dappId: string): void {
  const item = new Y.Map<string>();
  item.set('id', dappId);
  item.set('name', dappId);
  getDappsList().push([item]);
}

function addFileRecord(dappId: string, fileId: string, sha256: string): void {
  const record = new Y.Map<unknown>();
  record.set('id', fileId);
  record.set('sha256', sha256);
  getDappDoc(dappId).getMap('files').set(fileId, record);
}

function addMember(dappId: string, publicKey: string): void {
  const member = new Y.Map<unknown>();
  member.set('publicKey', publicKey);
  member.set('role', 'owner');
  getDappDoc(dappId).getMap('members').set(publicKey, member);
}

describe('purgeDappLocalResources blob cleanup', () => {
  it('deletes blobs referenced by the dapp file index when the dapp is deleted', async () => {
    const store = getBlobStore();
    const referenced = await store.putBlob(new Uint8Array([1, 2, 3, 4, 5]));
    const unrelated = await store.putBlob(new Uint8Array([9, 8, 7, 6, 5, 4]));

    const dappId = `purge-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);
    const record = new Y.Map<unknown>();
    record.set('id', 'file-1');
    record.set('sha256', referenced.sha256);
    doc.getMap('files').set('file-1', record);

    await purgeDappLocalResources(dappId);

    expect(await store.hasBlob(referenced.sha256)).toBe(false);
    // Content not referenced by this dapp is untouched.
    expect(await store.hasBlob(unrelated.sha256)).toBe(true);
  });

  it('keeps content another dapp on this device still lists', async () => {
    const store = getBlobStore();
    const shared = await store.putBlob(new Uint8Array([4, 4, 4, 4]));
    const own = await store.putBlob(new Uint8Array([5, 5, 5]));
    const deleted = `purge-${crypto.randomUUID()}`;
    const other = `purge-${crypto.randomUUID()}`;
    addCatalogEntry(deleted);
    addCatalogEntry(other);
    addFileRecord(deleted, 'photo', shared.sha256);
    addFileRecord(deleted, 'note', own.sha256);
    addFileRecord(other, 'same-photo', shared.sha256);

    expect(await isBlobStillReferenced(deleted, shared.sha256)).toBe(true);
    await purgeDappLocalResources(deleted);

    expect(await store.hasBlob(shared.sha256)).toBe(true);
    expect(await store.hasBlob(own.sha256)).toBe(false);
    expect(await isBlobStillReferenced(other, own.sha256)).toBe(false);
  });

  it('does not bring the document back when something asks for it during the erasure', async () => {
    const dappId = `purge-${crypto.randomUUID()}`;
    const original = getDappDoc(dappId);
    original.getMap('config').set('name', 'Doomed');

    // The read-model cleanup runs after the document is gone; the mock below asks for the
    // document at exactly that moment, like a timer or a late mesh handshake would.
    askedDuringPurge.length = 0;
    await purgeDappLocalResources(dappId);

    expect(askedDuringPurge).toHaveLength(1);
    expect(askedDuringPurge[0]).not.toBe(original);
    // What was handed out did not become the dapp's document (with a database and a mesh of its own).
    expect(getDappDoc(dappId)).not.toBe(askedDuringPurge[0]);
  });

  it('gives a document recreated under the same id a fresh auth observer', async () => {
    const dappId = `purge-${crypto.randomUUID()}`;
    addMember(dappId, 'aa'.repeat(32));
    setupAuthObserver(dappId, { scanDebounceMs: 0 });
    await whenAuthObserversIdle(); // the verified set is built by the first scan
    expect([...(getVerifiedMembers(dappId)?.keys() ?? [])]).toEqual(['aa'.repeat(32)]);

    await purgeDappLocalResources(dappId);
    expect(getVerifiedMembers(dappId)).toBeNull();

    addMember(dappId, 'bb'.repeat(32));
    setupAuthObserver(dappId, { scanDebounceMs: 0 });
    await whenAuthObserversIdle();
    expect([...(getVerifiedMembers(dappId)?.keys() ?? [])]).toEqual(['bb'.repeat(32)]);
  });

  it('purges cleanly when the dapp was never opened and has no files', async () => {
    await expect(purgeDappLocalResources(`purge-${crypto.randomUUID()}`)).resolves.toBeUndefined();
  });
});
