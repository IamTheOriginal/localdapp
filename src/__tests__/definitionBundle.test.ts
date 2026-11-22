import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { DeviceIdentity } from '../types.ts';

const mocks = vi.hoisted(() => ({
  sourceDocs: new Map<string, Y.Doc>(),
  dappDocs: new Map<string, Y.Doc>(),
  identity: null as DeviceIdentity | null,
  requireRole: vi.fn(),
  createDapp: vi.fn(),
  getDappConfig: vi.fn(),
  syncManifestEntities: vi.fn(() => false),
  sealSourceNow: vi.fn(() => Promise.resolve(true)),
  scheduleSourceSeal: vi.fn(),
}));

function getOrCreateDoc(docs: Map<string, Y.Doc>, id: string): Y.Doc {
  let doc = docs.get(id);
  if (!doc) {
    doc = new Y.Doc();
    docs.set(id, doc);
  }
  return doc;
}

vi.mock('../services/identity.ts', () => ({ getIdentity: () => mocks.identity, getSigningIdentity: () => Promise.resolve(mocks.identity) }));
vi.mock('../services/store/auth.ts', () => ({ requireRole: mocks.requireRole }));
vi.mock('../services/store/sourceSeal.ts', () => ({ sealSourceNow: mocks.sealSourceNow, scheduleSourceSeal: mocks.scheduleSourceSeal }));
vi.mock('../services/store/config.ts', () => ({
  createDapp: mocks.createDapp,
  getDappConfig: mocks.getDappConfig,
  syncManifestEntities: mocks.syncManifestEntities,
  syncManifestMeta: vi.fn(() => false),
}));
vi.mock('../services/store/docs.ts', () => ({
  getDappDoc: (id: string) => getOrCreateDoc(mocks.dappDocs, id),
  getDappSourceDoc: (id: string) => getOrCreateDoc(mocks.sourceDocs, id),
  getDappPersistence: () => ({ whenSynced: Promise.resolve() }),
  getDappSourcePersistence: () => ({ whenSynced: Promise.resolve() }),
  persistNewDapp: () => Promise.resolve(true),
}));

const {
  assertDefinitionOnlyBundle,
  exportDefinitionBundle,
  importDefinitionBundle,
  replaceDefinitionBundle,
  verifyDefinitionBundle,
} = await import('../services/store/definitionBundle.ts');
const { getCodeAppFiles } = await import('../services/store/source.ts');

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function seedFile(dappId: string, path: string, content: string): void {
  const text = new Y.Text();
  text.insert(0, content);
  getOrCreateDoc(mocks.sourceDocs, dappId).getMap<Y.Text>('files').set(path, text);
}

const manifest = JSON.stringify({ name: 'Portable', routes: [{ path: '/', label: 'Home' }] });

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  mocks.identity = {
    displayName: 'Alice', deviceId: 'device-a',
    publicKey: bytesToHex(await crypto.subtle.exportKey('raw', keyPair.publicKey)),
    privateKey: bytesToHex(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)),
    encPublicKey: '{}', encPrivateKey: '{}',
  };
});

beforeEach(() => {
  mocks.sourceDocs.clear();
  mocks.dappDocs.clear();
  mocks.requireRole.mockReset();
  mocks.createDapp.mockReset();
  mocks.getDappConfig.mockReset();
  mocks.syncManifestEntities.mockReset();
  mocks.sealSourceNow.mockReset();
  mocks.sealSourceNow.mockResolvedValue(true);
  mocks.syncManifestEntities.mockReturnValue(false);
  mocks.getDappConfig.mockReturnValue({
    meta: { name: 'Portable app', icon: '🧳', color: '#7c6aff', createdAt: '2026-08-20T00:00:00.000Z' },
    schema: { entities: [] },
  });
  let imported = 0;
  mocks.createDapp.mockImplementation(() => `installed-${++imported}`);
  seedFile('source-app', 'index.html', '<main>Portable</main>');
  seedFile('source-app', 'manifest.yaml', manifest);
  seedFile('source-app', 'app.js', 'void 0;');
});

