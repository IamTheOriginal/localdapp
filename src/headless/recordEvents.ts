import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { VerifiedRecordsChange } from '../services/store/auth.ts';
import type { RecordEvent } from './eventSink.ts';
import { writeFileAtomic } from './atomicFile.ts';

/**
 * Turns the auth observer's verified-record feed into create/update/delete
 * events for the outbound sink. Only records the observer accepted are ever
 * seen here — raw doc state is never read.
 *
 * Restart semantics: a per-dapp cursor (`events.json` in the data dir) holds
 * the newest record timestamp already delivered. The first scan after a boot
 * re-emits every record; those with `createdAt`/`updatedAt` after the cursor
 * are delivered as missed events, older ones are only remembered. A dapp seen
 * for the very first time is *not* replayed: its existing records become the
 * baseline and events start from there.
 */

type Subscribe = (dappId: string, listener: (change: VerifiedRecordsChange) => void) => () => void;

interface RecordEventFeedOptions {
  dataDir: string;
  subscribe: Subscribe;
  dappName: (dappId: string) => string;
  emit: (event: RecordEvent) => void;
  now?: () => Date;
}

interface Cursor {
  lastAt: string;
}

const CURSOR_FILE = 'events.json';
const CURSOR_FLUSH_MS = 1_000;

function timestamp(record: Record<string, unknown>, field: 'createdAt' | 'updatedAt'): string | null {
  const value = record[field];
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function newest(record: Record<string, unknown>): string | null {
  const updated = timestamp(record, 'updatedAt');
  const created = timestamp(record, 'createdAt');
  if (updated && created) return updated > created ? updated : created;
  return updated ?? created;
}

function splitKey(key: string): { entityId: string; recordId: string } {
  const separator = key.indexOf(':');
  return separator === -1
    ? { entityId: key, recordId: '' }
    : { entityId: key.slice(0, separator), recordId: key.slice(separator + 1) };
}

export class RecordEventFeed {
  private readonly options: Required<RecordEventFeedOptions>;
  private readonly cursors = new Map<string, Cursor>();
  private readonly known = new Map<string, Map<string, Record<string, unknown>>>();
  private readonly unsubscribers = new Map<string, () => void>();
  private loaded: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(options: RecordEventFeedOptions) {
    this.options = { now: () => new Date(), ...options };
  }

  private get cursorPath(): string {
    return path.join(this.options.dataDir, CURSOR_FILE);
  }

  private load(): Promise<void> {
    this.loaded ??= fs.readFile(this.cursorPath, 'utf8')
      .then((text) => {
        const parsed = JSON.parse(text) as Record<string, Cursor>;
        Object.entries(parsed).forEach(([dappId, cursor]) => {
          if (cursor && typeof cursor.lastAt === 'string') this.cursors.set(dappId, { lastAt: cursor.lastAt });
        });
      })
      .catch((error: unknown) => {
        // A missing file is a first boot. Anything else means the cursors are gone: every
        // dapp becomes "first sight" (baseline only), so nothing is replayed twice.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('record events: events.json is unreadable, starting from a fresh baseline', error);
      });
    return this.loaded;
  }

  /** Start emitting for a dapp; idempotent. */
  async attach(dappId: string): Promise<void> {
    if (this.unsubscribers.has(dappId)) return;
    await this.load();
    this.known.set(dappId, new Map());
    this.unsubscribers.set(dappId, this.options.subscribe(dappId, (change) => { this.apply(dappId, change); }));
  }

  detach(dappId: string): void {
    this.unsubscribers.get(dappId)?.();
    this.unsubscribers.delete(dappId);
    this.known.delete(dappId);
  }

  async stop(): Promise<void> {
    for (const dappId of [...this.unsubscribers.keys()]) this.detach(dappId);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    await this.flush();
  }

  cursor(dappId: string): string | null {
    return this.cursors.get(dappId)?.lastAt ?? null;
  }

  private apply(dappId: string, change: VerifiedRecordsChange): void {
    const records = this.known.get(dappId);
    if (!records) return;
    const cursor = this.cursors.get(dappId);
    const at = this.options.now().toISOString();
    const dappName = this.options.dappName(dappId);
    let newestSeen = cursor?.lastAt ?? '';

    for (const { entityId, record } of change.upserts) {
      const id = typeof record.id === 'string' ? record.id : typeof record.id === 'number' ? String(record.id) : '';
      const key = `${entityId}:${id}`;
      const previous = records.get(key);
      records.set(key, record);
      // Timestamps are writer-supplied: one future-dated record must not push the
      // cursor ahead of the keeper's clock and hide every later change after a restart.
      const stamp = newest(record);
      const bounded = stamp && stamp > at ? at : stamp;
      if (bounded && bounded > newestSeen) newestSeen = bounded;

      if (previous) {
        if (JSON.stringify(previous) === JSON.stringify(record)) continue;
        this.options.emit({ type: 'record-updated', at, dappId, dappName, collection: entityId, record, previous });
        continue;
      }
      if (!cursor) continue; // first sight of this dapp: baseline only
      const created = timestamp(record, 'createdAt');
      const updated = timestamp(record, 'updatedAt');
      if (created && created > cursor.lastAt) {
        this.options.emit({ type: 'record-created', at, dappId, dappName, collection: entityId, record });
      } else if (updated && updated > cursor.lastAt) {
        this.options.emit({ type: 'record-updated', at, dappId, dappName, collection: entityId, record });
      }
    }

    for (const key of change.deletes) {
      const previous = records.get(key);
      if (!previous) continue;
      records.delete(key);
      const { entityId } = splitKey(key);
      this.options.emit({ type: 'record-deleted', at, dappId, dappName, collection: entityId, record: previous });
    }

    if (!cursor || newestSeen > cursor.lastAt) {
      this.cursors.set(dappId, { lastAt: newestSeen || at });
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((error: unknown) => {
        this.dirty = true; // picked up by the next change or by stop()
        console.error('record events: could not store the cursor', error);
      });
    }, CURSOR_FLUSH_MS);
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const payload = Object.fromEntries(this.cursors);
    await fs.mkdir(this.options.dataDir, { recursive: true });
    await writeFileAtomic(this.cursorPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
