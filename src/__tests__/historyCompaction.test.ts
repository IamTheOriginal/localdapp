import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';
import { BLOB_CHUNK_SIZE } from '../services/blobStore.ts';

/**
 * Review item 5.10: record/file tombstones and rekey entries only ever grew.
 * Owner devices compact expired tombstones and superseded rekey entries; every
 * auth observer lets a compacted tombstone go instead of restoring it — but not
 * a fresh one, and not one removed together with a replayed copy of its record.
 * Member tombstones are never compacted. A verified file deletion is announced
 * (onVerifiedFileRemoved) so the blob cleanup can release the content.
 */

const docs = new Map<string, Y.Doc>();

vi.mock('../services/store/docs.ts', () => ({
  getDappDoc: (dappId: string) => {
    let doc = docs.get(dappId);
    if (!doc) {
      doc = new Y.Doc();
      docs.set(dappId, doc);
    }
    return doc;
  },
}));

let currentIdentity: { publicKey: string; privateHex: string };

vi.mock('../services/identity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/identity.ts')>();
  return {
    ...actual,
    getIdentity: () => ({ displayName: 'Owner', publicKey: currentIdentity.publicKey, deviceId: 'owner-device' }),
    getSigningIdentity: () => Promise.resolve({ publicKey: currentIdentity.publicKey, privateKey: currentIdentity.privateHex }),
  };
});

const { compactDappHistory, TOMBSTONE_RETENTION_MS } = await import('../services/store/historyCompaction.ts');
const { setupAuthObserver, whenAuthObserversIdle, onVerifiedFileRemoved } = await import('../services/store/auth.ts');
const { signWithIdentity, yMapFromObject } = await import('../services/store/protocolCore.ts');
const { addRecord } = await import('../services/store/data.ts');
const { addFileRecord, deleteFileRecord } = await import('../services/store/files.ts');
const { getDappDoc } = await import('../services/store/docs.ts');

const DAY_MS = 24 * 60 * 60 * 1000;
let dappId: string;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function signing() {
  return { publicKey: currentIdentity.publicKey, privateKey: currentIdentity.privateHex };
}

async function signedRecordTombstone(entityId: string, recordId: string, deletedAt: string): Promise<Y.Map<unknown>> {
  const payload = { entityId, recordId, deletedAt };
  return yMapFromObject({ ...payload, ...(await signWithIdentity(signing(), payload)) });
}

async function signedFileTombstone(fileId: string, deletedAt: string): Promise<Y.Map<unknown>> {
  const payload = { fileId, deletedAt };
  return yMapFromObject({ ...payload, ...(await signWithIdentity(signing(), payload)) });
}

beforeEach(async () => {
  docs.clear();
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  currentIdentity = {
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', keyPair.publicKey)),
    privateHex: bufferToHex(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)),
  };
  dappId = `history-${crypto.randomUUID()}`;
  const member = new Y.Map<unknown>();
  member.set('publicKey', currentIdentity.publicKey);
  member.set('role', 'owner');
  getDappDoc(dappId).getMap('members').set(currentIdentity.publicKey, member);
});

describe('compactDappHistory', () => {
  it('drops expired record and file tombstones and superseded rekeys, nothing else', () => {
    const doc = new Y.Doc();
    const stamp = (deletedAt: string) => yMapFromObject({ deletedAt });
    doc.getMap('recordTombstones').set('tasks:old', stamp(daysAgo(120)));
    doc.getMap('recordTombstones').set('tasks:recent', stamp(daysAgo(10)));
    doc.getMap('recordTombstones').set('tasks:odd:id', stamp(daysAgo(200)));
    doc.getMap('recordTombstones').set('tasks:unparsable', stamp('not a date'));
    // A tombstone whose record is in the document (a replay the observer is reverting) stays.
    doc.getMap('recordTombstones').set('tasks:present', stamp(daysAgo(120)));
    const tasks = new Y.Map<Record<string, unknown>>();
    tasks.set('present', { id: 'present' });
    doc.getMap('data').set('tasks', tasks);
    doc.getMap('fileTombstones').set('f-old', stamp(daysAgo(91)));
    doc.getMap('fileTombstones').set('f-recent', stamp(daysAgo(30)));
    doc.getMap('fileTombstones').set('f-present', stamp(daysAgo(120)));
    doc.getMap('files').set('f-present', yMapFromObject({ id: 'f-present' }));
    doc.getMap('memberTombstones').set('former', stamp(daysAgo(400)));
    for (const epoch of [1, 2, 3, 4]) doc.getMap('rekeys').set(`${epoch}:member`, yMapFromObject({ epoch, forKey: 'member' }));

    const result = compactDappHistory(doc, { currentEpoch: 4 });

    expect(result).toEqual({ recordTombstones: 2, fileTombstones: 1, rekeys: 2 });
    expect([...doc.getMap('recordTombstones').keys()].sort()).toEqual(['tasks:present', 'tasks:recent', 'tasks:unparsable']);
    expect([...doc.getMap('fileTombstones').keys()].sort()).toEqual(['f-present', 'f-recent']);
    expect([...doc.getMap('rekeys').keys()].sort()).toEqual(['3:member', '4:member']);
    // Member tombstones carry the former-writer proof and are never compacted.
    expect(doc.getMap('memberTombstones').has('former')).toBe(true);
    expect(compactDappHistory(doc, { currentEpoch: 4 })).toEqual({ recordTombstones: 0, fileTombstones: 0, rekeys: 0 });
  });

  it('keeps every rekey entry while the dapp was never rotated past epoch 1', () => {
    const doc = new Y.Doc();
    doc.getMap('rekeys').set('1:member', yMapFromObject({ epoch: 1, forKey: 'member' }));
    expect(compactDappHistory(doc, { currentEpoch: 1 }).rekeys).toBe(0);
    expect(compactDappHistory(doc, { currentEpoch: 2 }).rekeys).toBe(0);
    expect(compactDappHistory(doc, { currentEpoch: 3 }).rekeys).toBe(1);
  });

  it('uses a generous window', () => {
    expect(TOMBSTONE_RETENTION_MS).toBeGreaterThanOrEqual(90 * DAY_MS);
  });
});

