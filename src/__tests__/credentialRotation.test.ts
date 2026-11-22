import { must } from './helpers/must.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex, hexToBuffer } from '../lib/hex.ts';

// ───── Test doubles ─────

const docs = new Map<string, Y.Doc>();
const catalogs = new Map<string, { roomId: string; roomPassword: string; epoch: number }>();
const reconnects: string[] = [];

vi.mock('../services/store/docs.ts', () => ({
  getDappDoc: (dappId: string) => {
    let doc = docs.get(dappId);
    if (!doc) {
      doc = new Y.Doc();
      docs.set(dappId, doc);
    }
    return doc;
  },
  generateRoomPassword: () => {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    return bufferToHex(arr.buffer);
  },
  getDappCredentials: (dappId: string) => catalogs.get(dappId) ?? { roomId: '', roomPassword: '', epoch: 0 },
  updateDappCredentials: (dappId: string, roomId: string, roomPassword: string, epoch: number) => {
    if (!catalogs.has(dappId)) return false;
    catalogs.set(dappId, { roomId, roomPassword, epoch });
    return true;
  },
  reconnectDappProviders: (dappId: string) => {
    reconnects.push(dappId);
  },
}));

interface TestIdentity {
  publicKey: string;
  displayName: string;
  encPublicKey: string;
  signPrivateHex: string;
  rsaPrivateKey: CryptoKey;
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
      encPublicKey: currentIdentity.encPublicKey,
    }),
    getSigningIdentity: () => Promise.resolve({
      publicKey: currentIdentity.publicKey,
      privateKey: currentIdentity.signPrivateHex,
    }),
    decryptMessage: async (encryptedHex: string) => {
      const decrypted = await crypto.subtle.decrypt(
        { name: 'RSA-OAEP' },
        currentIdentity.rsaPrivateKey,
        hexToBuffer(encryptedHex),
      );
      return new TextDecoder().decode(decrypted);
    },
  };
});

const { rotateDappCredentials, applyPendingRekey } = await import('../services/store/rotation.ts');
const { removeMember } = await import('../services/store/members.ts');
const { getDappDoc } = await import('../services/store/docs.ts');
const { encryptMessage } = await import('../services/identity.ts');
const { writeSignedRekeyEntry, rekeyEntryKey, signWithIdentity } = await import('../services/store/protocolCore.ts');

async function createTestIdentity(name: string): Promise<TestIdentity> {
  const signPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' } as EcKeyGenParams,
    true,
    ['sign', 'verify'],
  );
  const rsaPair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );
  return {
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', signPair.publicKey)),
    displayName: name,
    encPublicKey: JSON.stringify(await crypto.subtle.exportKey('jwk', rsaPair.publicKey)),
    signPrivateHex: bufferToHex(await crypto.subtle.exportKey('pkcs8', signPair.privateKey)),
    rsaPrivateKey: rsaPair.privateKey,
  };
}

function addMember(doc: Y.Doc, identity: TestIdentity, role: 'owner' | 'editor' | 'viewer', withEncKey = true) {
  const members = doc.getMap('members');
  const member = new Y.Map<unknown>();
  member.set('publicKey', identity.publicKey);
  member.set('name', identity.displayName);
  member.set('role', role);
  if (withEncKey) member.set('encPublicKey', identity.encPublicKey);
  members.set(identity.publicKey, member);
}

const DAPP_ID = 'dapp-under-test';
const OLD_CREDENTIALS = { roomId: 'dapp-room-old', roomPassword: 'old-password', epoch: 0 };

let owner: TestIdentity;
let memberB: TestIdentity;
let memberC: TestIdentity;
let memberNoEnc: TestIdentity;

beforeEach(async () => {
  docs.clear();
  catalogs.clear();
  reconnects.length = 0;
  catalogs.set(DAPP_ID, { ...OLD_CREDENTIALS });

  owner = await createTestIdentity('Owner');
  memberB = await createTestIdentity('Member B');
  memberC = await createTestIdentity('Member C');
  memberNoEnc = await createTestIdentity('Legacy member');
  currentIdentity = owner;

  const doc = getDappDoc(DAPP_ID);
  addMember(doc, owner, 'owner');
  addMember(doc, memberB, 'editor');
  addMember(doc, memberC, 'editor');
  addMember(doc, memberNoEnc, 'editor', false);
});

