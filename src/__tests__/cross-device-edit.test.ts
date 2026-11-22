import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const { setupAuthObserver, whenAuthObserversIdle } = await import('../services/store/auth.ts');
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
    void _signature; void _signedBy;
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      keyPair.privateKey,
      new TextEncoder().encode(stableStringify(data)),
    );
    return { ...data, _signedBy: publicKey, _signature: bufferToHex(signature) };
  }

  return { publicKey, sign };
}

function addMember(doc: Y.Doc, publicKey: string, role: 'owner' | 'editor' | 'viewer',
  extra: Record<string, unknown> = {}) {
  const members = doc.getMap('members');
  const member = new Y.Map<unknown>();
  member.set('publicKey', publicKey);
  member.set('role', role);
  Object.entries(extra).forEach(([key, value]) => member.set(key, value));
  members.set(publicKey, member);
  return member;
}

async function waitForStable(doc: Y.Doc, entityId: string, expectedCount: number): Promise<void> {
  await vi.waitFor(() => {
    const data = doc.getMap('data');
    const arr = data.get(entityId) as Y.Array<Y.Map<unknown>> | undefined;
    expect(arr?.length ?? 0).toBe(expectedCount);
  }, { timeout: 1000 });
}

/** Simulate signing like data.ts::updateRecord does */
function signUpdate(
  record: Record<string, unknown>,
  sign: (record: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  delete record._signature;
  delete record._signedBy;
  return sign(record);
}

describe('cross-device record edit', () => {
  beforeEach(() => {
    docs.clear();
  });

  it('accepts an update from another editor device', async () => {
    const dappId = `dapp-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);

    // Simulate two devices with different keypairs
    const owner = await createSigner();
    const editorDevice2 = await createSigner();

    // Set up the dapp: owner creates the dapp, editor joins
    addMember(doc, owner.publicKey, 'owner');
    addMember(doc, editorDevice2.publicKey, 'editor');

    // Create a signed record (as if owner created it)
    const createdRecord = await owner.sign({
      id: 'r1',
      title: 'original title',
      description: 'desc',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: owner.publicKey,
      _createdBy: owner.publicKey,
    });

    // Add it to the data map (simulating addRecord)
    const data = doc.getMap('data');
    const arr = new Y.Array<Y.Map<unknown>>();
    data.set('tasks', arr);
    const recordMap = new Y.Map<unknown>();
    Object.entries(createdRecord).forEach(([k, v]) => recordMap.set(k, v));
    arr.push([recordMap]);

    // Setup auth observer (simulates device 1)
    setupAuthObserver(dappId);
    await waitForStable(doc, 'tasks', 1);

    // --- Simulate Device 2 editing the record ---
    // Read current record (like updateRecord does)
    const currentRecord = arr.get(0);
    const current: Record<string, unknown> = {};
    currentRecord.forEach((val, key) => { current[key] = val; });

    // Apply update
    current.title = 'edited by device 2';
    current.updatedAt = '2026-01-02T00:00:00.000Z';
    current._updatedBy = editorDevice2.publicKey;
    current.createdBy = current._createdBy || current.createdBy;

    // Re-sign with Device 2's key (like updateRecord does)
    const signedUpdate = await signUpdate(current, editorDevice2.sign);
    const { _signedBy, _signature } = signedUpdate;

    // Write to Yjs (simulating what hits doc.transact in updateRecord)
    doc.transact(() => {
      currentRecord.set('title', 'edited by device 2');
      currentRecord.set('updatedAt', '2026-01-02T00:00:00.000Z');
      currentRecord.set('_updatedBy', editorDevice2.publicKey);
      currentRecord.set('_signedBy', _signedBy);
      currentRecord.set('_signature', _signature);
    });

    // Wait for observer to run
    await whenAuthObserversIdle();

    // The record should still exist (not reverted)
    const dataAfter = doc.getMap('data');
    const arrAfter = dataAfter.get('tasks') as Y.Array<Y.Map<unknown>>;
    expect(arrAfter.length).toBe(1);

    const finalRecord = arrAfter.get(0);
    expect(finalRecord.get('title')).toBe('edited by device 2');
    expect(finalRecord.get('_signedBy')).toBe(editorDevice2.publicKey);
  });

  it('accepts an update to a record originally created by another device', async () => {
    const dappId = `dapp-${crypto.randomUUID()}`;
    const doc = getDappDoc(dappId);

    const owner = await createSigner();
    const editorDevice2 = await createSigner();

    addMember(doc, owner.publicKey, 'owner');
    addMember(doc, editorDevice2.publicKey, 'editor');

    // Device 1 (owner) creates a record
    const createdRecord = await owner.sign({
      id: 'r1',
      title: 'original',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: owner.publicKey,
      _createdBy: owner.publicKey,
    });

    const data = doc.getMap('data');
    const arr = new Y.Array<Y.Map<unknown>>();
    data.set('tasks', arr);
    const recordMap = new Y.Map<unknown>();
    Object.entries(createdRecord).forEach(([k, v]) => recordMap.set(k, v));
    arr.push([recordMap]);

    setupAuthObserver(dappId);
    await waitForStable(doc, 'tasks', 1);

    // Now simulate a SECOND observer (as if Device 2 also has the observer)
    // This shouldn't matter since setupAuthObserver is idempotent, but let's test
    // the full flow: Device 2 updates, then both observers trigger

    // Device 2 updates the record (title + description)
    const record = arr.get(0);
    const current: Record<string, unknown> = {};
    record.forEach((val, key) => { current[key] = val; });
    current.title = 'updated by device 2';
    current.description = 'new field by d2';
    current.updatedAt = '2026-01-02T00:00:00.000Z';
    current._updatedBy = editorDevice2.publicKey;
    current.createdBy = current._createdBy || current.createdBy;

    const signedUpdate = await signUpdate(current, editorDevice2.sign);

    // Full transact like updateRecord does
    doc.transact(() => {
      record.set('title', 'updated by device 2');
      record.set('description', 'new field by d2');
      record.set('updatedAt', '2026-01-02T00:00:00.000Z');
      record.set('_updatedBy', editorDevice2.publicKey);
      record.set('createdBy', current.createdBy);
      record.set('_createdBy', current._createdBy);
      record.set('_signedBy', signedUpdate._signedBy);
      record.set('_signature', signedUpdate._signature);
    });

    await whenAuthObserversIdle();

    const dataAfter = doc.getMap('data');
    const arrAfter = dataAfter.get('tasks') as Y.Array<Y.Map<unknown>>;
    expect(arrAfter.length).toBe(1);
    const finalRecord = arrAfter.get(0);
    expect(finalRecord.get('title')).toBe('updated by device 2');
    expect(finalRecord.get('_signedBy')).toBe(editorDevice2.publicKey);
  });
});