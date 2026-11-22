import { beforeEach, describe, expect, it, vi } from 'vitest';
import { whenAuthObserversIdle } from '../services/store/auth.ts';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';

const docs = new Map<string, Y.Doc>();
const selfPublicKey = 'aa'.repeat(32);

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

vi.mock('../services/identity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/identity.ts')>();
  return {
    ...actual,
    getIdentity: () => ({
      displayName: 'Self',
      publicKey: selfPublicKey,
      privateKey: '',
      deviceId: 'self-device',
    }),
  };
});

const { setupAuthObserver } = await import('../services/store/auth.ts');
const { getDappDoc } = await import('../services/store/docs.ts');

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(obj[key])}`
  )).join(',')}}`;
}

async function createSigner() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' } as EcKeyGenParams,
    true,
    ['sign', 'verify'],
  );
  const publicKey = bufferToHex(await crypto.subtle.exportKey('raw', keyPair.publicKey));

  async function sign(record: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { _signature, _signedBy, ...data } = record;
    void _signature;
    void _signedBy;
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      keyPair.privateKey,
      new TextEncoder().encode(stableStringify(data)),
    );
    return { ...data, _signedBy: publicKey, _signature: bufferToHex(signature) };
  }

  return { publicKey, sign };
}

async function waitForArrayLength(arr: Y.Array<Y.Map<unknown>>, expected: number): Promise<void> {
  // Generous on purpose: the first Ed25519 verification of a process is slow (cold WebCrypto),
  // and 500 ms made this fail about one run in eight. The wait ends as soon as the length matches.
  await vi.waitFor(() => {
    expect(arr.length).toBe(expected);
  }, { timeout: 3000 });
}

async function waitForObserverScan(): Promise<void> {
  await whenAuthObserversIdle();
}

function addMember(
  doc: Y.Doc,
  publicKey: string,
  role: 'owner' | 'editor' | 'viewer',
  extra: Record<string, unknown> = {},
) {
  const members = doc.getMap('members');
  const member = new Y.Map<unknown>();
  member.set('publicKey', publicKey);
  member.set('role', role);
  Object.entries(extra).forEach(([key, value]) => member.set(key, value));
  members.set(publicKey, member);
  return member;
}

function addRecord(doc: Y.Doc, entityId: string, record: Record<string, unknown>) {
  const data = doc.getMap('data');
  let arr = data.get(entityId) as Y.Array<Y.Map<unknown>> | undefined;
  if (!arr) {
    arr = new Y.Array<Y.Map<unknown>>();
    data.set(entityId, arr);
  }
  const recordMap = new Y.Map<unknown>();
  Object.entries(record).forEach(([key, value]) => recordMap.set(key, value));
  arr.push([recordMap]);
  return arr;
}

function writeTombstone(map: Y.Map<unknown>, key: string, data: Record<string, unknown>): void {
  const tombstone = new Y.Map<unknown>();
  Object.entries(data).forEach(([field, value]) => tombstone.set(field, value));
  map.set(key, tombstone);
}

function addRoleAssignment(doc: Y.Doc, publicKey: string, extra: Record<string, unknown> = {}) {
  const assignments = doc.getMap('roleAssignments');
  const entry = new Y.Map<unknown>();
  entry.set('publicKey', publicKey);
  Object.entries(extra).forEach(([key, value]) => entry.set(key, value));
  assignments.set(publicKey, entry);
  return entry;
}

