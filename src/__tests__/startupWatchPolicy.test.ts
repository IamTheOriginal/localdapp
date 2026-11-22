// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';

/**
 * Review item 7.13: the shell opens only the dapps this device OWNS at startup. The decision
 * is made from a role cached in the local catalog, which docs.ts keeps in step with the role
 * the auth observer verified — so no document has to be opened to find out.
 */

const SELF = 'ab'.repeat(32);

vi.mock('../services/blobRoomManager.ts', () => ({ ensureBlobChannel: () => Promise.resolve(true), destroyBlobChannel: () => undefined }));
vi.mock('../services/identity.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/identity.ts')>(),
  getIdentity: () => ({ displayName: 'This device', publicKey: SELF, privateKey: '', deviceId: 'self', encPublicKey: '' }),
}));

const { getDappDoc, getDappsList } = await import('../services/store/docs.ts');
const { whenAuthObserversIdle } = await import('../services/store/auth.ts');
const { stableStringify, yMapFromObject } = await import('../services/store/protocolCore.ts');
const { watchedAtStartup } = await import('../hooks/useRequestsInbox.ts');

async function createSigner() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  const publicKey = bufferToHex(await crypto.subtle.exportKey('raw', pair.publicKey));
  const sign = async (record: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(stableStringify(record)));
    return { ...record, _signedBy: publicKey, _signature: bufferToHex(signature) };
  };
  return { publicKey, sign };
}

function catalogEntry(fields: Record<string, string>): Y.Map<string> {
  const item = new Y.Map<string>();
  Object.entries(fields).forEach(([key, value]) => item.set(key, value));
  getDappsList().push([item]);
  return item;
}

describe('which dapps the shell opens at startup', () => {
  it('records the verified role of this device in the catalog', async () => {
    const founder = await createSigner();
    const dappId = `watch-${crypto.randomUUID()}`;
    const item = catalogEntry({ id: dappId, name: 'Shopping List', roomId: `room-${dappId}`, roomPassword: 'pw'.repeat(16) });
    expect(item.get('role')).toBeUndefined();

    const doc = getDappDoc(dappId);
    const meta = new Y.Map<unknown>();
    meta.set('createdBy', founder.publicKey);
    doc.getMap('config').set('meta', meta);
    doc.getMap('members').set(founder.publicKey, yMapFromObject({ publicKey: founder.publicKey, role: 'owner', name: 'Owner' }));
    doc.getMap('members').set(SELF, yMapFromObject(await founder.sign({ publicKey: SELF, role: 'editor', name: 'This device', memberUpdatedAt: new Date().toISOString() })));
    await whenAuthObserversIdle();
    expect(item.get('role')).toBe('editor');

    // Promoted by the founder: the cache follows what the observer accepted.
    doc.getMap('members').set(SELF, yMapFromObject(await founder.sign({ publicKey: SELF, role: 'owner', name: 'This device', memberUpdatedAt: new Date(Date.now() + 1000).toISOString() })));
    await whenAuthObserversIdle();
    expect(item.get('role')).toBe('owner');

    // A role somebody merely WROTE into the doc is reverted and never reaches the cache.
    (doc.getMap('members').get(SELF) as Y.Map<unknown>).set('role', 'viewer');
    await whenAuthObserversIdle();
    expect(item.get('role')).toBe('owner');
  }, 20_000);

  it('watches owned dapps and ones whose role is not recorded yet, nothing else', () => {
    const entry = (fields: Record<string, string>) => ({ get: (key: string) => fields[key] });
    expect(watchedAtStartup(entry({ id: 'a', roomId: 'r', role: 'owner' }))).toBe(true);
    expect(watchedAtStartup(entry({ id: 'a', roomId: 'r' }))).toBe(true); // from an earlier build: opened once, then recorded
    expect(watchedAtStartup(entry({ id: 'a', roomId: 'r', role: 'editor' }))).toBe(false);
    expect(watchedAtStartup(entry({ id: 'a', roomId: 'r', role: 'viewer' }))).toBe(false);
    expect(watchedAtStartup(entry({ id: 'a', role: 'owner' }))).toBe(false); // still waiting for approval
  });
});
