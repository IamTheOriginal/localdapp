import * as Y from 'yjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomicFile.ts';

/**
 * File-based Yjs persistence for the headless runtime — the durable
 * counterpart of the browser's y-indexeddb (which runs against volatile
 * fake-indexeddb under Node).
 *
 * Layout per document directory:
 * - `snapshot.bin` — one full state update (`Y.encodeStateAsUpdate`)
 * - `log.bin` — appended incremental updates, each framed as
 *   4-byte little-endian length + update bytes
 *
 * Every doc update is appended to the log; once the log accumulates
 * `compactAfterUpdates` entries the whole state is rewritten into
 * `snapshot.bin` (tmp file + rename) and the log truncated. Loading applies
 * snapshot then log — Yjs updates are commutative and idempotent, so a torn
 * tail frame (crash mid-append) loses at most that one frame, which the next
 * peer sync re-delivers. The torn bytes are cut off on load: appending behind
 * them would make every later frame unreadable.
 *
 * A snapshot that does not decode is never overwritten: it is moved aside as
 * `snapshot.bin.corrupt-<timestamp>` (peers re-deliver a dapp's state), and for
 * a `critical` document — the root doc, which holds every credential and rule
 * and has no peer to come back from — loading fails instead, so the keeper
 * refuses to boot rather than compact an empty doc over the damaged file.
 */

const FRAME_HEADER_BYTES = 4;

function frame(update: Uint8Array): Uint8Array {
  const framed = new Uint8Array(FRAME_HEADER_BYTES + update.byteLength);
  new DataView(framed.buffer).setUint32(0, update.byteLength, true);
  framed.set(update, FRAME_HEADER_BYTES);
  return framed;
}

export function* readFrames(buffer: Uint8Array): Generator<Uint8Array> {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 0;
  while (offset + FRAME_HEADER_BYTES <= buffer.byteLength) {
    const length = view.getUint32(offset, true);
    const end = offset + FRAME_HEADER_BYTES + length;
    if (length === 0 || end > buffer.byteLength) return; // torn/corrupt tail — stop
    yield buffer.subarray(offset + FRAME_HEADER_BYTES, end);
    offset = end;
  }
}

/** Byte length of the leading run of complete frames; anything behind it is a torn tail. */
export function completeFramesLength(buffer: Uint8Array): number {
  let length = 0;
  for (const update of readFrames(buffer)) length += FRAME_HEADER_BYTES + update.byteLength;
  return length;
}

export class FileDocPersistence {
  readonly whenLoaded: Promise<void>;
  private readonly doc: Y.Doc;
  private readonly snapshotPath: string;
  private readonly logPath: string;
  private readonly compactAfterUpdates: number;
  private readonly critical: boolean;
  /** Serializes every disk mutation (appends and compactions) in order. */
  private chain: Promise<void>;
  private logEntries = 0;
  private destroyed = false;
  /** Set when a critical snapshot did not decode: nothing may be written over it. */
  private loadFailed = false;
  private readonly onUpdate: (update: Uint8Array, origin: unknown) => void;

  constructor(directory: string, doc: Y.Doc, options: { compactAfterUpdates?: number; critical?: boolean } = {}) {
    this.doc = doc;
    this.critical = options.critical ?? false;
    this.snapshotPath = path.join(directory, 'snapshot.bin');
    this.logPath = path.join(directory, 'log.bin');
    this.compactAfterUpdates = options.compactAfterUpdates ?? 400;

    this.whenLoaded = this.load(directory);
    // A failed load (critical snapshot damaged) must not write anything afterwards.
    this.chain = this.whenLoaded.catch(() => { this.loadFailed = true; });

    // Attached synchronously so updates arriving while the load is still
    // reading disk are not lost; their writes queue behind the load.
    this.onUpdate = (update, origin) => {
      if (origin === this || this.destroyed || this.loadFailed) return;
      this.enqueue(async () => {
        await fs.appendFile(this.logPath, frame(update));
        this.logEntries += 1;
        if (this.logEntries >= this.compactAfterUpdates) await this.writeSnapshot();
      });
    };
    doc.on('update', this.onUpdate);
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch((error: unknown) => {
      console.error('file persistence: write failed', this.logPath, error);
    });
  }

  private async load(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true });
    let hadLogEntries = false;
    for (const [file, isLog] of [[this.snapshotPath, false], [this.logPath, true]] as const) {
      let bytes: Uint8Array;
      try {
        bytes = await fs.readFile(file);
      } catch {
        continue; // first boot
      }
      if (isLog) {
        for (const update of readFrames(bytes)) {
          hadLogEntries = true;
          this.applyFromDisk(update);
        }
        const complete = completeFramesLength(bytes);
        if (complete < bytes.byteLength) {
          console.error(`file persistence: cutting ${bytes.byteLength - complete} torn bytes off ${file}`);
          await fs.truncate(file, complete);
        }
      } else if (bytes.byteLength > 0 && !this.applyFromDisk(bytes)) {
        if (this.critical) {
          throw new Error(`file persistence: ${file} does not decode — refusing to start over it; restore it from a backup or move it away deliberately`);
        }
        const aside = `${file}.corrupt-${Date.now()}`;
        console.error(`file persistence: ${file} does not decode, kept as ${aside}`);
        await fs.rename(file, aside);
      }
    }
    // Fold a non-empty log into the snapshot so logs never grow across boots.
    if (hadLogEntries) await this.writeSnapshot();
  }

  private applyFromDisk(update: Uint8Array): boolean {
    try {
      Y.applyUpdate(this.doc, update, this);
      return true;
    } catch (error) {
      console.error('file persistence: skipping corrupt update', this.logPath, error);
      return false;
    }
  }

  private async writeSnapshot(): Promise<void> {
    const state = Y.encodeStateAsUpdate(this.doc);
    await writeFileAtomic(this.snapshotPath, state);
    await fs.writeFile(this.logPath, new Uint8Array(0));
    this.logEntries = 0;
  }

  /** Flush pending writes and rewrite the snapshot from current doc state. */
  async flush(): Promise<void> {
    await this.whenLoaded;
    this.enqueue(() => this.writeSnapshot());
    await this.chain;
  }

  /** Detach from the doc after a final flush. Does not delete the files. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.doc.off('update', this.onUpdate);
    await this.flush();
  }
}
