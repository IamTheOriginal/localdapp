// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getDappDoc, getDappsList, isTrustedBlobPeer } from '../services/store/docs.ts';

function addCatalogEntry(dappId: string, grantedBy?: string) {
  const item = new Y.Map<string>();
  item.set('id', dappId);
  if (grantedBy) item.set('grantedBy', grantedBy);
  getDappsList().push([item]);
  return item;
}

function addMember(dappId: string, publicKey: string, role: string) {
  const member = new Y.Map<unknown>();
  member.set('publicKey', publicKey);
  member.set('role', role);
  getDappDoc(dappId).getMap('members').set(publicKey, member);
}

const OWNER = 'aa'.repeat(32);
const STRANGER = 'bb'.repeat(32);

describe('isTrustedBlobPeer', () => {
  it('bootstraps trust from the pinned granting key while members are empty', () => {
    const dappId = `trust-${crypto.randomUUID()}`;
    addCatalogEntry(dappId, OWNER);
    // Members map has not synced yet — only the pinned granting key passes.
    expect(isTrustedBlobPeer(dappId, OWNER)).toBe(true);
    expect(isTrustedBlobPeer(dappId, STRANGER)).toBe(false);
  });

  it('refuses everyone when members are empty and no key was pinned', () => {
    const dappId = `trust-${crypto.randomUUID()}`;
    addCatalogEntry(dappId);
    expect(isTrustedBlobPeer(dappId, OWNER)).toBe(false);
  });

  it('uses the members map once it exists — the pin no longer widens access', () => {
    const dappId = `trust-${crypto.randomUUID()}`;
    addCatalogEntry(dappId, STRANGER); // stale/poisoned pin must not matter any more
    addMember(dappId, OWNER, 'owner');
    expect(isTrustedBlobPeer(dappId, OWNER)).toBe(true);
    expect(isTrustedBlobPeer(dappId, STRANGER)).toBe(false);

    addMember(dappId, STRANGER, 'viewer');
    expect(isTrustedBlobPeer(dappId, STRANGER)).toBe(true);
  });
});
