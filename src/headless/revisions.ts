import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Source snapshots of dapps the keeper edits with AI (docs/HEADLESS.md,
 * "AI dapp creation"). One JSON file per snapshot under
 * `<dataDir>/revisions/<dappId>/`, taken *before* every AI edit or revert so
 * any step can be undone. Kept on the keeper's disk, not in a dapp record: a
 * snapshot can be megabytes, records cannot.
 *
 * This store is the only writer of that directory. `list` is polled by the
 * control dapp's status tick, so its summaries are cached per dapp and the
 * cache is dropped by every write here — an unchanged dapp costs no disk I/O.
 */

export interface RevisionSummary {
  id: string;
  at: string;
  note: string;
}

interface RevisionFile extends RevisionSummary {
  files: Record<string, string>;
}

/** Snapshots kept (and listed) per dapp; `save` deletes older ones. */
const MAX_REVISIONS = 20;
const ID_PATTERN = /^[0-9TZ.-]{1,40}$/;

export class RevisionStore {
  private readonly root: string;
  /** Summaries per dapp as last read from disk; absent = read again. */
  private readonly summaries = new Map<string, RevisionSummary[]>();
  /** Bumped by every write, so a `list` that raced a write does not cache stale summaries. */
  private readonly writes = new Map<string, number>();

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'revisions');
  }

  private dir(dappId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(dappId)) throw new Error('revisions: invalid dapp id');
    return path.join(this.root, dappId);
  }

  /** Call after anything that writes or deletes snapshot files of `dappId`. */
  private invalidate(dappId: string): void {
    this.summaries.delete(dappId);
    this.writes.set(dappId, (this.writes.get(dappId) ?? 0) + 1);
  }

  /** Snapshot file names of a dapp, newest first (ids are ISO timestamps, so names sort by time). */
  private async snapshotNames(dappId: string): Promise<string[]> {
    const names = await fs.readdir(this.dir(dappId));
    return names.filter((entry) => entry.endsWith('.json')).sort().reverse();
  }

  /**
   * Deletes all but the newest MAX_REVISIONS snapshots — never `keep`, the one
   * just written (a clock that jumped back must not cost the undo step).
   * Cleanup trouble never fails the save that triggered it.
   */
  private async prune(dappId: string, keep: string): Promise<void> {
    try {
      for (const name of (await this.snapshotNames(dappId)).slice(MAX_REVISIONS)) {
        if (name !== keep) await fs.rm(path.join(this.dir(dappId), name), { force: true });
      }
    } catch (error) {
      console.warn(`revisions: pruning ${dappId} failed`, error);
    }
  }

  /** Snapshot `files`; returns the new revision id (an ISO timestamp, filesystem-safe). */
  async save(dappId: string, files: Record<string, string>, note: string, now = new Date()): Promise<string> {
    const id = now.toISOString().replace(/:/g, '-');
    const dir = this.dir(dappId);
    await fs.mkdir(dir, { recursive: true });
    const record: RevisionFile = { id, at: now.toISOString(), note: note.slice(0, 200), files };
    try {
      await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(record));
      await this.prune(dappId, `${id}.json`);
    } finally {
      this.invalidate(dappId);
    }
    return id;
  }

  /** Newest-first summaries, served from memory until the next write for this dapp. */
  async list(dappId: string): Promise<RevisionSummary[]> {
    const cached = this.summaries.get(dappId);
    if (cached) return cached.map((summary) => ({ ...summary }));
    const writesBefore = this.writes.get(dappId) ?? 0;
    let names: string[];
    try {
      names = await this.snapshotNames(dappId);
    } catch {
      names = [];
    }
    const summaries: RevisionSummary[] = [];
    for (const name of names.slice(0, MAX_REVISIONS)) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.dir(dappId), name), 'utf8')) as RevisionFile;
        summaries.push({ id: parsed.id, at: parsed.at, note: parsed.note });
      } catch {
        // unreadable snapshot: skip, never crash the status tick
      }
    }
    if ((this.writes.get(dappId) ?? 0) === writesBefore) this.summaries.set(dappId, summaries);
    return summaries.map((summary) => ({ ...summary }));
  }

  async load(dappId: string, id: string): Promise<Record<string, string>> {
    if (!ID_PATTERN.test(id)) throw new Error('revisions: invalid revision id');
    const parsed = JSON.parse(await fs.readFile(path.join(this.dir(dappId), `${id}.json`), 'utf8')) as RevisionFile;
    if (!parsed.files || typeof parsed.files !== 'object') throw new Error('revisions: snapshot is malformed');
    return parsed.files;
  }
}