describe('auth observer record enforcement', () => {
  beforeEach(() => {
    docs.clear();
  });

  it('reverts records with a bogus signature even when _signedBy is a known editor', async () => {
    const dappId = `dapp-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);
    const signerPublicKey = 'bb'.repeat(32);
    addMember(doc, signerPublicKey, 'editor');

    setupAuthObserver(dappId, { scanDebounceMs: 0 });

    const arr = addRecord(doc, 'tasks', {
      id: 'r1',
      title: 'forged',
      _signedBy: signerPublicKey,
      _signature: '00',
    });

    await waitForArrayLength(arr, 0);
  });

  it('verifies records already present at observer setup (load baseline is not trusted)', async () => {
    const dappId = `dapp-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);
    const signer = await createSigner();
    addMember(doc, signer.publicKey, 'editor');

    // Both records exist BEFORE the observer starts — one valid, one forged.
    // The rescan skip for already-verified records must never extend to the
    // unverified load-time baseline.
    const valid = await signer.sign({ id: 'pre-valid', title: 'signed before setup' });
    const arr = addRecord(doc, 'tasks', valid);
    addRecord(doc, 'tasks', {
      id: 'pre-forged',
      title: 'forged before setup',
      _signedBy: signer.publicKey,
      _signature: 'ff'.repeat(64),
    });

    setupAuthObserver(dappId, { scanDebounceMs: 0 });
    // Any update triggers the first scan.
    doc.getMap('data').set('nudge', new Y.Array());

    await waitForArrayLength(arr, 1);
    await waitForObserverScan();
    expect(arr.get(0).get('id')).toBe('pre-valid');
  });

  it('keeps a verified record accepted across unrelated rescans', async () => {
    const dappId = `dapp-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);
    const signer = await createSigner();
    addMember(doc, signer.publicKey, 'editor');
    setupAuthObserver(dappId, { scanDebounceMs: 0 });

    const record = await signer.sign({ id: 'stable', title: 'stays' });
    const arr = addRecord(doc, 'tasks', record);
    await waitForArrayLength(arr, 1);

    // Unrelated churn triggers rescans; the record must survive them, and a
    // later tampering of the same record must still be reverted.
    addRecord(doc, 'other', { id: 'junk-1', title: 'unsigned junk' });
    await waitForObserverScan();
    expect(arr.length).toBe(1);

    arr.get(0).set('title', 'tampered after verification');
    await vi.waitFor(() => {
      expect(arr.length === 0 || arr.get(0).get('title') === 'stays').toBe(true);
    }, { timeout: 500 });
  });

  it('also verifies records that claim to be signed by the local public key', async () => {
    const dappId = `dapp-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);
    addMember(doc, selfPublicKey, 'editor');

    setupAuthObserver(dappId, { scanDebounceMs: 0 });

    const arr = addRecord(doc, 'tasks', {
      id: 'r-self-forged',
      title: 'forged as local user',
      _signedBy: selfPublicKey,
      _signature: '00',
    });

    await waitForArrayLength(arr, 0);
  });

  it('restores a member role when an editor tries to promote themselves to owner', async () => {
    const dappId = `dapp-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);
    addMember(doc, selfPublicKey, 'owner');
    const editorPublicKey = 'cc'.repeat(32);
    const editor = addMember(doc, editorPublicKey, 'editor');

    setupAuthObserver(dappId, { scanDebounceMs: 0 });

    editor.set('role', 'owner');

    await vi.waitFor(() => {
      expect(editor.get('role')).toBe('editor');
    }, { timeout: 500 });
  });

  it('rejects replaying a signed record after a newer deletion tombstone', async () => {
    const dappId = `dapp-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);
    const signer = await createSigner();
    addMember(doc, signer.publicKey, 'editor');
    const signedRecord = await signer.sign({
      id: 'r-replay',
      title: 'deleted task',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: signer.publicKey,
      _createdBy: signer.publicKey,
    });
    const arr = addRecord(doc, 'tasks', signedRecord);

    setupAuthObserver(dappId, { scanDebounceMs: 0 });
    await waitForArrayLength(arr, 1);

    const signedTombstone = await signer.sign({
      entityId: 'tasks',
      recordId: 'r-replay',
      deletedAt: '2026-01-02T00:00:00.000Z',
    });
    doc.transact(() => {
      writeTombstone(doc.getMap('recordTombstones'), 'tasks:r-replay', signedTombstone);
      arr.delete(0, 1);
    });
    await waitForArrayLength(arr, 0);

    addRecord(doc, 'tasks', signedRecord);

    await waitForArrayLength(arr, 0);
  });

  it('restores a deleted record tombstone before accepting replayed records', async () => {
    const dappId = `dapp-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);
    const signer = await createSigner();
    addMember(doc, signer.publicKey, 'editor');
    const signedRecord = await signer.sign({
      id: 'r-tombstone-delete',
      title: 'deleted task',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: signer.publicKey,
      _createdBy: signer.publicKey,
    });
    const arr = addRecord(doc, 'tasks', signedRecord);

    setupAuthObserver(dappId, { scanDebounceMs: 0 });
    await waitForArrayLength(arr, 1);

    // A recent deletion: tombstones past the retention window may be compacted away
    // (historyCompaction.ts), and then they are deliberately not restored.
    const signedTombstone = await signer.sign({
      entityId: 'tasks',
      recordId: 'r-tombstone-delete',
      deletedAt: new Date().toISOString(),
    });
    doc.transact(() => {
      writeTombstone(doc.getMap('recordTombstones'), 'tasks:r-tombstone-delete', signedTombstone);
      arr.delete(0, 1);
    });
    await waitForArrayLength(arr, 0);
    await waitForObserverScan();

    doc.getMap('recordTombstones').delete('tasks:r-tombstone-delete');

    await vi.waitFor(() => {
      expect(doc.getMap('recordTombstones').has('tasks:r-tombstone-delete')).toBe(true);
    }, { timeout: 500 });

    addRecord(doc, 'tasks', signedRecord);

    await waitForArrayLength(arr, 0);
  });

  it('restores a tampered record tombstone before accepting replayed records', async () => {
    const dappId = `dapp-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);
    const signer = await createSigner();
    addMember(doc, signer.publicKey, 'editor');
    const signedRecord = await signer.sign({
      id: 'r-tampered-tombstone',
      title: 'deleted task',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: signer.publicKey,
      _createdBy: signer.publicKey,
    });
    const arr = addRecord(doc, 'tasks', signedRecord);

    setupAuthObserver(dappId, { scanDebounceMs: 0 });
    await waitForArrayLength(arr, 1);

    const signedTombstone = await signer.sign({
      entityId: 'tasks',
      recordId: 'r-tampered-tombstone',
      deletedAt: '2026-01-02T00:00:00.000Z',
    });
    doc.transact(() => {
      writeTombstone(doc.getMap('recordTombstones'), 'tasks:r-tampered-tombstone', signedTombstone);
      arr.delete(0, 1);
    });
    await waitForArrayLength(arr, 0);
    await waitForObserverScan();

    const tombstone = doc.getMap('recordTombstones').get('tasks:r-tampered-tombstone') as Y.Map<unknown>;
    tombstone.set('deletedAt', '2025-01-01T00:00:00.000Z');

    await vi.waitFor(() => {
      const restored = doc.getMap('recordTombstones').get('tasks:r-tampered-tombstone') as Y.Map<unknown> | undefined;
      expect(restored?.get('deletedAt')).toBe('2026-01-02T00:00:00.000Z');
    }, { timeout: 500 });

    addRecord(doc, 'tasks', signedRecord);

    await waitForArrayLength(arr, 0);
  });

  it('restores a deleted member tombstone before accepting replayed member grants', async () => {
    const dappId = `dapp-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);
    const owner = await createSigner();
    addMember(doc, owner.publicKey, 'owner');
    const removedPublicKey = 'dd'.repeat(32);
    const signedMember = await owner.sign({
      publicKey: removedPublicKey,
      name: 'Removed',
      role: 'editor',
      memberUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    addMember(doc, removedPublicKey, 'editor', signedMember);

    setupAuthObserver(dappId, { scanDebounceMs: 0 });
    await vi.waitFor(() => {
      expect(doc.getMap('members').has(removedPublicKey)).toBe(true);
    }, { timeout: 500 });

    const signedTombstone = await owner.sign({
      publicKey: removedPublicKey,
      removed: true,
      removedAt: '2026-01-02T00:00:00.000Z',
    });
    doc.transact(() => {
      writeTombstone(doc.getMap('memberTombstones'), removedPublicKey, signedTombstone);
      doc.getMap('members').delete(removedPublicKey);
    });
    await vi.waitFor(() => {
      expect(doc.getMap('members').has(removedPublicKey)).toBe(false);
    }, { timeout: 500 });
    await waitForObserverScan();

    doc.getMap('memberTombstones').delete(removedPublicKey);

    await vi.waitFor(() => {
      expect(doc.getMap('memberTombstones').has(removedPublicKey)).toBe(true);
    }, { timeout: 500 });

    const replayedMember = new Y.Map<unknown>();
    Object.entries(signedMember).forEach(([key, value]) => replayedMember.set(key, value));
    doc.getMap('members').set(removedPublicKey, replayedMember);

    await vi.waitFor(() => {
      expect(doc.getMap('members').has(removedPublicKey)).toBe(false);
    }, { timeout: 500 });
  });

  it('restores a tampered member tombstone before accepting replayed member grants', async () => {
    const dappId = `dapp-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);
    const owner = await createSigner();
    addMember(doc, owner.publicKey, 'owner');
    const removedPublicKey = 'ee'.repeat(32);
    const signedMember = await owner.sign({
      publicKey: removedPublicKey,
      name: 'Removed',
      role: 'editor',
      memberUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    addMember(doc, removedPublicKey, 'editor', signedMember);

    setupAuthObserver(dappId, { scanDebounceMs: 0 });
    await vi.waitFor(() => {
      expect(doc.getMap('members').has(removedPublicKey)).toBe(true);
    }, { timeout: 500 });

    const signedTombstone = await owner.sign({
      publicKey: removedPublicKey,
      removed: true,
      removedAt: '2026-01-02T00:00:00.000Z',
    });
    doc.transact(() => {
      writeTombstone(doc.getMap('memberTombstones'), removedPublicKey, signedTombstone);
      doc.getMap('members').delete(removedPublicKey);
    });
    await vi.waitFor(() => {
      expect(doc.getMap('members').has(removedPublicKey)).toBe(false);
    }, { timeout: 500 });
    await waitForObserverScan();

    const tombstone = doc.getMap('memberTombstones').get(removedPublicKey) as Y.Map<unknown>;
    tombstone.set('removedAt', '2025-01-01T00:00:00.000Z');

    await vi.waitFor(() => {
      const restored = doc.getMap('memberTombstones').get(removedPublicKey) as Y.Map<unknown> | undefined;
      expect(restored?.get('removedAt')).toBe('2026-01-02T00:00:00.000Z');
    }, { timeout: 500 });

    const replayedMember = new Y.Map<unknown>();
    Object.entries(signedMember).forEach(([key, value]) => replayedMember.set(key, value));
    doc.getMap('members').set(removedPublicKey, replayedMember);

    await vi.waitFor(() => {
      expect(doc.getMap('members').has(removedPublicKey)).toBe(false);
    }, { timeout: 500 });
  });
});

