import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';

/**
 * Every new collection stores each record as one immutable plain-JSON value
 * in a Y.Map keyed by record id, instead of a Y.Map with one CRDT entry per
 * field. These tests cover the write path, the existing-container-wins rule
 * for legacy arrays, their owner-side conversion, and the auth observer
 * enforcing signatures on compact containers (revert, restore, and
 * key-shadowing rejection).
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
    getIdentity: () => ({
      displayName: 'Compact user',
      publicKey: currentIdentity.publicKey,
      deviceId: 'compact-device',
    }),
    getSigningIdentity: () => Promise.resolve({
      publicKey: currentIdentity.publicKey,
      privateKey: currentIdentity.privateHex,
    }),
  };
});

const { addRecord, updateRecord, deleteRecord, getEntityRecords, migrateLegacyCollections } = await import('../services/store/data.ts');
const { setupAuthObserver, whenAuthObserversIdle } = await import('../services/store/auth.ts');
const { verifySignature, yMapFromObject } = await import('../services/store/protocolCore.ts');
const { getDappDoc } = await import('../services/store/docs.ts');

let dappId: string;

function dataContainer(entityId: string): unknown {
  return getDappDoc(dappId).getMap('data').get(entityId);
}

beforeEach(async () => {
  docs.clear();
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  currentIdentity = {
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', keyPair.publicKey)),
    privateHex: bufferToHex(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)),
  };
  dappId = `compact-${crypto.randomUUID()}`;
  const doc = getDappDoc(dappId);
  const member = new Y.Map<unknown>();
  member.set('publicKey', currentIdentity.publicKey);
  member.set('role', 'owner');
  doc.getMap('members').set(currentIdentity.publicKey, member);
});

describe('compact record format', () => {
  it('creates, reads, updates (whole-record LWW), and deletes compact records', async () => {
    await addRecord(dappId, 'recipes', { id: 'r1', title: 'Soup', rating: 4 });

    const container = dataContainer('recipes');
    expect(container).toBeInstanceOf(Y.Map);
    const stored = (container as Y.Map<Record<string, unknown>>).get('r1');
    expect(stored).not.toBeInstanceOf(Y.Map); // one plain value, not per-field CRDT entries
    expect(stored).toMatchObject({ id: 'r1', title: 'Soup', rating: 4 });
    expect(await verifySignature({ ...stored }, String(stored?._signedBy))).toBe(true);

    const read = getEntityRecords(dappId, 'recipes');
    expect(read?.map((row) => row.id)).toEqual(['r1']);

    await updateRecord(dappId, 'recipes', 'r1', { rating: 5 });
    const updated = (dataContainer('recipes') as Y.Map<Record<string, unknown>>).get('r1');
    expect(updated).toMatchObject({ id: 'r1', title: 'Soup', rating: 5 });
    expect(typeof updated?.updatedAt).toBe('string');
    expect(await verifySignature({ ...updated }, String(updated?._signedBy))).toBe(true);

    await deleteRecord(dappId, 'recipes', 'r1');
    expect((dataContainer('recipes') as Y.Map<unknown>).size).toBe(0);
    expect(getDappDoc(dappId).getMap('recordTombstones').has('recipes:r1')).toBe(true);
  });

  /** Rebuilds a collection in the legacy array shape from its current records (what old builds wrote). */
  function toLegacyArray(entityId: string): Y.Array<Y.Map<unknown>> {
    const records = getEntityRecords(dappId, entityId) ?? [];
    const legacy = new Y.Array<Y.Map<unknown>>();
    getDappDoc(dappId).getMap('data').set(entityId, legacy);
    legacy.push(records.map((record) => yMapFromObject(record)));
    return legacy;
  }

  it('keeps writing legacy format into a collection born as an array', async () => {
    await addRecord(dappId, 'notes', { id: 'n1', body: 'legacy' });
    toLegacyArray('notes');
    expect(dataContainer('notes')).toBeInstanceOf(Y.Array);

    await addRecord(dappId, 'notes', { id: 'n2', body: 'still legacy' });
    expect(dataContainer('notes')).toBeInstanceOf(Y.Array);
    expect((dataContainer('notes') as Y.Array<unknown>).length).toBe(2);
    expect(getEntityRecords(dappId, 'notes')?.map((row) => row.id)).toEqual(['n1', 'n2']);

    // New collections get the compact shape; the manifest cannot opt out.
    await addRecord(dappId, 'tags', { id: 't1', label: 'new' });
    expect(dataContainer('tags')).toBeInstanceOf(Y.Map);
  });

  it('owner devices convert legacy arrays to compact on open, keeping signatures and satisfying the auth observer', async () => {
    await addRecord(dappId, 'notes', { id: 'n1', body: 'one' });
    await addRecord(dappId, 'notes', { id: 'n2', body: 'two' });
    await addRecord(dappId, 'tags', { id: 't1', label: 'already compact' });
    toLegacyArray('notes');
    expect(dataContainer('notes')).toBeInstanceOf(Y.Array);
    setupAuthObserver(dappId, { scanDebounceMs: 0 });
    await whenAuthObserversIdle(); // first scan verified the legacy rows

    expect(migrateLegacyCollections(dappId)).toBe(1);
    const container = dataContainer('notes') as Y.Map<Record<string, unknown>>;
    expect(container).toBeInstanceOf(Y.Map);
    expect([...container.keys()].sort()).toEqual(['n1', 'n2']);
    for (const id of ['n1', 'n2']) {
      const record = container.get(id);
      expect(record).not.toBeInstanceOf(Y.Map);
      expect(await verifySignature({ ...record }, String(record?._signedBy))).toBe(true);
    }
    expect(migrateLegacyCollections(dappId)).toBe(0); // idempotent
    expect(dataContainer('tags')).toBeInstanceOf(Y.Map);

    // The running auth observer accepts the moved records as-is — nothing reverted.
    await whenAuthObserversIdle();
    expect(getEntityRecords(dappId, 'notes')?.map((row) => row.id).sort()).toEqual(['n1', 'n2']);
    expect(container.get('n1')?.body).toBe('one');
  });

  it('non-owner devices leave legacy arrays untouched', async () => {
    await addRecord(dappId, 'notes', { id: 'n1', body: 'one' });
    toLegacyArray('notes');
    const member = getDappDoc(dappId).getMap('members').get(currentIdentity.publicKey) as Y.Map<unknown>;
    member.set('role', 'editor');
    expect(migrateLegacyCollections(dappId)).toBe(0);
    expect(dataContainer('notes')).toBeInstanceOf(Y.Array);
  });

  it('auth observer restores a tampered compact record and rejects key shadowing', async () => {
    await addRecord(dappId, 'recipes', { id: 'r1', title: 'Original' });
    setupAuthObserver(dappId, { scanDebounceMs: 0 });

    const container = dataContainer('recipes') as Y.Map<Record<string, unknown>>;
    await vi.waitFor(() => {
      expect(container.get('r1')?.title).toBe('Original'); // first scan verified it
    });

    // Tamper: overwrite with an unsigned forgery — must be reverted to the
    // verified snapshot.
    const genuine = { ...container.get('r1') } as Record<string, unknown>;
    container.set('r1', { id: 'r1', title: 'Hacked' });
    await vi.waitFor(() => {
      expect(container.get('r1')?.title).toBe('Original');
      expect(container.get('r1')?._signature).toBe(genuine._signature);
    });

    // Key shadowing: a validly-signed record parked under a foreign key must
    // be dropped, not honored.
    container.set('r2', { ...genuine });
    await vi.waitFor(() => {
      expect(container.has('r2')).toBe(false);
      expect(container.get('r1')?.title).toBe('Original');
    });
  });
});
