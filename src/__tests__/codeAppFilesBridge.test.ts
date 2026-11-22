import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';

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
  // The blob reference check walks the catalog before a local copy is deleted; no other dapps here.
  getDappsList: () => new Y.Doc().getArray('dapps'),
  getDappPersistence: () => null,
}));

let currentIdentity: { publicKey: string; privateHex: string };

vi.mock('../services/identity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/identity.ts')>();
  return {
    ...actual,
    getIdentity: () => ({
      displayName: 'Bridge user',
      publicKey: currentIdentity.publicKey,
      deviceId: 'bridge-device',
    }),
    getSigningIdentity: () => Promise.resolve({
      publicKey: currentIdentity.publicKey,
      privateKey: currentIdentity.privateHex,
    }),
  };
});

const { handleFilesOperation } = await import('../services/codeAppFilesBridge.ts');
const { getDappDoc } = await import('../services/store/docs.ts');
const { listFileRecords } = await import('../services/store/files.ts');
const { getBlobStore } = await import('../services/blobStore.ts');
import type { FileRecord } from '../types.ts';

let dappId: string;

beforeEach(async () => {
  docs.clear();
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  currentIdentity = {
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', keyPair.publicKey)),
    privateHex: bufferToHex(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)),
  };
  dappId = `dapp-${crypto.randomUUID()}`;
  const doc = getDappDoc(dappId);
  const member = new Y.Map<unknown>();
  member.set('publicKey', currentIdentity.publicKey);
  member.set('role', 'owner');
  doc.getMap('members').set(currentIdentity.publicKey, member);
});

describe('$files bridge', () => {
  it('adds, lists, gets, and deletes files end to end', async () => {
    const content = new TextEncoder().encode('hello code app files');
    const added = await handleFilesOperation(dappId, 'add', [{
      name: 'notes.txt',
      mime: 'text/plain',
      bytes: content.slice().buffer,
    }]) as FileRecord;
    expect(added.name).toBe('notes.txt');
    expect(added.size).toBe(content.byteLength);

    const listed = await handleFilesOperation(dappId, 'list', []) as FileRecord[];
    expect(listed.map((row) => row.id)).toEqual([added.id]);

    const found = await handleFilesOperation(dappId, 'find', ['notes.txt']) as FileRecord | null;
    expect(found?.id).toBe(added.id);
    expect(await handleFilesOperation(dappId, 'find', ['nope.txt'])).toBeNull();
    expect(await handleFilesOperation(dappId, 'find', [''])).toBeNull();

    const fetched = await handleFilesOperation(dappId, 'get', [added.id]) as { record: FileRecord; bytes: ArrayBuffer };
    expect(fetched.record.id).toBe(added.id);
    expect(new Uint8Array(fetched.bytes)).toEqual(content);

    const deleted = await handleFilesOperation(dappId, 'delete', [added.id]) as { success: boolean };
    expect(deleted.success).toBe(true);
    expect(listFileRecords(dappId)).toEqual([]);
    expect(await getBlobStore().hasBlob(added.sha256)).toBe(false);
  });

  it('returns null for unknown files and validates add input', async () => {
    expect(await handleFilesOperation(dappId, 'get', ['missing'])).toBeNull();
    await expect(handleFilesOperation(dappId, 'add', [{ name: 'x', mime: 'text/plain', bytes: 'nope' }]))
      .rejects.toThrow(/ArrayBuffer/);
    await expect(handleFilesOperation(dappId, 'add', [{ name: 'x', mime: 'text/plain', bytes: new ArrayBuffer(0) }]))
      .rejects.toThrow(/empty/);
    await expect(handleFilesOperation(dappId, 'nope', [])).rejects.toThrow(/Unknown/);
  });
});
