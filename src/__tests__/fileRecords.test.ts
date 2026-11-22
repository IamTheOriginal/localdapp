import { beforeEach, describe, expect, it, vi } from 'vitest';
import { whenAuthObserversIdle } from '../services/store/auth.ts';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';
import { BLOB_CHUNK_SIZE } from '../services/blobStore.ts';

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

interface TestSigner {
  publicKey: string;
  privateHex: string;
  sign(record: Record<string, unknown>): Promise<Record<string, unknown>>;
}

let currentSigner: TestSigner;

vi.mock('../services/identity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/identity.ts')>();
  return {
    ...actual,
    getIdentity: () => ({
      displayName: 'Current',
      publicKey: currentSigner.publicKey,
      deviceId: 'test-device',
    }),
    getSigningIdentity: () => Promise.resolve({
      publicKey: currentSigner.publicKey,
      privateKey: currentSigner.privateHex,
    }),
  };
});

const { addFileRecord, deleteFileRecord, listFileRecords, getFileRecord } = await import('../services/store/files.ts');
const { setupAuthObserver } = await import('../services/store/auth.ts');
const { getDappDoc } = await import('../services/store/docs.ts');
const { stableStringify } = await import('../services/store/protocolCore.ts');

async function createSigner(): Promise<TestSigner> {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  const publicKey = bufferToHex(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const privateHex = bufferToHex(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  return {
    publicKey,
    privateHex,
    async sign(record) {
      const { _signature, _signedBy, ...data } = record;
      void _signature; void _signedBy;
      const signature = await crypto.subtle.sign(
        { name: 'Ed25519' },
        keyPair.privateKey,
        new TextEncoder().encode(stableStringify(data)),
      );
      return { ...data, _signedBy: publicKey, _signature: bufferToHex(signature) };
    },
  };
}

function addMember(doc: Y.Doc, publicKey: string, role: string) {
  const members = doc.getMap('members');
  const member = new Y.Map<unknown>();
  member.set('publicKey', publicKey);
  member.set('role', role);
  members.set(publicKey, member);
}

function sampleDescriptor() {
  return {
    sha256: 'ab'.repeat(32),
    size: 10,
    chunkSize: BLOB_CHUNK_SIZE,
    chunkHashes: ['cd'.repeat(32)],
  };
}

function setYMap(target: Y.Map<unknown>, key: string, data: Record<string, unknown>) {
  const entry = new Y.Map<unknown>();
  Object.entries(data).forEach(([field, value]) => entry.set(field, value));
  target.set(key, entry);
}

async function waitForScan(): Promise<void> {
  await whenAuthObserversIdle();
}

let dappId: string;
let owner: TestSigner;
let editor: TestSigner;
let viewer: TestSigner;
let outsider: TestSigner;

beforeEach(async () => {
  docs.clear();
  dappId = `dapp-${crypto.randomUUID()}`;
  owner = await createSigner();
  editor = await createSigner();
  viewer = await createSigner();
  outsider = await createSigner();
  currentSigner = owner;

  const doc = getDappDoc(dappId);
  addMember(doc, owner.publicKey, 'owner');
  addMember(doc, editor.publicKey, 'editor');
  addMember(doc, viewer.publicKey, 'viewer');
});

describe('file index CRUD', () => {
  it('adds a signed record, lists it, and deletes it via signed tombstone', async () => {
    const record = await addFileRecord(dappId, { ...sampleDescriptor(), name: '  photo.jpg ', mime: 'image/jpeg' });
    expect(record.name).toBe('photo.jpg');
    expect(record._signedBy).toBe(owner.publicKey);

    expect(listFileRecords(dappId).map((row) => row.id)).toEqual([record.id]);
    expect(getFileRecord(dappId, record.id)?.sha256).toBe(sampleDescriptor().sha256);

    expect(await deleteFileRecord(dappId, record.id)).toBe(true);
    expect(listFileRecords(dappId)).toEqual([]);
    const doc = getDappDoc(dappId);
    const tombstone = doc.getMap('fileTombstones').get(record.id) as Y.Map<unknown>;
    expect(tombstone.get('fileId')).toBe(record.id);
    expect(tombstone.get('_signedBy')).toBe(owner.publicKey);
  });

  it('rejects viewers, malformed descriptors, and oversized thumbnails', async () => {
    currentSigner = viewer;
    await expect(addFileRecord(dappId, { ...sampleDescriptor(), name: 'x', mime: 'text/plain' }))
      .rejects.toThrow(/viewer/i);

    currentSigner = owner;
    await expect(addFileRecord(dappId, { ...sampleDescriptor(), sha256: 'nope', name: 'x', mime: 'text/plain' }))
      .rejects.toThrow(/hash/);
    await expect(addFileRecord(dappId, {
      ...sampleDescriptor(), name: 'x', mime: 'image/png', thumbnail: `data:image/png;base64,${'A'.repeat(50 * 1024)}`,
    })).rejects.toThrow(/thumbnail/);
    await expect(addFileRecord(dappId, {
      ...sampleDescriptor(), name: 'x', mime: 'image/png', thumbnail: 'https://evil.example/x.png',
    })).rejects.toThrow(/thumbnail/);
  });
});

describe('auth observer file coverage', () => {
  it('accepts editor-signed records and reverts forged or viewer-signed ones', async () => {
    setupAuthObserver(dappId, { scanDebounceMs: 0 });
    const doc = getDappDoc(dappId);
    const files = doc.getMap('files');

    const good = await editor.sign({
      ...sampleDescriptor(), id: 'good', name: 'ok.txt', mime: 'text/plain',
      createdAt: new Date().toISOString(), createdBy: editor.publicKey,
    });
    const fromViewer = await viewer.sign({
      ...sampleDescriptor(), id: 'viewer-file', name: 'nope.txt', mime: 'text/plain',
      createdAt: new Date().toISOString(), createdBy: viewer.publicKey,
    });
    const fromOutsider = await outsider.sign({
      ...sampleDescriptor(), id: 'outsider-file', name: 'nope.txt', mime: 'text/plain',
      createdAt: new Date().toISOString(), createdBy: outsider.publicKey,
    });
    const forged = {
      ...sampleDescriptor(), id: 'forged', name: 'forged.txt', mime: 'text/plain',
      createdAt: new Date().toISOString(), createdBy: owner.publicKey,
      _signedBy: owner.publicKey, _signature: 'ff'.repeat(64),
    };

    setYMap(files, 'good', good);
    setYMap(files, 'viewer-file', fromViewer);
    setYMap(files, 'outsider-file', fromOutsider);
    setYMap(files, 'forged', forged);
    await waitForScan();

    expect(files.has('good')).toBe(true);
    expect(files.has('viewer-file')).toBe(false);
    expect(files.has('outsider-file')).toBe(false);
    expect(files.has('forged')).toBe(false);
  });

  it('restores records deleted without an authorized tombstone', async () => {
    const doc = getDappDoc(dappId);
    const record = await addFileRecord(dappId, { ...sampleDescriptor(), name: 'keep.txt', mime: 'text/plain' });
    setupAuthObserver(dappId, { scanDebounceMs: 0 });
    await waitForScan();

    // Bare delete (no tombstone) — restored.
    doc.getMap('files').delete(record.id);
    await waitForScan();
    expect(doc.getMap('files').has(record.id)).toBe(true);

    // Delete with a viewer-signed tombstone — tombstone removed, record restored.
    const badTombstone = await viewer.sign({ fileId: record.id, deletedAt: new Date().toISOString() });
    doc.transact(() => {
      setYMap(doc.getMap('fileTombstones'), record.id, badTombstone);
      doc.getMap('files').delete(record.id);
    });
    await waitForScan();
    expect(doc.getMap('files').has(record.id)).toBe(true);
    expect(doc.getMap('fileTombstones').has(record.id)).toBe(false);
  });

  it('honors an authorized deletion and blocks stale re-adds', async () => {
    const doc = getDappDoc(dappId);
    const record = await addFileRecord(dappId, { ...sampleDescriptor(), name: 'gone.txt', mime: 'text/plain' });
    setupAuthObserver(dappId, { scanDebounceMs: 0 });
    await waitForScan();

    await deleteFileRecord(dappId, record.id);
    await waitForScan();
    expect(doc.getMap('files').has(record.id)).toBe(false);

    // Replaying the old signed record over the tombstone must fail (createdAt <= deletedAt).
    setYMap(doc.getMap('files'), record.id, record as unknown as Record<string, unknown>);
    await waitForScan();
    expect(doc.getMap('files').has(record.id)).toBe(false);
  });
});
