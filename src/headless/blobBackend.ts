import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BlobChunkBackend } from '../services/blobStore.ts';

/**
 * Filesystem chunk backend for the headless runtime — the Node counterpart of
 * the browser's OPFS backend. Chunks are content-addressed files named by
 * their SHA-256; writes go through a tmp file + rename so a crash never leaves
 * a partial chunk under its final name. Blob-level metadata still lives in
 * (volatile) fake-indexeddb; after a restart the runtime re-registers blobs
 * from the synced FileRecords, and existing chunk files make that cheap.
 */

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export class NodeFsChunkBackend implements BlobChunkBackend {
  private readonly directory: string;
  private ready: Promise<void> | null = null;

  constructor(directory: string) {
    this.directory = directory;
  }

  private ensureDir(): Promise<void> {
    this.ready ??= fs.mkdir(this.directory, { recursive: true }).then(() => undefined);
    return this.ready;
  }

  private chunkPath(hash: string): string {
    if (!HASH_PATTERN.test(hash)) throw new Error('blob backend: invalid chunk hash');
    return path.join(this.directory, hash);
  }

  async put(hash: string, bytes: Uint8Array): Promise<void> {
    const target = this.chunkPath(hash);
    await this.ensureDir();
    const tmp = `${target}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, target);
  }

  async get(hash: string): Promise<Uint8Array | null> {
    const target = this.chunkPath(hash);
    try {
      return await fs.readFile(target);
    } catch {
      return null;
    }
  }

  async has(hash: string): Promise<boolean> {
    const target = this.chunkPath(hash);
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }

  async delete(hash: string): Promise<void> {
    const target = this.chunkPath(hash);
    try {
      await fs.unlink(target);
    } catch {
      // already gone
    }
  }
}