describe('rotateDappCredentials (owner side)', () => {
  it('writes an encrypted, owner-signed rekey entry per remaining member and moves the catalog', async () => {
    const result = await rotateDappCredentials(DAPP_ID, {
      exclude: [memberC.publicKey],
      reconnectDelayMs: 0,
    });

    expect(result.epoch).toBe(1);
    expect(result.rekeyed.sort()).toEqual([memberB.publicKey].sort());
    expect(result.skipped).toEqual([memberNoEnc.publicKey]);

    const rekeys = getDappDoc(DAPP_ID).getMap('rekeys');
    expect(rekeys.has(rekeyEntryKey(1, memberB.publicKey))).toBe(true);
    expect(rekeys.has(rekeyEntryKey(1, memberC.publicKey))).toBe(false);
    expect(rekeys.has(rekeyEntryKey(1, owner.publicKey))).toBe(false);
    expect(rekeys.has(rekeyEntryKey(1, memberNoEnc.publicKey))).toBe(false);

    const catalog = must(catalogs.get(DAPP_ID));
    expect(catalog.epoch).toBe(1);
    expect(catalog.roomId).not.toBe(OLD_CREDENTIALS.roomId);
    expect(catalog.roomPassword).not.toBe(OLD_CREDENTIALS.roomPassword);
    expect(reconnects).toContain(DAPP_ID);
  });

  it('refuses rotation for non-owners', async () => {
    currentIdentity = memberB;
    await expect(rotateDappCredentials(DAPP_ID, { reconnectDelayMs: 0 })).rejects.toThrow(/owner/i);
  });
});