describe('signed Code App definition bundles', () => {
  it('exports only definition fields and produces a verifiable signature', async () => {
    getOrCreateDoc(mocks.dappDocs, 'source-app').getMap('data').set('private-records', new Y.Array());

    const bundle = await exportDefinitionBundle('source-app');
    const verified = await verifyDefinitionBundle(bundle);

    expect(verified.files).toEqual(getCodeAppFiles('source-app'));
    expect(Object.keys(bundle).sort()).toEqual([
      'authorPublicKey', 'color', 'createdAt', 'files', 'icon', 'manifestVersion',
      'name', 'protocol', 'schemaVersion', 'signature',
    ]);
    expect(JSON.stringify(bundle)).not.toContain('private-records');
    expect(JSON.stringify(bundle)).not.toContain('roomPassword');
    expect(mocks.requireRole).toHaveBeenCalledWith('source-app', 'owner');
  });

  it('rejects source and metadata tampering before creating an instance', async () => {
    const bundle = await exportDefinitionBundle('source-app');
    await expect(verifyDefinitionBundle({
      ...bundle,
      files: { ...bundle.files, 'app.js': 'alert("tampered")' },
    })).rejects.toThrow(/fingerprint/i);
    await expect(importDefinitionBundle({ ...bundle, name: 'Tampered name' })).rejects.toThrow(/signature/i);
    expect(mocks.createDapp).not.toHaveBeenCalled();
  });

  it('rejects unknown or instance-specific fields', async () => {
    const bundle = await exportDefinitionBundle('source-app');
    expect(() => assertDefinitionOnlyBundle({ ...bundle, roomPassword: 'secret' })).toThrow(/instance-specific/i);
    await expect(verifyDefinitionBundle({ ...bundle, data: {} })).rejects.toThrow(/instance-specific/i);
  });

  it('carries the schema only inside the signed manifest and seeds it on import', async () => {
    const entityDeclaration = [{ id: 'notes', name: 'Notes', fields: [{ id: 'body', name: 'Body', type: 'text' }] }];
    seedFile('source-app', 'manifest.yaml', JSON.stringify({
      name: 'Portable', routes: [{ path: '/', label: 'Home' }], entities: entityDeclaration,
    }));
    mocks.getDappConfig.mockReturnValue({
      meta: { name: 'Portable app', icon: '🧳', color: '#7c6aff', createdAt: '2026-08-20T00:00:00.000Z' },
      schema: { entities: entityDeclaration },
    });

    const bundle = await exportDefinitionBundle('source-app');
    expect('schema' in bundle).toBe(false);
    expect(bundle.files['manifest.yaml']).toContain('"entities"');
    // A bundle smuggling a side-channel schema field is rejected outright.
    await expect(verifyDefinitionBundle({ ...bundle, schema: { entities: entityDeclaration } }))
      .rejects.toThrow(/unsupported/i);

    mocks.syncManifestEntities.mockReturnValue(true);
    const installed = await importDefinitionBundle(bundle);
    expect(mocks.syncManifestEntities).toHaveBeenCalledWith(installed);
  });

  it('imports the same definition into independent empty source documents', async () => {
    const bundle = await exportDefinitionBundle('source-app');
    const first = await importDefinitionBundle(bundle);
    const second = await importDefinitionBundle(bundle);

    expect(first).toBe('installed-1');
    expect(second).toBe('installed-2');
    expect(mocks.createDapp).toHaveBeenNthCalledWith(1, bundle.name, bundle.icon, bundle.color);
    expect(mocks.createDapp).toHaveBeenNthCalledWith(2, bundle.name, bundle.icon, bundle.color);
    expect(getCodeAppFiles(first)).toEqual(bundle.files);
    expect(getCodeAppFiles(second)).toEqual(bundle.files);
    expect(mocks.sourceDocs.get(first)).not.toBe(mocks.sourceDocs.get(second));
    expect(getOrCreateDoc(mocks.dappDocs, first).getMap('data').size).toBe(0);
    expect(getOrCreateDoc(mocks.dappDocs, second).getMap('appData').size).toBe(0);
  });

  it('replaces only source and derived manifest metadata of an owner dapp', async () => {
    const bundle = await exportDefinitionBundle('source-app');
    seedFile('target-app', 'index.html', '<main>Old app</main>');
    seedFile('target-app', 'manifest.yaml', JSON.stringify({ routes: [{ path: '/', label: 'Old' }] }));
    const targetDoc = getOrCreateDoc(mocks.dappDocs, 'target-app');
    targetDoc.getMap('data').set('kept-records', new Y.Array());
    targetDoc.getMap('members').set('kept-members', new Y.Map());

    await replaceDefinitionBundle('target-app', bundle);

    expect(mocks.requireRole).toHaveBeenCalledWith('target-app', 'owner');
    expect(getCodeAppFiles('target-app')).toEqual(bundle.files);
    expect(targetDoc.getMap('data').has('kept-records')).toBe(true);
    expect(targetDoc.getMap('members').has('kept-members')).toBe(true);
    expect(mocks.syncManifestEntities).toHaveBeenCalledWith('target-app');
    expect(mocks.sealSourceNow).toHaveBeenCalledWith('target-app', bundle.files);
  });
});
