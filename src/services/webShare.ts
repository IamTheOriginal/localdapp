import type { CodeAppManifest, CodeAppShareTargetAccept } from '@/types';

/**
 * Web Share Target support (manifest.webmanifest `share_target`, POST
 * /share-target with title/text/url fields and `files`). The service worker
 * (public/sw.js) answers the POST: it stages the files in the Cache API under
 * SHARE_STAGING_CACHE and redirects to GET /share-target?share=<id>&files=<n>
 * plus the text fields, which is what ShareTargetPage receives. Pure helpers
 * live here: normalize the launch query into a share payload, load staged
 * files, and decide which dapps may receive it (a dapp opts in via the Code
 * App manifest's `shareTarget.accepts`; delivery goes through
 * store/codeData.ts appendIncomingShare and, for files, fileIngest.ts).
 */

/** Cache name and URL prefix shared with public/sw.js — keep the three in sync. */
export const SHARE_STAGING_CACHE = 'dapp-builder-share-staging';
export const SHARE_STAGING_PREFIX = '/share-target/staged/';
export const MAX_SHARED_FILES = 20;

export interface WebShare {
  title?: string;
  text?: string;
  url?: string;
  files?: File[];
}

function asHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalizes the share-target launch params. Some platforms put the link into
 * `text` instead of `url`; a lone http(s) link in `text` is promoted to `url`.
 * Returns null when nothing shareable arrived (staged files count — pass the
 * loaded files in `files`).
 */
export function normalizeWebShare(params: URLSearchParams, files: File[] = []): WebShare | null {
  const title = params.get('title')?.trim() || undefined;
  const rawText = params.get('text')?.trim() || undefined;
  const url = asHttpUrl(params.get('url') ?? undefined) ?? asHttpUrl(rawText);
  const text = url && rawText && asHttpUrl(rawText) === url ? undefined : rawText;
  if (!text && !url && files.length === 0) return null;
  return {
    ...(title ? { title } : {}),
    ...(text ? { text } : {}),
    ...(url ? { url } : {}),
    ...(files.length > 0 ? { files: files.slice(0, MAX_SHARED_FILES) } : {}),
  };
}

/** The staged-files reference the service worker put into the redirect, or null for a plain text/url share. */
export function stagedShareRef(params: URLSearchParams): { id: string; count: number } | null {
  const id = params.get('share') ?? '';
  const count = Number(params.get('files') ?? '0');
  if (!/^[a-f0-9-]{8,64}$/.test(id) || !Number.isInteger(count) || count <= 0) return null;
  return { id, count: Math.min(count, MAX_SHARED_FILES) };
}

function stagedUrl(id: string, index: number): string {
  return `${SHARE_STAGING_PREFIX}${id}/${index}`;
}

/** Loads the files the service worker staged for this share; missing entries are skipped. */
export async function loadStagedShareFiles(ref: { id: string; count: number }): Promise<File[]> {
  if (typeof caches === 'undefined') return [];
  const cache = await caches.open(SHARE_STAGING_CACHE);
  const files: File[] = [];
  for (let index = 0; index < ref.count; index += 1) {
    const response = await cache.match(stagedUrl(ref.id, index));
    if (!response) continue;
    const name = decodeURIComponent(response.headers.get('x-share-name') ?? '') || `shared-${index + 1}`;
    const type = response.headers.get('content-type') ?? 'application/octet-stream';
    const blob = await response.blob();
    if (blob.size > 0) files.push(new File([blob], name, { type }));
  }
  return files;
}

/** Drops the staged copies once delivered (or dismissed). */
export async function clearStagedShare(ref: { id: string; count: number }): Promise<void> {
  if (typeof caches === 'undefined') return;
  const cache = await caches.open(SHARE_STAGING_CACHE);
  for (let index = 0; index < ref.count; index += 1) await cache.delete(stagedUrl(ref.id, index));
}

/**
 * 'files' when files are attached (text/title/url ride along as metadata),
 * 'url' when a valid http(s) link is present, otherwise 'text'.
 */
export function webShareKind(share: WebShare): CodeAppShareTargetAccept {
  if (share.files && share.files.length > 0) return 'files';
  return share.url ? 'url' : 'text';
}

/**
 * True when the manifest opts in to receiving this kind of share. File shares
 * additionally need `permissions.host.files` — the app can only read what it
 * received through `$files`.
 */
export function manifestAcceptsShare(manifest: CodeAppManifest, share: WebShare): boolean {
  const kind = webShareKind(share);
  if (!manifest.shareTarget?.accepts.includes(kind)) return false;
  return kind !== 'files' || manifest.permissions?.host?.files === true;
}
