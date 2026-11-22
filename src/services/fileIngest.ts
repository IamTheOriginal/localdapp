import type { FileRecord } from '../types.ts';
import { getBlobStore, MAX_BLOB_BYTES } from './blobStore.ts';
import { createImageThumbnail } from './imageThumbnails.ts';
import { addFileRecord } from './store/files.ts';

/**
 * The one way local content enters a dapp's file store: chunk + hash the
 * bytes into the blob store, write the signed FileRecord (editor-gated in
 * store/files.ts), and announce the blob to connected members. Shared by the
 * Files page, the `$files.add` bridge, and OS share delivery.
 */
export async function ingestLocalFile(
  dappId: string,
  data: Blob | Uint8Array,
  options: { name: string; mime?: string; thumbnail?: boolean },
): Promise<FileRecord> {
  const size = data instanceof Blob ? data.size : data.byteLength;
  if (size === 0 || size > MAX_BLOB_BYTES) throw new Error('files: file is empty or exceeds the size limit');
  const mime = options.mime?.trim() || 'application/octet-stream';
  const descriptor = await getBlobStore().putBlob(data);
  // Inline thumbnails live in the shared doc — bulk importers opt out so the
  // document stays light for every member.
  const thumbnail = options.thumbnail === false
    ? null
    : await createImageThumbnail(data instanceof Blob ? data : new Blob([data.slice().buffer], { type: mime }));
  const record = await addFileRecord(dappId, {
    ...descriptor,
    name: options.name,
    mime,
    ...(thumbnail ? { thumbnail } : {}),
  });
  try {
    const { announceLocalBlob } = await import('./blobRoomManager.ts');
    announceLocalBlob(dappId, descriptor.sha256);
  } catch {
    // best-effort announcement
  }
  return record;
}
