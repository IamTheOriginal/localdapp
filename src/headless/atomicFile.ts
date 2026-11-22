import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Crash-safe file replacement for the keeper's small state files and doc
 * snapshots: write a tmp file, fsync it, rename over the target, then fsync the
 * directory so the rename itself survives a power loss. A reader therefore
 * sees either the old or the new content, never a half-written file.
 */
export async function writeFileAtomic(filePath: string, data: string | Uint8Array, options: { mode?: number } = {}): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  const handle = await fs.open(tmpPath, 'w', options.mode ?? 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmpPath, filePath);
  // Directory fsync is not supported everywhere (Windows refuses to open a directory).
  const directory = await fs.open(path.dirname(filePath), 'r').catch(() => null);
  if (directory) {
    await directory.sync().catch(() => undefined);
    await directory.close();
  }
}
