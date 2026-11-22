import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';

/**
 * Data of a removed or departed member, and record tombstones, must survive
 * the moment another device verifies them from scratch — every reload and every
 * fresh join. Before 2026-09-17 such a device saw "unknown signer" / "tombstone
 * without a record", deleted them, and peers that still held them restored
 * them again: data loss once every device had reloaded, plus an endless
 * restore / delete loop in between.
 *
 * Each test builds a dapp, then hands its state to a NEW doc with a fresh auth
 * observer — exactly what a reload or a joining device does.
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
vi.mock('../services/store/rotation.ts', () => ({ rotateDappCredentials: vi.fn() }));

interface TestIdentity { publicKey: string; signPrivateHex: string }
let currentIdentity: TestIdentity;

vi.mock('../services/identity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/identity.ts')>();
  return {
    ...actual,
    getIdentity: () => ({ displayName: 'test', publicKey: currentIdentity.publicKey, deviceId: 'd', encPublicKey: 'unused' }),
    getSigningIdentity: () => Promise.resolve({ publicKey: currentIdentity.publicKey, privateKey: currentIdentity.signPrivateHex }),
  };
});

const { setupAuthObserver } = await import('../services/store/auth.ts');
const {
  signWithIdentity, writeSignedMember, writeSignedMemberRemoval, writeSignedRecordTombstone, yMapFromObject,
} = await import('../services/store/protocolCore.ts');
const { getDappDoc } = await import('../services/store/docs.ts');

async function createTestIdentity(): Promise<TestIdentity> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  return {
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', pair.publicKey)),
    signPrivateHex: bufferToHex(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  };
}

const signingOf = (identity: TestIdentity) => ({ publicKey: identity.publicKey, privateKey: identity.signPrivateHex });

/** A dapp founded by `founder` (legacy unsigned founder entry, as initDappDoc writes it). */
function foundDapp(dappId: string, founder: TestIdentity): Y.Doc {
  const doc = getDappDoc(dappId);
  const meta = new Y.Map<unknown>();
  meta.set('createdBy', founder.publicKey);
  doc.getMap('config').set('meta', meta);
  doc.getMap('members').set(founder.publicKey, yMapFromObject({ publicKey: founder.publicKey, name: 'Founder', role: 'owner' }));
  doc.getMap('data').set('items', new Y.Map());
  return doc;
}

async function writeRecord(doc: Y.Doc, author: TestIdentity, id: string, updatedAt: string): Promise<void> {
  const payload = { id, title: `note ${id}`, createdAt: updatedAt, updatedAt };
  const signature = await signWithIdentity(signingOf(author), payload);
  (doc.getMap('data').get('items') as Y.Map<unknown>).set(id, { ...payload, ...signature });
}

function recordIds(doc: Y.Doc): string[] {
  return [...(doc.getMap('data').get('items') as Y.Map<unknown>).keys()].sort();
}

/** Simulates a reload / fresh join: the state arrives in a new doc that a new observer verifies from scratch. */
async function verifyFromScratch(source: Y.Doc, freshId: string): Promise<Y.Doc> {
  const fresh = getDappDoc(freshId);
  setupAuthObserver(freshId, { scanDebounceMs: 10 });
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(source));
  // Two scan rounds: the first may mutate and schedule a follow-up.
  await new Promise((resolve) => setTimeout(resolve, 250));
  return fresh;
}

const BEFORE = '2026-01-01T10:00:00.000Z';
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

let founder: TestIdentity;
let editor: TestIdentity;
let viewer: TestIdentity;

beforeEach(async () => {
  docs.clear();
  founder = await createTestIdentity();
  editor = await createTestIdentity();
  viewer = await createTestIdentity();
  currentIdentity = founder;
});

