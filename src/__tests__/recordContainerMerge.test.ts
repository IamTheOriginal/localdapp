import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { watchReplacedRecordContainers } from '../services/store/recordContainerMerge.ts';
import { containerRecords } from '../services/store/recordContainers.ts';

/**
 * Review item 5.9: a collection container is a last-writer-wins value of the
 * `data` map. When two devices create the same collection concurrently, or the
 * owner converts a legacy container while an editor writes into it, the losing
 * container's records must not vanish — their author's device puts them back.
 */

function device(publicKey: string): Y.Doc {
  const doc = new Y.Doc();
  watchReplacedRecordContainers(doc, () => publicKey);
  return doc;
}

/** Exchanges full state until neither side has anything new (re-added records travel in a second round). */
function sync(...docs: Y.Doc[]): void {
  for (let round = 0; round < 5; round++) {
    let changed = false;
    for (const from of docs) {
      for (const to of docs) {
        if (from === to) continue;
        const diff = Y.encodeStateAsUpdate(from, Y.encodeStateVector(to));
        const before = Y.encodeStateVector(to);
        Y.applyUpdate(to, diff);
        if (!equal(before, Y.encodeStateVector(to))) changed = true;
      }
    }
    if (!changed) return;
  }
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function record(id: string, signer: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title: id, createdAt: '2026-09-01T00:00:00.000Z', _signedBy: signer, _signature: `sig-${id}`, ...extra };
}

/** addRecord's first write to a collection: a fresh compact container. */
function writeFirstRecord(doc: Y.Doc, entityId: string, value: Record<string, unknown>): void {
  const container = new Y.Map<Record<string, unknown>>();
  container.set(String(value.id), value);
  doc.getMap('data').set(entityId, container);
}

function ids(doc: Y.Doc, entityId: string): string[] {
  return containerRecords(doc.getMap('data').get(entityId)).map((entry) => String(entry.id)).sort();
}

describe('replaced record containers', () => {
  it('keeps both first records when two devices create the same collection offline', () => {
    const alice = device('alice');
    const bob = device('bob');
    writeFirstRecord(alice, 'tasks', record('a1', 'alice'));
    writeFirstRecord(bob, 'tasks', record('b1', 'bob'));

    sync(alice, bob);

    expect(ids(alice, 'tasks')).toEqual(['a1', 'b1']);
    expect(ids(bob, 'tasks')).toEqual(['a1', 'b1']);
    // The re-added record is the signed original, byte for byte.
    const survivor = alice.getMap('data').get('tasks') as Y.Map<Record<string, unknown>>;
    expect(survivor.get('a1')).toEqual(record('a1', 'alice'));
    expect(survivor.get('b1')).toEqual(record('b1', 'bob'));
  });

  it('keeps several records per side and works whichever side wins', () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const alice = device('alice');
      const bob = device('bob');
      writeFirstRecord(alice, 'tasks', record('a1', 'alice'));
      (alice.getMap('data').get('tasks') as Y.Map<Record<string, unknown>>).set('a2', record('a2', 'alice'));
      writeFirstRecord(bob, 'tasks', record('b1', 'bob'));
      (bob.getMap('data').get('tasks') as Y.Map<Record<string, unknown>>).set('b2', record('b2', 'bob'));

      sync(bob, alice);

      expect(ids(alice, 'tasks')).toEqual(['a1', 'a2', 'b1', 'b2']);
      expect(ids(bob, 'tasks')).toEqual(['a1', 'a2', 'b1', 'b2']);
    }
  });

  it('survives a reload of the losing device before it meets the winner', () => {
    const alice = device('alice');
    const bob = device('bob');
    writeFirstRecord(alice, 'tasks', record('a1', 'alice'));
    writeFirstRecord(bob, 'tasks', record('b1', 'bob'));

    // Alice's device restarts: a new document loads her stored state, then meets Bob.
    const aliceReloaded = device('alice');
    Y.applyUpdate(aliceReloaded, Y.encodeStateAsUpdate(alice));
    sync(aliceReloaded, bob);

    expect(ids(aliceReloaded, 'tasks')).toEqual(['a1', 'b1']);
    expect(ids(bob, 'tasks')).toEqual(['a1', 'b1']);
  });

  it('only the author puts a record back — a third device relaying both containers does not', () => {
    const alice = device('alice');
    const bob = device('bob');
    const keeper = device('keeper');
    writeFirstRecord(alice, 'tasks', record('a1', 'alice'));
    writeFirstRecord(bob, 'tasks', record('b1', 'bob'));

    // The keeper sees both containers first; it restores nothing that is not its own.
    sync(keeper, alice);
    sync(keeper, bob);
    sync(alice, bob, keeper);

    for (const doc of [alice, bob, keeper]) expect(ids(doc, 'tasks')).toEqual(['a1', 'b1']);
  });

  it('keeps an editor write that raced the owner converting a legacy container', () => {
    const owner = device('owner');
    const editor = device('editor');
    const legacy = new Y.Array<Y.Map<unknown>>();
    const existing = new Y.Map<unknown>();
    Object.entries(record('old', 'owner')).forEach(([key, value]) => existing.set(key, value));
    legacy.push([existing]);
    owner.getMap('data').set('notes', legacy);
    sync(owner, editor);

    // Concurrently: the editor appends to the array, the owner converts it (data.ts::migrateLegacyCollections).
    const editorArray = editor.getMap('data').get('notes') as Y.Array<Y.Map<unknown>>;
    const added = new Y.Map<unknown>();
    Object.entries(record('new', 'editor')).forEach(([key, value]) => added.set(key, value));
    editorArray.push([added]);
    owner.transact(() => {
      const compact = new Y.Map<Record<string, unknown>>();
      for (const entry of containerRecords(owner.getMap('data').get('notes'))) compact.set(String(entry.id), entry);
      owner.getMap('data').set('notes', compact);
    });

    sync(owner, editor);

    for (const doc of [owner, editor]) {
      expect(doc.getMap('data').get('notes')).toBeInstanceOf(Y.Map);
      expect(ids(doc, 'notes')).toEqual(['new', 'old']);
    }
  });

  it('does not bring back a record a tombstone deleted, nor one deleted before the replacement', () => {
    const alice = device('alice');
    const bob = device('bob');
    writeFirstRecord(alice, 'tasks', record('a1', 'alice'));
    const aliceTasks = alice.getMap('data').get('tasks') as Y.Map<Record<string, unknown>>;
    aliceTasks.set('a2', record('a2', 'alice'));
    aliceTasks.set('a3', record('a3', 'alice'));
    // a2: deleted with a tombstone; a3: deleted earlier without one (an auth revert).
    const tombstone = new Y.Map<unknown>();
    tombstone.set('deletedAt', '2026-09-02T00:00:00.000Z');
    alice.transact(() => {
      alice.getMap('recordTombstones').set('tasks:a2', tombstone);
      aliceTasks.delete('a2');
    });
    aliceTasks.delete('a3');
    writeFirstRecord(bob, 'tasks', record('b1', 'bob'));

    sync(alice, bob);

    expect(ids(alice, 'tasks')).toEqual(['a1', 'b1']);
    expect(ids(bob, 'tasks')).toEqual(['a1', 'b1']);
  });

  it('a local replacement keeps this device\'s own records of the replaced container', () => {
    const alice = device('alice');
    writeFirstRecord(alice, 'tasks', record('a1', 'alice'));
    writeFirstRecord(alice, 'tasks', record('a9', 'alice'));
    expect(ids(alice, 'tasks')).toEqual(['a1', 'a9']);
  });
});
