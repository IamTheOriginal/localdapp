import { MAX_FILE_THUMBNAIL_LENGTH } from './store/files.ts';

/**
 * Client-side thumbnail generation for image attachments. Returns a
 * `data:image/*` URL small enough to inline in a FileRecord (≤ 32 KB), or
 * null when the input is not a renderable image or the environment lacks
 * canvas support (tests, exotic formats). Never throws.
 */

const MAX_DIMENSION = 320;
const QUALITY_STEPS = [0.8, 0.6, 0.4, 0.25];

export async function createImageThumbnail(source: Blob): Promise<string | null> {
  if (!source.type.startsWith('image/')) return null;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  try {
    const bitmap = await createImageBitmap(source);
    try {
      const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(bitmap, 0, 0, width, height);
      for (const quality of QUALITY_STEPS) {
        const dataUrl = canvas.toDataURL('image/webp', quality);
        if (dataUrl.startsWith('data:image/') && dataUrl.length <= MAX_FILE_THUMBNAIL_LENGTH) return dataUrl;
      }
      const jpeg = canvas.toDataURL('image/jpeg', 0.5);
      return jpeg.startsWith('data:image/') && jpeg.length <= MAX_FILE_THUMBNAIL_LENGTH ? jpeg : null;
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}