describe('auth observer and compacted tombstones', () => {
  it('lets an expired record tombstone go and keeps restoring a fresh one', async () => {
    const doc = getDappDoc(dappId);
    const tombstones = doc.getMap('recordTombstones');
    tombstones.set('tasks:old', await signedRecordTombstone('tasks', 'old', daysAgo(120)));
    tombstones.set('tasks:fresh', await signedRecordTombstone('tasks', 'fresh', daysAgo(1)));
    setupAuthObserver(dappId, { scanDebounceMs: 0 });
    await addRecord(dappId, 'tasks', { id: 'live', title: 'kept' });
    await whenAuthObserversIdle();
    expect(tombstones.has('tasks:old')).toBe(true);

    expect(compactDappHistory(doc, { currentEpoch: 0 }).recordTombstones).toBe(1);
    tombstones.delete('tasks:fresh'); // not expired: somebody deleting it gets it restored
    await whenAuthObserversIdle();

    expect(tombstones.has('tasks:old')).toBe(false);
    expect(tombstones.has('tasks:fresh')).toBe(true);
  });

  it('restores an expired tombstone removed together with a replayed copy of its record', async () => {
    const doc = getDappDoc(dappId);
    const tombstones = doc.getMap('recordTombstones');
    const replay: Record<string, unknown> = { id: 'gone', title: 'deleted long ago', createdAt: daysAgo(200) };
    Object.assign(replay, await signWithIdentity(signing(), replay));
    tombstones.set('tasks:gone', await signedRecordTombstone('tasks', 'gone', daysAgo(120)));
    setupAuthObserver(dappId, { scanDebounceMs: 0 });
    await addRecord(dappId, 'tasks', { id: 'live', title: 'kept' });
    await whenAuthObserversIdle();

    doc.transact(() => {
      tombstones.delete('tasks:gone');
      (doc.getMap('data').get('tasks') as Y.Map<Record<string, unknown>>).set('gone', replay);
    });
    await whenAuthObserversIdle();

    expect(tombstones.has('tasks:gone')).toBe(true);
    expect((doc.getMap('data').get('tasks') as Y.Map<unknown>).has('gone')).toBe(false);
  });

  it('lets an expired file tombstone go', async () => {
    const doc = getDappDoc(dappId);
    const tombstones = doc.getMap('fileTombstones');
    tombstones.set('f-old', await signedFileTombstone('f-old', daysAgo(120)));
    tombstones.set('f-fresh', await signedFileTombstone('f-fresh', daysAgo(1)));
    setupAuthObserver(dappId, { scanDebounceMs: 0 });
    await addRecord(dappId, 'tasks', { id: 'live', title: 'kept' });
    await whenAuthObserversIdle();

    compactDappHistory(doc, { currentEpoch: 0 });
    tombstones.delete('f-fresh');
    await whenAuthObserversIdle();

    expect(tombstones.has('f-old')).toBe(false);
    expect(tombstones.has('f-fresh')).toBe(true);
  });
});

describe('verified file removals', () => {
  it('announces the removed record once its deletion is verified', async () => {
    const removed: Array<{ dappId: string; sha256: unknown }> = [];
    const off = onVerifiedFileRemoved((id, record) => { removed.push({ dappId: id, sha256: record.sha256 }); });
    try {
      setupAuthObserver(dappId, { scanDebounceMs: 0 });
      const file = await addFileRecord(dappId, {
        name: 'photo.jpg', mime: 'image/jpeg', sha256: 'ab'.repeat(32), size: 10, chunkSize: BLOB_CHUNK_SIZE, chunkHashes: ['cd'.repeat(32)],
      });
      await whenAuthObserversIdle();
      expect(removed).toEqual([]);

      await deleteFileRecord(dappId, file.id);
      await whenAuthObserversIdle();

      expect(removed).toEqual([{ dappId, sha256: 'ab'.repeat(32) }]);
    } finally {
      off();
    }
  });
});
