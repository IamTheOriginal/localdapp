import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileDocPersistence, completeFramesLength, readFrames } from '../headless/filePersistence.ts';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-persist-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('FileDocPersistence', () => {
  it('restores document state across sessions', async () => {
    const dir = await tempDir();

    const first = new Y.Doc();
    const persistence = new FileDocPersistence(dir, first);
    await persistence.whenLoaded;
    first.getMap('config').set('name', 'Persisted');
    first.getArray('items').push(['one', 'two']);
    await persistence.destroy();

    const second = new Y.Doc();
    const reloaded = new FileDocPersistence(dir, second);
    await reloaded.whenLoaded;
    expect(second.getMap('config').get('name')).toBe('Persisted');
    expect(second.getArray('items').toArray()).toEqual(['one', 'two']);
    await reloaded.destroy();
  });

  it('compacts the log after the configured number of updates', async () => {
    const dir = await tempDir();
    const doc = new Y.Doc();
    const persistence = new FileDocPersistence(dir, doc, { compactAfterUpdates: 3 });
    await persistence.whenLoaded;

    const map = doc.getMap('data');
    for (let i = 0; i < 5; i++) map.set(`key-${i}`, i);
    await persistence.flush();

    // flush rewrites the snapshot and truncates the log
    const log = await fs.readFile(path.join(dir, 'log.bin'));
    expect(log.byteLength).toBe(0);
    const snapshot = await fs.readFile(path.join(dir, 'snapshot.bin'));
    expect(snapshot.byteLength).toBeGreaterThan(0);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, snapshot);
    expect(restored.getMap('data').get('key-4')).toBe(4);
    await persistence.destroy();
  });

  it('survives a torn tail frame in the log', async () => {
    const dir = await tempDir();
    const doc = new Y.Doc();
    const persistence = new FileDocPersistence(dir, doc);
    await persistence.whenLoaded;
    doc.getMap('data').set('kept', true);
    // Let the append land, then simulate a crash mid-append.
    await persistence.flush();
    await persistence.destroy();
    // Snapshot holds the state now; put a valid frame plus torn garbage in the log.
    const extra = new Y.Doc();
    Y.applyUpdate(extra, Y.encodeStateAsUpdate(doc));
    extra.getMap('data').set('alsoKept', 1);

    const framesFile = path.join(dir, 'log.bin');
    const update = Y.encodeStateAsUpdate(extra, Y.encodeStateVector(doc));
    const framed = new Uint8Array(4 + update.byteLength + 3);
    new DataView(framed.buffer).setUint32(0, update.byteLength, true);
    framed.set(update, 4);
    framed.set([0xff, 0x03, 0x99], 4 + update.byteLength); // torn header tail
    await fs.writeFile(framesFile, framed);

    const second = new Y.Doc();
    const reloaded = new FileDocPersistence(dir, second);
    await reloaded.whenLoaded;
    expect(second.getMap('data').get('kept')).toBe(true);
    expect(second.getMap('data').get('alsoKept')).toBe(1);
    await reloaded.destroy();
  });

  it('cuts a torn tail off the log, so later appends stay readable', async () => {
    const dir = await tempDir();
    const source = new Y.Doc();
    source.getMap('data').set('first', 1);
    const update = Y.encodeStateAsUpdate(source);
    const framed = new Uint8Array(4 + update.byteLength + 3);
    new DataView(framed.buffer).setUint32(0, update.byteLength, true);
    framed.set(update, 4);
    framed.set([0xff, 0x03, 0x99], 4 + update.byteLength);
    await fs.mkdir(dir, { recursive: true });
    // An empty snapshot keeps the boot from folding the log away, which would hide the problem.
    await fs.writeFile(path.join(dir, 'log.bin'), framed);
    expect(completeFramesLength(framed)).toBe(4 + update.byteLength);

    const doc = new Y.Doc();
    const persistence = new FileDocPersistence(dir, doc, { compactAfterUpdates: 1000 });
    await persistence.whenLoaded;
    doc.getMap('data').set('second', 2);
    await persistence.destroy();

    const restored = new Y.Doc();
    const reloaded = new FileDocPersistence(dir, restored);
    await reloaded.whenLoaded;
    expect(restored.getMap('data').toJSON()).toEqual({ first: 1, second: 2 });
    await reloaded.destroy();
  });

  it('moves a snapshot that does not decode aside instead of compacting over it', async () => {
    const dir = await tempDir();
    await fs.mkdir(dir, { recursive: true });
    const damaged = new Uint8Array([0x07, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0x02]);
    await fs.writeFile(path.join(dir, 'snapshot.bin'), damaged);

    const doc = new Y.Doc();
    const persistence = new FileDocPersistence(dir, doc);
    await persistence.whenLoaded;
    doc.getMap('data').set('fresh', true);
    await persistence.destroy();

    const kept = (await fs.readdir(dir)).filter((name) => name.startsWith('snapshot.bin.corrupt-'));
    expect(kept).toHaveLength(1);
    expect(new Uint8Array(await fs.readFile(path.join(dir, kept[0])))).toEqual(damaged);
  });

  it('refuses to load a critical document over a damaged snapshot and leaves the file alone', async () => {
    const dir = await tempDir();
    await fs.mkdir(dir, { recursive: true });
    const damaged = new Uint8Array([0x07, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0x02]);
    await fs.writeFile(path.join(dir, 'snapshot.bin'), damaged);

    const doc = new Y.Doc();
    const persistence = new FileDocPersistence(dir, doc, { critical: true });
    await expect(persistence.whenLoaded).rejects.toThrow(/refusing to start/);
    doc.getMap('data').set('ignored', true);
    await expect(persistence.destroy()).rejects.toThrow();

    expect(new Uint8Array(await fs.readFile(path.join(dir, 'snapshot.bin')))).toEqual(damaged);
    expect(await fs.readdir(dir)).toEqual(['snapshot.bin']);
  });

  it('readFrames stops at corrupt length prefixes without throwing', () => {
    const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x01]);
    expect([...readFrames(garbage)]).toEqual([]);
  });
});