describe('records of former members', () => {
  it('keeps the records of an editor an owner removed', async () => {
    const doc = foundDapp('removed-editor', founder);
    await writeSignedMember(doc, { publicKey: editor.publicKey, name: 'Bob', role: 'editor' }, signingOf(founder));
    await writeRecord(doc, editor, 'r1', BEFORE);
    await writeSignedMemberRemoval(doc, editor.publicKey, signingOf(founder), founder.publicKey);

    const tombstone = (doc.getMap('memberTombstones').get(editor.publicKey) as Y.Map<unknown>).toJSON();
    expect(tombstone.formerRole).toBe('editor');
    expect(doc.getMap('members').has(editor.publicKey)).toBe(false);

    const fresh = await verifyFromScratch(doc, 'removed-editor-reload');
    expect(recordIds(fresh)).toEqual(['r1']);
  });

  it('keeps the records of an editor who left, proven by the owner-signed entry inside the self-signed tombstone', async () => {
    const doc = foundDapp('departed-editor', founder);
    await writeSignedMember(doc, { publicKey: editor.publicKey, name: 'Bob', role: 'editor' }, signingOf(founder));
    await writeRecord(doc, editor, 'r1', BEFORE);
    await writeSignedMemberRemoval(doc, editor.publicKey, signingOf(editor), founder.publicKey);

    const fresh = await verifyFromScratch(doc, 'departed-editor-reload');
    expect(recordIds(fresh)).toEqual(['r1']);
  });

  it('does not let a departing viewer legitimize records — neither by its real entry nor by claiming a role', async () => {
    const doc = foundDapp('departed-viewer', founder);
    await writeSignedMember(doc, { publicKey: viewer.publicKey, name: 'Eve', role: 'viewer' }, signingOf(founder));
    await writeRecord(doc, viewer, 'forged', BEFORE);
    await writeSignedMemberRemoval(doc, viewer.publicKey, signingOf(viewer), founder.publicKey);
    // Self-asserted role on a self-signed tombstone is worth nothing.
    const tombstone = doc.getMap('memberTombstones').get(viewer.publicKey) as Y.Map<unknown>;
    expect(tombstone.get('formerRole')).toBe('viewer');

    const fresh = await verifyFromScratch(doc, 'departed-viewer-reload');
    expect(recordIds(fresh)).toEqual([]);
  });

  it('reverts a record stamped after the removal', async () => {
    const doc = foundDapp('late-write', founder);
    await writeSignedMember(doc, { publicKey: editor.publicKey, name: 'Bob', role: 'editor' }, signingOf(founder));
    await writeRecord(doc, editor, 'before', BEFORE);
    await writeSignedMemberRemoval(doc, editor.publicKey, signingOf(founder), founder.publicKey);
    await writeRecord(doc, editor, 'after', FAR_FUTURE);

    const fresh = await verifyFromScratch(doc, 'late-write-reload');
    expect(recordIds(fresh)).toEqual(['before']);
  });

  it('still reverts records of a removed member whose tombstone carries no proof (written before 2026-09-17)', async () => {
    const doc = foundDapp('legacy-tombstone', founder);
    await writeSignedMember(doc, { publicKey: editor.publicKey, name: 'Bob', role: 'editor' }, signingOf(founder));
    await writeRecord(doc, editor, 'r1', BEFORE);
    const payload = { publicKey: editor.publicKey, removed: true, removedAt: new Date().toISOString() };
    const signature = await signWithIdentity(signingOf(founder), payload);
    doc.transact(() => {
      doc.getMap('memberTombstones').set(editor.publicKey, yMapFromObject({ ...payload, ...signature }));
      doc.getMap('members').delete(editor.publicKey);
    });

    const fresh = await verifyFromScratch(doc, 'legacy-tombstone-reload');
    expect(recordIds(fresh)).toEqual([]);
  });
});

describe('member tombstone proof', () => {
  it('rejects a departure whose embedded entry is not the entry peers know (old "editor" entry replayed by a demoted viewer)', async () => {
    const doc = foundDapp('replayed-entry', founder);
    await writeSignedMember(doc, { publicKey: editor.publicKey, name: 'Bob', role: 'editor' }, signingOf(founder));
    const oldEditorEntry = JSON.stringify((doc.getMap('members').get(editor.publicKey) as Y.Map<unknown>).toJSON());
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeSignedMember(doc, { publicKey: editor.publicKey, name: 'Bob', role: 'viewer' }, signingOf(founder));
    setupAuthObserver('replayed-entry', { scanDebounceMs: 10 });
    doc.getMap('appData').set('ping', '1');
    await new Promise((resolve) => setTimeout(resolve, 80)); // baseline captured with Bob as viewer

    // Bob leaves, embedding the OLD owner-signed editor entry (sorted keys, as stableStringify would).
    const parsed = JSON.parse(oldEditorEntry) as Record<string, unknown>;
    const sorted = JSON.stringify(Object.fromEntries(Object.entries(parsed).sort(([a], [b]) => a.localeCompare(b))));
    const payload = { publicKey: editor.publicKey, removed: true, removedAt: new Date().toISOString(), formerRole: 'editor', formerEntry: sorted };
    const signature = await signWithIdentity(signingOf(editor), payload);
    doc.transact(() => {
      doc.getMap('memberTombstones').set(editor.publicKey, yMapFromObject({ ...payload, ...signature }));
      doc.getMap('members').delete(editor.publicKey);
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The forged departure is reverted: Bob is a member again (as viewer) and the tombstone is gone.
    expect((doc.getMap('members').get(editor.publicKey) as Y.Map<unknown> | undefined)?.get('role')).toBe('viewer');
    expect(doc.getMap('memberTombstones').has(editor.publicKey)).toBe(false);
  });
});

describe('record tombstones', () => {
  it('survive a reload, so a deleted record cannot be replayed', async () => {
    const doc = foundDapp('tombstone-reload', founder);
    await writeRecord(doc, founder, 'gone', BEFORE);
    const deletedCopy = (doc.getMap('data').get('items') as Y.Map<unknown>).get('gone') as Record<string, unknown>;
    await writeSignedRecordTombstone(doc, 'items', 'gone', signingOf(founder));
    expect(recordIds(doc)).toEqual([]);

    const fresh = await verifyFromScratch(doc, 'tombstone-reload-fresh');
    expect(fresh.getMap('recordTombstones').has('items:gone')).toBe(true);

    // Replaying the deleted record is reverted because the tombstone is still in force.
    (fresh.getMap('data').get('items') as Y.Map<unknown>).set('gone', deletedCopy);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(recordIds(fresh)).toEqual([]);
  });

  it('are still deleted when nobody with write rights signed them', async () => {
    const doc = foundDapp('forged-tombstone', founder);
    await writeSignedMember(doc, { publicKey: viewer.publicKey, name: 'Eve', role: 'viewer' }, signingOf(founder));
    const payload = { entityId: 'items', recordId: 'victim', deletedAt: new Date().toISOString() };
    const signature = await signWithIdentity(signingOf(viewer), payload);
    doc.getMap('recordTombstones').set('items:victim', yMapFromObject({ ...payload, ...signature }));

    const fresh = await verifyFromScratch(doc, 'forged-tombstone-fresh');
    expect(fresh.getMap('recordTombstones').has('items:victim')).toBe(false);
  });
});
