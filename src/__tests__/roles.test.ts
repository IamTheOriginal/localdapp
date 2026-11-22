import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';

const docs = new Map<string, Y.Doc>();
let selfIdentity: { displayName: string; publicKey: string; privateKey: string; deviceId: string };
let manifestYaml = '';

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

// Roles are resolved against the owner-sealed manifest (sourceSeal.ts).
vi.mock('../services/store/sourceSeal.ts', () => ({ getRunnableCodeAppFile: () => manifestYaml }));
vi.mock('../services/store/source.ts', () => ({
  getCodeAppFile: () => manifestYaml,
}));

vi.mock('../services/identity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/identity.ts')>();
  return {
    ...actual,
    getIdentity: () => selfIdentity,
    getSigningIdentity: () => Promise.resolve(selfIdentity),
  };
});

const { assignAppRole, clearAppRole, getAppRole, listAppRoleAssignments } = await import('../services/store/roles.ts');
const { getDappDoc } = await import('../services/store/docs.ts');

async function generateIdentity(): Promise<{ displayName: string; publicKey: string; privateKey: string; deviceId: string }> {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  const publicKey = bufferToHex(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const privateKey = bufferToHex(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  return { displayName: 'Self', publicKey, privateKey, deviceId: 'self-device' };
}

function addMember(doc: Y.Doc, publicKey: string, role: 'owner' | 'editor' | 'viewer', name = '') {
  const members = doc.getMap('members');
  const member = new Y.Map<unknown>();
  member.set('publicKey', publicKey);
  member.set('role', role);
  member.set('name', name);
  members.set(publicKey, member);
  return member;
}

const defaultManifest = JSON.stringify({
  routes: [{ path: '/', label: 'Home' }],
  roles: [
    { id: 'player', label: 'Player', extends: 'editor' },
    { id: 'spectator', label: 'Spectator', extends: 'viewer' },
  ],
});

describe('app role assignment store', () => {
  beforeEach(async () => {
    docs.clear();
    manifestYaml = defaultManifest;
    selfIdentity = await generateIdentity();
  });

  it('rejects a non-owner assigning a role', async () => {
    const dappId = 'dapp-non-owner';
    const doc = getDappDoc(dappId);
    addMember(doc, selfIdentity.publicKey, 'editor');

    await expect(assignAppRole(dappId, selfIdentity.publicKey, 'player')).rejects.toThrow(/owner/i);
  });

  it('resolves an assigned role against the current manifest', async () => {
    const dappId = 'dapp-resolve';
    const doc = getDappDoc(dappId);
    addMember(doc, selfIdentity.publicKey, 'owner');
    const targetPublicKey = 'bb'.repeat(32);
    addMember(doc, targetPublicKey, 'editor');

    await assignAppRole(dappId, targetPublicKey, 'player');

    expect(getAppRole(dappId, targetPublicKey)).toEqual({ roleId: 'player', extends: 'editor' });
  });

  it('resolves to null when the assigned role no longer exists in the manifest', async () => {
    const dappId = 'dapp-removed-role';
    const doc = getDappDoc(dappId);
    addMember(doc, selfIdentity.publicKey, 'owner');
    const targetPublicKey = 'cc'.repeat(32);
    addMember(doc, targetPublicKey, 'editor');

    await assignAppRole(dappId, targetPublicKey, 'player');
    manifestYaml = JSON.stringify({ routes: [{ path: '/', label: 'Home' }], roles: [{ id: 'spectator', label: 'Spectator', extends: 'viewer' }] });

    expect(getAppRole(dappId, targetPublicKey)).toBeNull();
  });

  it('resolves to null after clearAppRole', async () => {
    const dappId = 'dapp-clear';
    const doc = getDappDoc(dappId);
    addMember(doc, selfIdentity.publicKey, 'owner');
    const targetPublicKey = 'dd'.repeat(32);
    addMember(doc, targetPublicKey, 'editor');

    await assignAppRole(dappId, targetPublicKey, 'player');
    expect(getAppRole(dappId, targetPublicKey)).not.toBeNull();

    await clearAppRole(dappId, targetPublicKey);
    expect(getAppRole(dappId, targetPublicKey)).toBeNull();
  });

  it('rejects a non-owner clearing a role', async () => {
    const dappId = 'dapp-clear-non-owner';
    const doc = getDappDoc(dappId);
    addMember(doc, selfIdentity.publicKey, 'viewer');

    await expect(clearAppRole(dappId, selfIdentity.publicKey)).rejects.toThrow(/owner/i);
  });

  it('lists every member with their current app role id, defaulting to null', async () => {
    const dappId = 'dapp-list';
    const doc = getDappDoc(dappId);
    addMember(doc, selfIdentity.publicKey, 'owner', 'Owner');
    const targetPublicKey = 'ee'.repeat(32);
    addMember(doc, targetPublicKey, 'editor', 'Target');
    await assignAppRole(dappId, targetPublicKey, 'player');

    expect(listAppRoleAssignments(dappId)).toEqual(expect.arrayContaining([
      { member: { publicKey: selfIdentity.publicKey, name: 'Owner', role: 'owner' }, roleId: null },
      { member: { publicKey: targetPublicKey, name: 'Target', role: 'editor' }, roleId: 'player' },
    ]));
  });
});
