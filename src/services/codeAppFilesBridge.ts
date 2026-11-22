import type { FileRecord } from '../types.ts';
import { blobDescriptorOf, getBlobStore } from './blobStore.ts';
import { deleteFileRecord, getFileRecord, listFileRecords } from './store/files.ts';
import { isBlobStillReferenced } from './store/blobReferences.ts';
import { ingestLocalFile } from './fileIngest.ts';

/**
 * The `$files` bridge between Code App iframes and the blob store / signed
 * file index (plan Phase 4). Manifest gating (`permissions.host.files`) and
 * the viewer write-block happen in the runtime dispatch, mirroring the other
 * host-permission surfaces; this module owns the operations themselves.
 *
 * Bytes cross the postMessage boundary as ArrayBuffers (structured clone) —
 * the sandbox has no network access, so this is the only way file content
 * reaches an app, and it is bounded by MAX_BLOB_BYTES.
 */

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

async function loadBytes(dappId: string, record: FileRecord): Promise<Uint8Array | null> {
  const store = getBlobStore();
  const local = await store.getBlob(record.sha256);
  if (local) return local;
  try {
    const { fetchBlobFromPeers } = await import('./blobRoomManager.ts');
    if (await fetchBlobFromPeers(dappId, blobDescriptorOf(record))) {
      return store.getBlob(record.sha256);
    }
  } catch {
    // no channel available (e.g. non-browser host) — fall through
  }
  return null;
}

export async function handleFilesOperation(dappId: string, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'list':
      return listFileRecords(dappId);

    case 'find': {
      // Cheap host-side name lookup so apps can resolve stored filenames
      // (e.g. a recipe's imageName) without cloning the whole file index.
      const name = asString(args[0]).slice(0, 200);
      if (!name) return null;
      return listFileRecords(dappId).find((record) => record.name === name) ?? null;
    }

    case 'get': {
      const fileId = asString(args[0]);
      const record = getFileRecord(dappId, fileId);
      if (!record) return null;
      const bytes = await loadBytes(dappId, record);
      if (!bytes) throw new Error('File content is not available — no connected member holds a copy');
      // Copy into a plain ArrayBuffer so structured clone hands the app an
      // exact, independent buffer.
      const buffer = bytes.slice().buffer;
      return { record, bytes: buffer };
    }

    case 'add': {
      const input = (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]))
        ? args[0] as Record<string, unknown> : {};
      const rawBytes = input.bytes;
      let bytes: Uint8Array;
      if (rawBytes instanceof ArrayBuffer) bytes = new Uint8Array(rawBytes);
      else if (rawBytes instanceof Uint8Array) bytes = rawBytes;
      else throw new Error('$files.add requires bytes as an ArrayBuffer');
      // thumbnail: false lets bulk importers skip the inline preview.
      return ingestLocalFile(dappId, bytes, {
        name: asString(input.name),
        mime: asString(input.mime),
        thumbnail: input.thumbnail !== false,
      });
    }

    case 'delete': {
      const fileId = asString(args[0]);
      const record = getFileRecord(dappId, fileId);
      const deleted = await deleteFileRecord(dappId, fileId);
      if (deleted && record && !(await isBlobStillReferenced(dappId, record.sha256))) {
        await getBlobStore().deleteBlob(record.sha256);
      }
      return { success: deleted };
    }

    default:
      throw new Error(`Unknown $files operation: ${method}`);
  }
}
