import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';

/**
 * The founder's member entry used to be created with the placeholder name
 * "Owner". New dapps carry the creating device's name; on existing dapps the
 * founder's own device re-signs its entry with its real name when it opens
 * the dapp — without losing the stored encryption key or tripping the auth
 * observer on other devices.
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

interface TestIdentity { publicKey: string; displayName: string; signPrivateHex: string }
let currentIdentity: TestIdentity;

vi.mock('../services/identity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/identity.ts')>();
  return {
    ...actual,
    getIdentity: () => ({ displayName: currentIdentity.displayName, publicKey: currentIdentity.publicKey, deviceId: 'test-device', encPublicKey: 'unused' }),
    getSigningIdentity: () => Promise.resolve({ publicKey: currentIdentity.publicKey, privateKey: currentIdentity.signPrivateHex }),
  };
});

const { healFounderName } = await import('../services/store/members.ts');
const { setupAuthObserver, whenAuthObserversIdle } = await import('../services/store/auth.ts');
const { writeSignedMember, verifySignature, FOUNDER_PLACEHOLDER_NAME } = await import('../services/store/protocolCore.ts');
const { getDappDoc } = await import('../services/store/docs.ts');

async function createTestIdentity(name: string): Promise<TestIdentity> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  return {
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', pair.publicKey)),
    displayName: name,
    signPrivateHex: bufferToHex(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  };
}

/** A dapp as initDappDoc used to create it: unsigned founder entry named "Owner". */
function legacyDapp(dappId: string, founder: TestIdentity, extra: Array<[TestIdentity, string]> = []): Y.Doc {
  const doc = getDappDoc(dappId);
  const meta = new Y.Map<unknown>();
  meta.set('createdBy', founder.publicKey);
  doc.getMap('config').set('meta', meta);
  const entry = new Y.Map<unknown>();
  entry.set('publicKey', founder.publicKey);
  entry.set('name', FOUNDER_PLACEHOLDER_NAME);
  entry.set('role', 'owner');
  entry.set('encPublicKey', 'founder-stored-enc');
  doc.getMap('members').set(founder.publicKey, entry);
  for (const [identity, role] of extra) {
    const member = new Y.Map<unknown>();
    member.set('publicKey', identity.publicKey);
    member.set('name', identity.displayName);
    member.set('role', role);
    doc.getMap('members').set(identity.publicKey, member);
  }
  return doc;
}

function entryOf(doc: Y.Doc, publicKey: string): Record<string, unknown> {
  return (doc.getMap('members').get(publicKey) as Y.Map<unknown>).toJSON();
}

let founder: TestIdentity;
let other: TestIdentity;

beforeEach(async () => {
  docs.clear();
  founder = await createTestIdentity('NAS Keeper');
  other = await createTestIdentity('Laptop');
  currentIdentity = founder;
});

describe('healFounderName', () => {
  it('signs the founder device name into its placeholder entry and keeps role and stored key', async () => {
    const doc = legacyDapp('heal-basic', founder);
    expect(await healFounderName('heal-basic')).toBe(true);
    const entry = entryOf(doc, founder.publicKey);
    expect(entry.name).toBe('NAS Keeper');
    expect(entry.role).toBe('owner');
    expect(entry.encPublicKey).toBe('founder-stored-enc');
    expect(await verifySignature(entry, founder.publicKey)).toBe(true);
    // Second run: already named, nothing to do.
    expect(await healFounderName('heal-basic')).toBe(false);
  });

  it('does nothing on a device that is not the founder', async () => {
    const doc = legacyDapp('heal-other', founder, [[other, 'owner']]);
    currentIdentity = other;
    expect(await healFounderName('heal-other')).toBe(false);
    expect(entryOf(doc, founder.publicKey).name).toBe(FOUNDER_PLACEHOLDER_NAME);
  });

  it('leaves a founder alone that already has a real name, or whose device has none', async () => {
    const doc = legacyDapp('heal-named', founder);
    (doc.getMap('members').get(founder.publicKey) as Y.Map<unknown>).set('name', 'Chosen name');
    expect(await healFounderName('heal-named')).toBe(false);

    legacyDapp('heal-nameless', founder);
    currentIdentity = { ...founder, displayName: '  ' };
    expect(await healFounderName('heal-nameless')).toBe(false);
  });

  it('is accepted by the auth observer on another member device', async () => {
    const doc = legacyDapp('heal-observed', founder, [[other, 'editor']]);
    currentIdentity = other;
    setupAuthObserver('heal-observed', { scanDebounceMs: 10 });
    await whenAuthObserversIdle(); // baseline captured

    currentIdentity = founder;
    expect(await healFounderName('heal-observed')).toBe(true);
    currentIdentity = other;
    // The scan the rename triggered has RUN when this returns — a fixed sleep would let
    // "not reverted" pass while the observer had not looked at the entry at all.
    await whenAuthObserversIdle();

    expect(entryOf(doc, founder.publicKey).name).toBe('NAS Keeper'); // not reverted
  });
});

describe('writeSignedMember', () => {
  it('keeps the stored encryption key when a rename or role change does not pass one', async () => {
    const doc = legacyDapp('keep-key', founder);
    const signing = { publicKey: founder.publicKey, privateKey: founder.signPrivateHex };
    await writeSignedMember(doc, { publicKey: other.publicKey, name: 'Laptop', role: 'editor', encPublicKey: 'laptop-enc' }, signing);
    await writeSignedMember(doc, { publicKey: other.publicKey, name: 'Laptop', role: 'viewer' }, signing);
    expect(entryOf(doc, other.publicKey)).toMatchObject({ role: 'viewer', encPublicKey: 'laptop-enc' });
    // An explicitly passed key still wins.
    await writeSignedMember(doc, { publicKey: other.publicKey, name: 'Laptop', role: 'viewer', encPublicKey: 'new-enc' }, signing);
    expect(entryOf(doc, other.publicKey).encPublicKey).toBe('new-enc');
  });
});
