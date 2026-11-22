import * as Y from 'yjs';
import { getDappDoc, getDappPersistence, getDappsList } from './docs.ts';

/**
 * The chunk store is ONE content-addressed store per device, shared by every
 * dapp. Before a blob's local copy is deleted, every other dapp on this device
 * has to be asked whether it lists the same content — the same photo attached
 * in two dapps is one blob, and this device may hold the only copy of it.
 */

/** y-indexeddb's `whenSynced` never settles when its database cannot be opened. */
const LOAD_TIMEOUT_MS = 3_000;

function fileHashes(doc: Y.Doc): string[] {
  const hashes: string[] = [];
  doc.getMap('files').forEach((raw) => {
    const sha256: unknown = raw instanceof Y.Map ? (raw as Y.Map<unknown>).get('sha256') : undefined;
    if (typeof sha256 === 'string') hashes.push(sha256);
  });
  return hashes;
}

/**
 * Content hashes listed in the file index of any dapp in the catalog except
 * `exceptDappId`. Reads the raw index on purpose: an entry the auth observer
 * is about to revert only makes this more careful, never less.
 */
export async function blobHashesReferencedElsewhere(exceptDappId: string): Promise<Set<string>> {
  const referenced = new Set<string>();
  const list = getDappsList();
  for (let index = 0; index < list.length; index++) {
    const dappId = list.get(index).get('id');
    if (!dappId || dappId === exceptDappId) continue;
    const doc = getDappDoc(dappId);
    const loaded = getDappPersistence(dappId)?.whenSynced.catch(() => undefined);
    if (loaded) await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, LOAD_TIMEOUT_MS))]);
    fileHashes(doc).forEach((sha256) => referenced.add(sha256));
  }
  return referenced;
}

/** True when `dappId` itself or any other dapp on this device still lists the content. */
export async function isBlobStillReferenced(dappId: string, sha256: string): Promise<boolean> {
  if (fileHashes(getDappDoc(dappId)).includes(sha256)) return true;
  return (await blobHashesReferencedElsewhere(dappId)).has(sha256);
}

/**
 * Content hashes listed in the file index of ANY dapp in the catalog. Loads every
 * catalog dapp's document (getDappDoc) — only for callers that hold them all open
 * anyway (the keeper's maintenance sweep), never for the browser shell.
 */
export async function blobHashesReferencedByAnyDapp(): Promise<Set<string>> {
  return blobHashesReferencedElsewhere('');
}