describe('applyPendingRekey (member side)', () => {
  it('decrypts its entry, verifies the owner signature, and moves to the new room', async () => {
    await rotateDappCredentials(DAPP_ID, { reconnectDelayMs: 0 });
    const newCredentials = must(catalogs.get(DAPP_ID));

    // Replay the member's perspective: old catalog, member identity.
    catalogs.set(DAPP_ID, { ...OLD_CREDENTIALS });
    reconnects.length = 0;
    currentIdentity = memberB;

    await expect(applyPendingRekey(DAPP_ID)).resolves.toBe(true);
    expect(catalogs.get(DAPP_ID)).toEqual(newCredentials);
    expect(reconnects).toContain(DAPP_ID);
  });

  it('ignores entries addressed to other members', async () => {
    await rotateDappCredentials(DAPP_ID, { exclude: [memberC.publicKey], reconnectDelayMs: 0 });
    catalogs.set(DAPP_ID, { ...OLD_CREDENTIALS });
    currentIdentity = memberC;

    await expect(applyPendingRekey(DAPP_ID)).resolves.toBe(false);
    expect(catalogs.get(DAPP_ID)).toEqual(OLD_CREDENTIALS);
  });

  it('rejects a rekey entry signed by a non-owner', async () => {
    const doc = getDappDoc(DAPP_ID);
    const payload = await encryptMessage(memberB.encPublicKey, 'dapp-room-evil:evil-password:5');
    await writeSignedRekeyEntry(
      doc,
      { epoch: 5, forKey: memberB.publicKey, payload, rotatedAt: new Date().toISOString() },
      { publicKey: memberC.publicKey, privateKey: memberC.signPrivateHex },
    );

    currentIdentity = memberB;
    await expect(applyPendingRekey(DAPP_ID)).resolves.toBe(false);
    expect(catalogs.get(DAPP_ID)).toEqual(OLD_CREDENTIALS);
  });

  it('rejects an entry with a tampered signature', async () => {
    const doc = getDappDoc(DAPP_ID);
    const payload = await encryptMessage(memberB.encPublicKey, 'dapp-room-evil:evil-password:5');
    // Signed by the owner over DIFFERENT contents, then spliced onto this entry.
    const signature = await signWithIdentity(
      { publicKey: owner.publicKey, privateKey: owner.signPrivateHex },
      { epoch: 5, forKey: memberB.publicKey, payload: 'something-else', rotatedAt: 'x' },
    );
    const entry = new Y.Map<unknown>();
    Object.entries({
      epoch: 5,
      forKey: memberB.publicKey,
      payload,
      rotatedAt: new Date().toISOString(),
      ...signature,
    }).forEach(([key, value]) => entry.set(key, value));
    doc.getMap('rekeys').set(rekeyEntryKey(5, memberB.publicKey), entry);

    currentIdentity = memberB;
    await expect(applyPendingRekey(DAPP_ID)).resolves.toBe(false);
  });

  it('rejects replayed entries at or below the local epoch', async () => {
    await rotateDappCredentials(DAPP_ID, { reconnectDelayMs: 0 });

    // Member has already reached epoch 1; the epoch-1 entry must not re-apply.
    catalogs.set(DAPP_ID, { roomId: 'dapp-room-current', roomPassword: 'current-password', epoch: 1 });
    currentIdentity = memberB;

    await expect(applyPendingRekey(DAPP_ID)).resolves.toBe(false);
    expect(must(catalogs.get(DAPP_ID)).roomId).toBe('dapp-room-current');
  });

  it('rejects an owner-signed envelope spliced onto a ciphertext from another epoch', async () => {
    const doc = getDappDoc(DAPP_ID);
    // Plaintext claims epoch 2, envelope claims (and is validly signed for) epoch 3.
    const payload = await encryptMessage(memberB.encPublicKey, 'dapp-room-x:password-x:2');
    await writeSignedRekeyEntry(
      doc,
      { epoch: 3, forKey: memberB.publicKey, payload, rotatedAt: new Date().toISOString() },
      { publicKey: owner.publicKey, privateKey: owner.signPrivateHex },
    );

    currentIdentity = memberB;
    await expect(applyPendingRekey(DAPP_ID)).resolves.toBe(false);
  });

  it('applies the highest applicable epoch when several rotations are pending', async () => {
    await rotateDappCredentials(DAPP_ID, { reconnectDelayMs: 0 });
    await rotateDappCredentials(DAPP_ID, { reconnectDelayMs: 0 });
    const latest = must(catalogs.get(DAPP_ID));
    expect(latest.epoch).toBe(2);

    catalogs.set(DAPP_ID, { ...OLD_CREDENTIALS });
    currentIdentity = memberB;

    await expect(applyPendingRekey(DAPP_ID)).resolves.toBe(true);
    expect(catalogs.get(DAPP_ID)).toEqual(latest);
  });
});

