import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VerifiedRecordsChange } from '../services/store/auth.ts';
import type { RecordEvent } from '../headless/eventSink.ts';
import { RecordEventFeed } from '../headless/recordEvents.ts';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-events-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** A fake verified-record feed: tests push changes through `push`. */
function fakeAuthFeed() {
  const listeners = new Map<string, (change: VerifiedRecordsChange) => void>();
  return {
    subscribe: (dappId: string, listener: (change: VerifiedRecordsChange) => void) => {
      listeners.set(dappId, listener);
      return () => { listeners.delete(dappId); };
    },
    push: (dappId: string, change: VerifiedRecordsChange) => {
      const listener = listeners.get(dappId);
      if (!listener) throw new Error(`no listener for ${dappId}`);
      listener(change);
    },
    listening: (dappId: string) => listeners.has(dappId),
  };
}

function record(id: string, createdAt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, createdAt, createdBy: 'ab'.repeat(32), title: `Record ${id}`, ...extra };
}

function makeFeed(dataDir: string) {
  const auth = fakeAuthFeed();
  const events: RecordEvent[] = [];
  const feed = new RecordEventFeed({
    dataDir,
    subscribe: auth.subscribe,
    dappName: () => 'Recipes',
    emit: (event) => { events.push(event); },
    now: () => new Date('2026-09-09T12:00:00.000Z'),
  });
  return { auth, events, feed };
}

describe('RecordEventFeed', () => {
  it('takes the first scan of a never-seen dapp as the baseline and emits from then on', async () => {
    const dir = await tempDir();
    const { auth, events, feed } = makeFeed(dir);
    await feed.attach('dapp-1');

    auth.push('dapp-1', { upserts: [{ entityId: 'links', record: record('r1', '2026-09-01T00:00:00.000Z') }], deletes: [] });
    expect(events).toEqual([]);

    auth.push('dapp-1', { upserts: [{ entityId: 'links', record: record('r2', '2026-09-09T11:00:00.000Z') }], deletes: [] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'record-created', dappId: 'dapp-1', dappName: 'Recipes', collection: 'links', at: '2026-09-09T12:00:00.000Z',
    });
    expect(events[0].record.id).toBe('r2');
    await feed.stop();
  });

  it('never moves the cursor past its own clock, whatever a record claims', async () => {
    const dir = await tempDir();
    const { auth, feed } = makeFeed(dir);
    await feed.attach('dapp-1');
    auth.push('dapp-1', { upserts: [{ entityId: 'links', record: record('r1', '2026-09-01T00:00:00.000Z') }], deletes: [] });
    auth.push('dapp-1', { upserts: [{ entityId: 'links', record: record('future', '2031-01-01T00:00:00.000Z') }], deletes: [] });
    expect(feed.cursor('dapp-1')).toBe('2026-09-09T12:00:00.000Z');
    await feed.stop();

    // After a restart a change made after the keeper's clock is still delivered.
    const restarted = makeFeed(dir);
    await restarted.feed.attach('dapp-1');
    restarted.auth.push('dapp-1', { upserts: [
      { entityId: 'links', record: record('r1', '2026-09-01T00:00:00.000Z') },
      { entityId: 'links', record: record('missed', '2026-09-09T12:30:00.000Z') },
    ], deletes: [] });
    expect(restarted.events.map((entry) => entry.record.id)).toEqual(['missed']);
    await restarted.feed.stop();
  });

  it('emits updates with the previous state and deletions with the last known record', async () => {
    const dir = await tempDir();
    const { auth, events, feed } = makeFeed(dir);
    await feed.attach('dapp-1');
    auth.push('dapp-1', { upserts: [{ entityId: 'links', record: record('r1', '2026-09-01T00:00:00.000Z', { status: 'new' }) }], deletes: [] });

    auth.push('dapp-1', { upserts: [{ entityId: 'links', record: record('r1', '2026-09-01T00:00:00.000Z', { status: 'done', updatedAt: '2026-09-09T11:30:00.000Z' }) }], deletes: [] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'record-updated', collection: 'links' });
    expect(events[0].previous?.status).toBe('new');
    expect(events[0].record.status).toBe('done');

    // Byte-identical re-verification (e.g. an observer restore) is not an event.
    auth.push('dapp-1', { upserts: [{ entityId: 'links', record: record('r1', '2026-09-01T00:00:00.000Z', { status: 'done', updatedAt: '2026-09-09T11:30:00.000Z' }) }], deletes: [] });
    expect(events).toHaveLength(1);

    auth.push('dapp-1', { upserts: [], deletes: ['links:r1', 'links:never-seen'] });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'record-deleted', collection: 'links' });
    expect(events[1].record.status).toBe('done');
    await feed.stop();
  });

  it('persists a cursor and replays only what was missed after a restart', async () => {
    const dir = await tempDir();
    const first = makeFeed(dir);
    await first.feed.attach('dapp-1');
    first.auth.push('dapp-1', { upserts: [{ entityId: 'links', record: record('r1', '2026-09-01T00:00:00.000Z') }], deletes: [] });
    first.auth.push('dapp-1', { upserts: [{ entityId: 'links', record: record('r2', '2026-09-05T00:00:00.000Z') }], deletes: [] });
    expect(first.events.map((event) => event.record.id)).toEqual(['r2']);
    await first.feed.stop();
    expect(first.feed.cursor('dapp-1')).toBe('2026-09-05T00:00:00.000Z');
    expect(JSON.parse(await fs.readFile(path.join(dir, 'events.json'), 'utf8'))).toEqual({ 'dapp-1': { lastAt: '2026-09-05T00:00:00.000Z' } });

    // Restart: the first scan re-emits everything; only r3 (created) and r1 (updated) are newer than the cursor.
    const second = makeFeed(dir);
    await second.feed.attach('dapp-1');
    second.auth.push('dapp-1', {
      upserts: [
        { entityId: 'links', record: record('r1', '2026-09-01T00:00:00.000Z', { updatedAt: '2026-09-06T00:00:00.000Z', title: 'edited' }) },
        { entityId: 'links', record: record('r2', '2026-09-05T00:00:00.000Z') },
        { entityId: 'links', record: record('r3', '2026-09-07T00:00:00.000Z') },
      ],
      deletes: [],
    });
    expect(second.events.map((event) => [event.type, event.record.id])).toEqual([
      ['record-updated', 'r1'],
      ['record-created', 'r3'],
    ]);
    expect(second.events[0].previous).toBeUndefined();
    await second.feed.stop();
    expect(second.feed.cursor('dapp-1')).toBe('2026-09-07T00:00:00.000Z');
  });

  it('attach is idempotent and detach stops listening', async () => {
    const dir = await tempDir();
    const { auth, feed } = makeFeed(dir);
    await feed.attach('dapp-1');
    await feed.attach('dapp-1');
    expect(auth.listening('dapp-1')).toBe(true);
    feed.detach('dapp-1');
    expect(auth.listening('dapp-1')).toBe(false);
    await feed.stop();
  });
});
