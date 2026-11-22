import * as Y from 'yjs';
import { getRootDoc } from './docs.ts';
import { listRelationships } from './relationships.ts';
import { getPerson } from './people.ts';
import type { DappContactHandle } from '../../types.ts';
import { bufferToHex, hexToBuffer } from '../../lib/hex.ts';

function secretsMap(doc: Y.Doc): Y.Map<string> {
  return doc.getMap<string>('dappContactSecrets');
}

/** key: `${dappId}:${handle}` -> relationshipId. Lets the host resolve a handle an app hands back without inverting the HMAC. */
function handleIndexMap(doc: Y.Doc): Y.Map<string> {
  return doc.getMap<string>('dappContactHandleIndex');
}

/** Generated once per dapp and kept only in the local, never-synced root catalog. */
function getOrCreateDappContactSecret(dappId: string, doc: Y.Doc): string {
  const secrets = secretsMap(doc);
  const existing = secrets.get(dappId);
  if (existing) return existing;
  const secret = bufferToHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  secrets.set(dappId, secret);
  return secret;
}

/** Stable per (dapp, relationship), opaque, and not correlatable across dapps — see DappContactHandle. */
export async function deriveDappContactHandle(dappId: string, relationshipId: string, doc: Y.Doc = getRootDoc()): Promise<string> {
  const secret = getOrCreateDappContactSecret(dappId, doc);
  const key = await crypto.subtle.importKey('raw', hexToBuffer(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(relationshipId));
  const handle = bufferToHex(signature);
  handleIndexMap(doc).set(`${dappId}:${handle}`, relationshipId);
  return handle;
}

/** The only way to go from a handle an app hands back to a relationshipId — never exposed to app code directly. */
export function resolveDappContactHandle(dappId: string, handle: string, doc: Y.Doc = getRootDoc()): string | null {
  return handleIndexMap(doc).get(`${dappId}:${handle}`) ?? null;
}

/**
 * Every active relationship, scoped to this dapp's handle namespace — the pool a host-rendered
 * contact picker draws from. Never exposed to app code as a whole list (no $contacts.list()).
 */
export async function listDappContacts(dappId: string, doc: Y.Doc = getRootDoc()): Promise<DappContactHandle[]> {
  const relationships = listRelationships(doc).filter((relationship) => relationship.status === 'active');
  return Promise.all(relationships.map(async (relationship) => ({
    handle: await deriveDappContactHandle(dappId, relationship.id, doc),
    displayName: getPerson(relationship.personId, doc)?.displayName ?? 'Unknown',
    verified: Boolean(relationship.verifiedAt),
  })));
}
