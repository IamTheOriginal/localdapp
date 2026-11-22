import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';

// ───── Test doubles (credentialRotation.test.ts pattern) ─────

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

const rotateDappCredentials = vi.fn<(dappId: string, options?: unknown) => Promise<unknown>>(
  () => Promise.resolve({ epoch: 1, rekeyed: [], skipped: [] }),
);
// Automatic rotation is switched off in production; tests flip it per case.
const rotationPolicy = vi.hoisted(() => ({ enabled: true }));
vi.mock('../services/store/rotationPolicy.ts', () => ({
  get AUTO_ROTATE_ON_MEMBER_REMOVAL() { return rotationPolicy.enabled; },
}));
vi.mock('../services/store/rotation.ts', () => ({
  rotateDappCredentials: (dappId: string, options?: unknown): Promise<unknown> => rotateDappCredentials(dappId, options),
}));

interface TestIdentity {
  publicKey: string;
  displayName: string;
  signPrivateHex: string;
}

let currentIdentity: TestIdentity;

vi.mock('../services/identity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/identity.ts')>();
  return {
    ...actual,
    getIdentity: () => ({
      displayName: currentIdentity.displayName,
      publicKey: currentIdentity.publicKey,
      deviceId: 'test-device',
      encPublicKey: 'unused',
    }),
    getSigningIdentity: () => Promise.resolve({
      publicKey: currentIdentity.publicKey,
      privateKey: currentIdentity.signPrivateHex,
    }),
  };
});

const { leaveDappMembership } = await import('../services/store/members.ts');
const { setupAuthObserver, whenAuthObserversIdle } = await import('../services/store/auth.ts');
const { verifySignature } = await import('../services/store/protocolCore.ts');
const { writeSignedMemberRemoval, writeSignedMember } = await import('../services/store/protocolCore.ts');
const { getDappDoc } = await import('../services/store/docs.ts');

async function createTestIdentity(name: string): Promise<TestIdentity> {
  const signPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' } as EcKeyGenParams,
    true,
    ['sign', 'verify'],
  );
  return {
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', signPair.publicKey)),
    displayName: name,
    signPrivateHex: bufferToHex(await crypto.subtle.exportKey('pkcs8', signPair.privateKey)),
  };
}

function addMember(doc: Y.Doc, identity: TestIdentity, role: 'owner' | 'editor' | 'viewer') {
  const members = doc.getMap('members');
  const member = new Y.Map<unknown>();
  member.set('publicKey', identity.publicKey);
  member.set('name', identity.displayName);
  member.set('role', role);
  members.set(identity.publicKey, member);
}

/**
 * A member the way a real dapp holds one: signed in by an owner. With a recorded founder the
 * observer's first scan keeps only entries that chain back to it, so an unsigned non-founder
 * entry (fine as a fixture while the list was trusted as found) would simply be deleted.
 */
async function addSignedMember(doc: Y.Doc, identity: TestIdentity, role: 'owner' | 'editor' | 'viewer', signer: TestIdentity) {
  await writeSignedMember(doc, { publicKey: identity.publicKey, name: identity.displayName, role }, signingOf(signer));
}

function setFoundingOwner(doc: Y.Doc, publicKey: string) {
  const config = doc.getMap('config');
  const meta = new Y.Map<unknown>();
  meta.set('createdBy', publicKey);
  config.set('meta', meta);
}

function tombstoneOf(doc: Y.Doc, publicKey: string): Record<string, unknown> | null {
  const raw = doc.getMap('memberTombstones').get(publicKey) as Y.Map<unknown> | undefined;
  if (!raw) return null;
  const plain: Record<string, unknown> = {};
  raw.forEach((value, key) => { plain[key] = value; });
  return plain;
}

const signingOf = (identity: TestIdentity) => ({ publicKey: identity.publicKey, privateKey: identity.signPrivateHex });

async function waitForScan(): Promise<void> {
  // A positive signal instead of a fixed sleep: the scan has run when this returns.
  await whenAuthObserversIdle();
}

let owner: TestIdentity;
let memberB: TestIdentity;
let memberC: TestIdentity;

beforeEach(async () => {
  docs.clear();
  rotateDappCredentials.mockClear();
  owner = await createTestIdentity('Owner');
  memberB = await createTestIdentity('Member B');
  memberC = await createTestIdentity('Member C');
  currentIdentity = owner;
});

describe('leaveDappMembership', () => {
  it('writes a verifiable self-signed tombstone and removes the member entry', async () => {
    const doc = getDappDoc('leave-basic');
    setFoundingOwner(doc, owner.publicKey);
    addMember(doc, owner, 'owner');
    addMember(doc, memberB, 'editor');

    currentIdentity = memberB;
    await leaveDappMembership('leave-basic');

    expect(doc.getMap('members').has(memberB.publicKey)).toBe(false);
    const tombstone = tombstoneOf(doc, memberB.publicKey);
    expect(tombstone).not.toBeNull();
    if (!tombstone) return;
    expect(tombstone._signedBy).toBe(memberB.publicKey);
    expect(tombstone.publicKey).toBe(memberB.publicKey);
    await expect(verifySignature(tombstone, memberB.publicKey)).resolves.toBe(true);
  });

  it('refuses to let the founding owner leave', async () => {
    const doc = getDappDoc('leave-founder');
    setFoundingOwner(doc, owner.publicKey);
    addMember(doc, owner, 'owner');

    currentIdentity = owner;
    await expect(leaveDappMembership('leave-founder')).rejects.toThrow(/founding owner cannot leave/i);
    expect(doc.getMap('members').has(owner.publicKey)).toBe(true);
  });

  it('refuses when the device is not a member', async () => {
    const doc = getDappDoc('leave-nonmember');
    setFoundingOwner(doc, owner.publicKey);
    addMember(doc, owner, 'owner');

    currentIdentity = memberB;
    await expect(leaveDappMembership('leave-nonmember')).rejects.toThrow(/not a member/i);
    expect(tombstoneOf(doc, memberB.publicKey)).toBeNull();
  });
});

