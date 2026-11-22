import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';

/**
 * The auth observer used to re-stringify and re-hash EVERY record of a dapp on
 * every change batch. Compact records are immutable values that Yjs hands out
 * by reference, so a record that did not change must cost nothing — while a
 * record that did change must still be verified.
 */

const docs = new Map<string, Y.Doc>();

vi.mock('../services/store/docs.ts', () => ({
  getDappDoc: (dappId: string) => {
    let doc = docs.get(dappId);
    if (!doc) {
      doc = new Y.Doc();
      docs.set(dappId, doc);
    }
    return doc;
  },
}));
vi.mock('../services/store/rotation.ts', () => ({ rotateDappCredentials: vi.fn() }));

const { setupAuthObserver } = await import('../services/store/auth.ts');
const { signWithIdentity, yMapFromObject } = await import('../services/store/protocolCore.ts');
const { getDappDoc } = await import('../services/store/docs.ts');

interface TestIdentity { publicKey: string; privateKey: string }

async function createTestIdentity(): Promise<TestIdentity> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  return {
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: bufferToHex(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  };
}

const RECORDS = 40;

async function signedRecord(author: TestIdentity, id: string, title: string): Promise<Record<string, unknown>> {
  const payload = { id, title, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  return { ...payload, ...(await signWithIdentity(author, payload)) };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

let owner: TestIdentity;
let outsider: TestIdentity;

beforeEach(async () => {
  docs.clear();
  owner = await createTestIdentity();
  outsider = await createTestIdentity();
});

describe('auth observer scan cost', () => {
  it('hashes nothing again when an unrelated part of the doc changes', async () => {
    const doc = getDappDoc('scan-cost');
    doc.getMap('members').set(owner.publicKey, yMapFromObject({ publicKey: owner.publicKey, role: 'owner', name: 'Owner' }));
    const items = new Y.Map<unknown>();
    doc.getMap('data').set('items', items);
    for (let index = 0; index < RECORDS; index++) items.set(`r${index}`, await signedRecord(owner, `r${index}`, `note ${index}`));

    setupAuthObserver('scan-cost', { scanDebounceMs: 10 });
    doc.getMap('appData').set('ping', '1');
    await settle(); // first scan: every record is hashed and verified once
    expect(items.size).toBe(RECORDS);

    const digest = vi.spyOn(crypto.subtle, 'digest');
    doc.getMap('appData').set('ping', '2');
    await settle();
    expect(digest).toHaveBeenCalledTimes(0);

    // One record changes → exactly that one is hashed (and verified) again.
    items.set('r3', await signedRecord(owner, 'r3', 'edited'));
    await settle();
    expect(digest.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(digest.mock.calls.length).toBeLessThan(RECORDS);
    digest.mockRestore();
  });

  it('still reverts a record that was replaced by a forged one', async () => {
    const doc = getDappDoc('scan-forgery');
    doc.getMap('members').set(owner.publicKey, yMapFromObject({ publicKey: owner.publicKey, role: 'owner', name: 'Owner' }));
    const items = new Y.Map<unknown>();
    doc.getMap('data').set('items', items);
    items.set('r1', await signedRecord(owner, 'r1', 'genuine'));

    setupAuthObserver('scan-forgery', { scanDebounceMs: 10 });
    doc.getMap('appData').set('ping', '1');
    await settle();

    // A non-member overwrites the record: a new value object, so the cache cannot hide it.
    items.set('r1', await signedRecord(outsider, 'r1', 'forged'));
    await settle();
    await settle();
    expect((items.get('r1') as Record<string, unknown> | undefined)?.title).toBe('genuine');
  });
});
