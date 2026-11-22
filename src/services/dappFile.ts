import type { CodeAppDefinitionBundle } from '../types.ts';
import { verifyDefinitionBundle } from './store/definitionBundle.ts';

/**
 * The `.dapp` file: a signed Code App definition bundle
 * (`store/definitionBundle.ts`) serialized as JSON. One format for the
 * settings-page export, the Home-page import and OS file handling
 * (`file_handlers` in manifest.webmanifest → `/open-file`). Older exports
 * used the `.dapp.json` name; they are the same bytes and still import.
 */

export const DAPP_FILE_EXTENSION = '.dapp';
export const DAPP_FILE_MIME = 'application/vnd.dapp-builder+json';
/** Extensions the import pickers accept; the OS handler only registers `.dapp`. */
export const DAPP_FILE_ACCEPT = `${DAPP_FILE_EXTENSION},.dapp.json,.json,application/json,${DAPP_FILE_MIME}`;
export const DAPP_FILE_MAX_BYTES = 12_000_000;

/** `<slug>.dapp` from a display name. */
export function dappFileName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'code-app';
  return `${slug}${DAPP_FILE_EXTENSION}`;
}

export function serializeDappFile(bundle: CodeAppDefinitionBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/** Parses and fully verifies `.dapp` file text (signature, fingerprint, manifest). */
export async function parseDappFile(text: string): Promise<CodeAppDefinitionBundle> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Not a .dapp file (invalid JSON)');
  }
  if (!value || typeof value !== 'object' || !('protocol' in value) || value.protocol !== 'code-app-definition') {
    throw new Error('Not a Code App definition bundle');
  }
  return verifyDefinitionBundle(value);
}

export async function readDappFile(file: Blob): Promise<CodeAppDefinitionBundle> {
  if (file.size > DAPP_FILE_MAX_BYTES) throw new Error(`.dapp files are limited to ${Math.round(DAPP_FILE_MAX_BYTES / 1_000_000)} MB`);
  return parseDappFile(await file.text());
}

// ── OS launches (File Handling API) ──

interface LaunchParamsLike { files?: ReadonlyArray<{ getFile(): Promise<File> }> }
interface LaunchQueueLike { setConsumer(consumer: (params: LaunchParamsLike) => void): void }

/**
 * Hands the first file of an OS file-handler launch to `handler`, or does
 * nothing where the browser has no `launchQueue` (Firefox, Safari — there the
 * page shows its manual picker). Launches that happened before the consumer
 * was set are buffered by the browser and delivered here.
 */
export function consumeLaunchedDappFile(handler: (file: File) => void): void {
  const queue = (window as unknown as { launchQueue?: LaunchQueueLike }).launchQueue;
  if (!queue) return;
  queue.setConsumer((params) => {
    const first = params.files?.[0];
    if (first) void first.getFile().then(handler).catch(() => undefined);
  });
}