describe('removeMember', () => {
  it('by default removes the member without rotating (automatic rotation is switched off)', async () => {
    const doc = getDappDoc(DAPP_ID);
    const meta = new Y.Map<unknown>();
    meta.set('createdBy', owner.publicKey);
    doc.getMap('config').set('meta', meta);
    const epochBefore = must(catalogs.get(DAPP_ID)).epoch;

    expect(await removeMember(DAPP_ID, memberC.publicKey)).toBeNull();

    expect(doc.getMap('members').has(memberC.publicKey)).toBe(false);
    expect(doc.getMap('memberTombstones').has(memberC.publicKey)).toBe(true);
    expect(doc.getMap('rekeys').size).toBe(0);
    expect(must(catalogs.get(DAPP_ID)).epoch).toBe(epochBefore);
  });

  it('with rotation requested: writes the signed tombstone and rotates credentials, excluding the removed member', async () => {
    const doc = getDappDoc(DAPP_ID);
    const meta = new Y.Map<unknown>();
    meta.set('createdBy', owner.publicKey);
    doc.getMap('config').set('meta', meta);

    const rotation = await removeMember(DAPP_ID, memberC.publicKey, { rotateCredentials: true });

    expect(doc.getMap('members').has(memberC.publicKey)).toBe(false);
    expect(doc.getMap('memberTombstones').has(memberC.publicKey)).toBe(true);

    expect(rotation).not.toBeNull();
    expect(must(rotation).epoch).toBe(1);
    expect(must(rotation).rekeyed).toEqual([memberB.publicKey]);
    const rekeys = doc.getMap('rekeys');
    expect(rekeys.has(rekeyEntryKey(1, memberC.publicKey))).toBe(false);
    expect(must(catalogs.get(DAPP_ID)).epoch).toBe(1);
  });

  it('still removes the member when rotation cannot run, reporting null', async () => {
    const doc = getDappDoc(DAPP_ID);
    const meta = new Y.Map<unknown>();
    meta.set('createdBy', owner.publicKey);
    doc.getMap('config').set('meta', meta);
    catalogs.delete(DAPP_ID); // no local credentials → rotation must fail, removal must stand

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rotation = await removeMember(DAPP_ID, memberC.publicKey, { rotateCredentials: true });
      expect(rotation).toBeNull();
      expect(doc.getMap('memberTombstones').has(memberC.publicKey)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('forged owner role (verified members)', () => {
  it('ignores a rekey signed by a member that only CLAIMS to be owner in the doc, and refuses absurd epoch jumps', async () => {
    const { setupAuthObserver, getRole } = await import('../services/store/auth.ts');
    const doc = getDappDoc(DAPP_ID);
    const meta = new Y.Map<unknown>();
    meta.set('createdBy', owner.publicKey);
    doc.getMap('config').set('meta', meta);

    // Members the way a real dapp holds them — signed in by the owner. With a recorded founder
    // the first scan keeps only what chains back to it.
    const { writeSignedMember } = await import('../services/store/protocolCore.ts');
    for (const member of [memberB, memberC]) {
      await writeSignedMember(doc, { publicKey: member.publicKey, name: member.displayName, role: 'editor', encPublicKey: member.encPublicKey },
        { publicKey: owner.publicKey, privateKey: owner.signPrivateHex });
    }

    // Victim B's device: the observer verifies the members it loaded.
    currentIdentity = memberB;
    setupAuthObserver(DAPP_ID, { scanDebounceMs: 10 });
    doc.getMap('appData').set('ping', '1');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(getRole(DAPP_ID, memberC.publicKey)).toBe('editor');

    // Attacker C (an editor) promotes itself in the doc and, in the same breath, writes a
    // self-signed rekey for B that points at C's own room.
    const payload = await encryptMessage(memberB.encPublicKey, 'dapp-room-attacker:attacker-password:1');
    const signing = { publicKey: memberC.publicKey, privateKey: memberC.signPrivateHex };
    doc.transact(() => {
      (doc.getMap('members').get(memberC.publicKey) as Y.Map<unknown>).set('role', 'owner');
    });
    await writeSignedRekeyEntry(doc, { epoch: 1, forKey: memberB.publicKey, payload, rotatedAt: new Date().toISOString() }, signing);

    // The doc says "owner" right now — the verified members do not.
    expect((doc.getMap('members').get(memberC.publicKey) as Y.Map<unknown>).get('role')).toBe('owner');
    expect(getRole(DAPP_ID, memberC.publicKey)).toBe('editor');
    expect(await applyPendingRekey(DAPP_ID)).toBe(false);
    expect(must(catalogs.get(DAPP_ID)).roomId).toBe(OLD_CREDENTIALS.roomId);

    // A genuine owner cannot strand a device on an unreachable epoch either.
    const far = await encryptMessage(memberB.encPublicKey, 'dapp-room-far:far-password:9000000');
    await writeSignedRekeyEntry(doc, { epoch: 9_000_000, forKey: memberB.publicKey, payload: far, rotatedAt: new Date().toISOString() },
      { publicKey: owner.publicKey, privateKey: owner.signPrivateHex });
    expect(await applyPendingRekey(DAPP_ID)).toBe(false);
    expect(must(catalogs.get(DAPP_ID)).epoch).toBe(0);
  });
});