describe('auth observer app role assignment enforcement', () => {
  beforeEach(() => {
    docs.clear();
  });

  it('reverts a role assignment with a bogus signature even when assignedBy is a known owner', async () => {
    const dappId = `dapp-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);
    const ownerPublicKey = 'f1'.repeat(32);
    addMember(doc, ownerPublicKey, 'owner');
    const targetPublicKey = 'f2'.repeat(32);
    addMember(doc, targetPublicKey, 'editor');

    setupAuthObserver(dappId, { scanDebounceMs: 0 });

    addRoleAssignment(doc, targetPublicKey, {
      roleId: 'player',
      assignedAt: '2026-01-01T00:00:00.000Z',
      assignedBy: ownerPublicKey,
      _signedBy: ownerPublicKey,
      _signature: '00',
    });

    await vi.waitFor(() => {
      expect(doc.getMap('roleAssignments').has(targetPublicKey)).toBe(false);
    }, { timeout: 500 });
  });

  it('reverts a role assignment signed by a non-owner', async () => {
    const dappId = `dapp-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);
    const editor = await createSigner();
    addMember(doc, editor.publicKey, 'editor');
    const targetPublicKey = 'f3'.repeat(32);
    addMember(doc, targetPublicKey, 'editor');

    setupAuthObserver(dappId, { scanDebounceMs: 0 });

    const signedAssignment = await editor.sign({
      publicKey: targetPublicKey,
      roleId: 'player',
      assignedAt: '2026-01-01T00:00:00.000Z',
      assignedBy: editor.publicKey,
    });
    addRoleAssignment(doc, targetPublicKey, signedAssignment);

    await vi.waitFor(() => {
      expect(doc.getMap('roleAssignments').has(targetPublicKey)).toBe(false);
    }, { timeout: 500 });
  });

  it('rejects replaying an older role assignment after a newer one is accepted', async () => {
    const dappId = `dapp-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);
    const owner = await createSigner();
    addMember(doc, owner.publicKey, 'owner');
    const targetPublicKey = 'f4'.repeat(32);
    addMember(doc, targetPublicKey, 'editor');

    setupAuthObserver(dappId, { scanDebounceMs: 0 });

    const olderAssignment = await owner.sign({
      publicKey: targetPublicKey,
      roleId: 'player',
      assignedAt: '2026-01-01T00:00:00.000Z',
      assignedBy: owner.publicKey,
    });
    const entry = addRoleAssignment(doc, targetPublicKey, olderAssignment);
    await vi.waitFor(() => {
      expect(entry.get('roleId')).toBe('player');
    }, { timeout: 500 });

    const newerAssignment = await owner.sign({
      publicKey: targetPublicKey,
      roleId: 'spectator',
      assignedAt: '2026-01-02T00:00:00.000Z',
      assignedBy: owner.publicKey,
    });
    Object.entries(newerAssignment).forEach(([key, value]) => entry.set(key, value));
    await vi.waitFor(() => {
      expect(entry.get('roleId')).toBe('spectator');
    }, { timeout: 500 });
    await waitForObserverScan();

    // Replaying the older, already-superseded assignment must not win.
    Object.entries(olderAssignment).forEach(([key, value]) => entry.set(key, value));

    await vi.waitFor(() => {
      expect(entry.get('roleId')).toBe('spectator');
    }, { timeout: 500 });
  });

  it('restores a role assignment entry if its key is deleted outright', async () => {
    const dappId = `dapp-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);
    const owner = await createSigner();
    addMember(doc, owner.publicKey, 'owner');
    const targetPublicKey = 'f5'.repeat(32);
    addMember(doc, targetPublicKey, 'editor');

    setupAuthObserver(dappId, { scanDebounceMs: 0 });

    const signedAssignment = await owner.sign({
      publicKey: targetPublicKey,
      roleId: 'player',
      assignedAt: '2026-01-01T00:00:00.000Z',
      assignedBy: owner.publicKey,
    });
    addRoleAssignment(doc, targetPublicKey, signedAssignment);
    await vi.waitFor(() => {
      expect(doc.getMap('roleAssignments').has(targetPublicKey)).toBe(true);
    }, { timeout: 500 });
    await waitForObserverScan();

    doc.getMap('roleAssignments').delete(targetPublicKey);

    await vi.waitFor(() => {
      expect(doc.getMap('roleAssignments').has(targetPublicKey)).toBe(true);
    }, { timeout: 500 });
  });
});
