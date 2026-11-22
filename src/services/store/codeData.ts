import { getDappDoc } from './docs.ts';
import { requireRole } from './auth.ts';

function validateKey(key: string): string {
  const normalized = key.trim();
  if (!normalized || normalized.length > 128) throw new Error('Data keys must be 1–128 characters');
  return normalized;
}

function cloneJsonValue(value: unknown): unknown {
  if (value === undefined) throw new Error('Undefined is not a supported Code App data value');
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Value must be JSON serializable');
  if (encoded.length > 256_000) throw new Error('Code App data values are limited to 256 KB');
  return JSON.parse(encoded);
}

export function getCodeAppData(dappId: string, key: string): unknown {
  return getDappDoc(dappId).getMap('appData').get(validateKey(key));
}

export function getCodeAppDataSnapshot(dappId: string): Record<string, unknown> {
  return getDappDoc(dappId).getMap('appData').toJSON();
}

export function setCodeAppData(dappId: string, key: string, value: unknown): void {
  requireRole(dappId, 'editor');
  getDappDoc(dappId).getMap('appData').set(validateKey(key), cloneJsonValue(value));
}

/**
 * Reserved `$data` key holding OS-level Web Share Target deliveries: a
 * newest-first array of {@link IncomingWebShare}, capped at
 * {@link MAX_INCOMING_SHARES}. A Code App reads it like any `$data` value
 * (`$data.get('incoming-shares')`, live via `$data.subscribe`) and consumes
 * entries by writing the key back without them.
 */
export const INCOMING_SHARES_KEY = 'incoming-shares';
export const MAX_INCOMING_SHARES = 20;
const MAX_SHARE_TITLE_LENGTH = 256;
const MAX_SHARE_TEXT_LENGTH = 8_192;
const MAX_SHARE_URL_LENGTH = 2_048;

interface IncomingWebShareFile {
  /** FileRecord id in this dapp's file store — read it with `$files.get(fileId)`. */
  fileId: string;
  name: string;
  mime: string;
  size: number;
}

interface IncomingWebShare {
  id: string;
  receivedAt: string;
  title?: string;
  text?: string;
  url?: string;
  files?: IncomingWebShareFile[];
}

const MAX_SHARE_FILES = 20;

/**
 * Delivers an OS share into the dapp's `$data` inbox. Same trust level as any
 * `$data` write: editor-gated, plain KV (not a signed record). The runtime's
 * deep appData observer makes running Code Apps see it immediately.
 */
export function appendIncomingShare(
  dappId: string,
  share: { title?: string; text?: string; url?: string; files?: IncomingWebShareFile[] },
): IncomingWebShare {
  requireRole(dappId, 'editor');
  const title = share.title?.trim().slice(0, MAX_SHARE_TITLE_LENGTH);
  const text = share.text?.trim().slice(0, MAX_SHARE_TEXT_LENGTH);
  const url = share.url?.trim().slice(0, MAX_SHARE_URL_LENGTH);
  const files = (share.files ?? [])
    .filter((file) => typeof file.fileId === 'string' && file.fileId)
    .slice(0, MAX_SHARE_FILES)
    .map((file) => ({
      fileId: file.fileId,
      name: String(file.name ?? '').slice(0, MAX_SHARE_TITLE_LENGTH),
      mime: String(file.mime ?? '').slice(0, 128),
      size: Number.isFinite(file.size) ? file.size : 0,
    }));
  if (!text && !url && files.length === 0) throw new Error('An incoming share needs text, a url, or files');
  const entry: IncomingWebShare = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    ...(title ? { title } : {}),
    ...(text ? { text } : {}),
    ...(url ? { url } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
  const appData = getDappDoc(dappId).getMap('appData');
  const existing = appData.get(INCOMING_SHARES_KEY);
  const inbox = Array.isArray(existing) ? (existing as unknown[]) : [];
  appData.set(INCOMING_SHARES_KEY, cloneJsonValue([entry, ...inbox.slice(0, MAX_INCOMING_SHARES - 1)]));
  return entry;
}

export function deleteCodeAppData(dappId: string, key: string): void {
  requireRole(dappId, 'editor');
  getDappDoc(dappId).getMap('appData').delete(validateKey(key));
}
