import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeFsChunkBackend } from '../headless/blobBackend.ts';

const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

let dir: string;

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe('NodeFsChunkBackend', () => {
  it('round-trips chunks and reports presence', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chunks-'));
    const backend = new NodeFsChunkBackend(dir);
    const bytes = new Uint8Array([1, 2, 3, 4]);

    expect(await backend.has(HASH)).toBe(false);
    await backend.put(HASH, bytes);
    expect(await backend.has(HASH)).toBe(true);
    expect([...(await backend.get(HASH) ?? [])]).toEqual([1, 2, 3, 4]);
    expect(await backend.get(OTHER)).toBeNull();

    await backend.delete(HASH);
    expect(await backend.has(HASH)).toBe(false);
    await backend.delete(HASH); // idempotent
  });

  it('refuses malformed hashes (no path traversal)', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chunks-'));
    const backend = new NodeFsChunkBackend(dir);
    await expect(backend.put('../evil', new Uint8Array([1]))).rejects.toThrow('invalid chunk hash');
    await expect(backend.get('A'.repeat(64))).rejects.toThrow('invalid chunk hash');
  });
});