describe('auth observer departure enforcement', () => {
  it('accepts a self-signed departure: member stays removed, tombstone survives', async () => {
    const doc = getDappDoc('observer-accept');
    addMember(doc, owner, 'owner');
    addMember(doc, memberB, 'editor');
    setupAuthObserver('observer-accept', { scanDebounceMs: 10 });

    await writeSignedMemberRemoval(doc, memberB.publicKey, signingOf(memberB));
    await waitForScan();

    expect(doc.getMap('members').has(memberB.publicKey)).toBe(false);
    expect(tombstoneOf(doc, memberB.publicKey)).not.toBeNull();
  });

  it('reverts a removal tombstone a non-owner signed for someone else', async () => {
    const doc = getDappDoc('observer-forged');
    addMember(doc, owner, 'owner');
    addMember(doc, memberB, 'editor');
    addMember(doc, memberC, 'editor');
    setupAuthObserver('observer-forged', { scanDebounceMs: 10 });

    // Member B forges Member C's removal (signed by B, not by an owner, not by C).
    await writeSignedMemberRemoval(doc, memberC.publicKey, signingOf(memberB));
    await waitForScan();

    expect(doc.getMap('members').has(memberC.publicKey)).toBe(true);
    expect(tombstoneOf(doc, memberC.publicKey)).toBeNull();
  });

  it('reverts a self-signed departure of the founding owner', async () => {
    const doc = getDappDoc('observer-founder');
    setFoundingOwner(doc, memberB.publicKey);
    addMember(doc, owner, 'owner');
    addMember(doc, memberB, 'owner');
    setupAuthObserver('observer-founder', { scanDebounceMs: 10 });

    // Bypasses leaveDappMembership's local guard — a hostile device writing
    // the protocol format directly must still be reverted by honest peers.
    await writeSignedMemberRemoval(doc, memberB.publicKey, signingOf(memberB));
    await waitForScan();

    expect(doc.getMap('members').has(memberB.publicKey)).toBe(true);
    expect(tombstoneOf(doc, memberB.publicKey)).toBeNull();
  });
});

describe('departure credential rotation', () => {
  it('rotates on the founding owner device when a member leaves', async () => {
    const doc = getDappDoc('rotate-on-leave');
    setFoundingOwner(doc, owner.publicKey);
    addMember(doc, owner, 'owner');
    await addSignedMember(doc, memberB, 'editor', owner);
    currentIdentity = owner;
    setupAuthObserver('rotate-on-leave', { scanDebounceMs: 10 });
    await waitForScan(); // the first scan builds the verified member set

    await writeSignedMemberRemoval(doc, memberB.publicKey, signingOf(memberB));
    await vi.waitFor(() => {
      expect(rotateDappCredentials).toHaveBeenCalledTimes(1);
    }, { timeout: 1000 });
    expect(rotateDappCredentials.mock.calls[0][0]).toBe('rotate-on-leave');
  });

  it('does not rotate while automatic rotation is switched off', async () => {
    rotationPolicy.enabled = false;
    try {
      const doc = getDappDoc('no-rotate-policy-off');
      setFoundingOwner(doc, owner.publicKey);
      addMember(doc, owner, 'owner');
      await addSignedMember(doc, memberB, 'editor', owner);
      currentIdentity = owner;
      setupAuthObserver('no-rotate-policy-off', { scanDebounceMs: 10 });
      await waitForScan(); // the first scan builds the verified member set

      await writeSignedMemberRemoval(doc, memberB.publicKey, signingOf(memberB));
      await waitForScan();
      // The departure itself is still accepted — only the rotation is skipped.
      expect(doc.getMap('members').has(memberB.publicKey)).toBe(false);
      expect(rotateDappCredentials).not.toHaveBeenCalled();
    } finally {
      rotationPolicy.enabled = true;
    }
  });

  it('does not rotate on a non-founding-owner device', async () => {
    const doc = getDappDoc('no-rotate-peer');
    setFoundingOwner(doc, owner.publicKey);
    addMember(doc, owner, 'owner');
    await addSignedMember(doc, memberB, 'editor', owner);
    await addSignedMember(doc, memberC, 'editor', owner);
    currentIdentity = memberC;
    setupAuthObserver('no-rotate-peer', { scanDebounceMs: 10 });
    await waitForScan(); // the first scan builds the verified member set

    await writeSignedMemberRemoval(doc, memberB.publicKey, signingOf(memberB));
    await waitForScan();
    expect(rotateDappCredentials).not.toHaveBeenCalled();
  });

  it('does not re-rotate for tombstones already present at observer setup', async () => {
    const doc = getDappDoc('no-rotate-baseline');
    setFoundingOwner(doc, owner.publicKey);
    addMember(doc, owner, 'owner');
    await addSignedMember(doc, memberB, 'editor', owner);
    await writeSignedMemberRemoval(doc, memberB.publicKey, signingOf(memberB));

    currentIdentity = owner;
    setupAuthObserver('no-rotate-baseline', { scanDebounceMs: 10 });
    // Any unrelated update schedules a scan; the historical departure must not fire a rotation.
    doc.getMap('appData').set('ping', '1');
    await waitForScan();

    expect(rotateDappCredentials).not.toHaveBeenCalled();
  });
});
