import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// Factories below run lazily on first import of the mocked modules, after this
// file's top-level statements have executed — safe to reference `harness`.
const harness: { rootDoc: Y.Doc; dappDocs: Map<string, Y.Doc>; manifests: Map<string, string> } = {
  rootDoc: new Y.Doc(), dappDocs: new Map(), manifests: new Map(),
};

vi.mock('../services/store/docs.ts', () => ({
  getDappsList: () => harness.rootDoc.getArray('dapps'),
  getDappDoc: (id: string) => {
    let doc = harness.dappDocs.get(id);
    if (!doc) { doc = new Y.Doc(); harness.dappDocs.set(id, doc); }
    return doc;
  },
  generateRoomPassword: () => 'test-password',
  initDappDoc: vi.fn(),
  purgeDappLocalResources: vi.fn(() => Promise.resolve()),
}));
vi.mock('../services/store/source.ts', () => ({
  initializeCodeAppSource: vi.fn((id: string, _html: string | undefined, manifest: string) => { harness.manifests.set(id, manifest); }),
  getCodeAppFile: (id: string, path: string) => (path === 'manifest.yaml' ? harness.manifests.get(id) ?? '' : ''),
}));
vi.mock('../services/store/auth.ts', () => ({ requireRole: vi.fn() }));
vi.mock('../services/identity.ts', () => ({ getIdentity: () => ({ publicKey: 'tester', privateKey: 'k' }) }));

import { createDapp, syncManifestMeta } from '../services/store/config.ts';
import { parseCodeAppManifest } from '../services/codeAppManifest.ts';
import { getDappDoc } from '../services/store/docs.ts';

function catalogEntry(id: string): Y.Map<string> {
  return harness.rootDoc.getArray('dapps').toArray().find((item) => (item as Y.Map<string>).get('id') === id) as Y.Map<string>;
}

function installMeta(id: string, name: string, icon: string, color: string): Y.Map<string> {
  const meta = new Y.Map<string>();
  meta.set('name', name); meta.set('icon', icon); meta.set('color', color);
  getDappDoc(id).getMap('config').set('meta', meta);
  return meta;
}

describe('manifest as the home of name / icon / color', () => {
  beforeEach(() => {
    harness.rootDoc = new Y.Doc();
    harness.dappDocs.clear();
    harness.manifests.clear();
  });

  it('seeds a new dapp\'s manifest with the identity chosen at creation', () => {
    const id = createDapp('Trip: Rome #2', '🧭', '#123456');
    const parsed = parseCodeAppManifest(harness.manifests.get(id) ?? '');
    expect(parsed.error).toBeNull();
    expect(parsed.manifest.name).toBe('Trip: Rome #2'); // ':' and '#' survive YAML quoting
    expect(parsed.manifest.icon).toBe('🧭');
    expect(parsed.manifest.color).toBe('#123456');
    expect(harness.manifests.get(id)).toContain('#'); // the comments are the point
  });

  it('copies a saved manifest\'s name/icon/color into config.meta and the catalog', () => {
    const id = createDapp('Old Name', '🧩', '#333333');
    const meta = installMeta(id, 'Old Name', '🧩', '#333333');
    harness.manifests.set(id, 'name: New Name\nicon: 🚀\ncolor: "#ABCDEF"\nroutes:\n  - path: /\n    label: Home\n');

    expect(syncManifestMeta(id)).toBe(true);

    expect(meta.get('name')).toBe('New Name');
    expect(meta.get('icon')).toBe('🚀');
    expect(meta.get('color')).toBe('#abcdef');
    expect(catalogEntry(id).get('name')).toBe('New Name');
    expect(catalogEntry(id).get('icon')).toBe('🚀');
    expect(catalogEntry(id).get('color')).toBe('#abcdef');
  });

  it('leaves undeclared fields alone and touches nothing on an invalid manifest', () => {
    const id = createDapp('Keep Me', '🧩', '#333333');
    const meta = installMeta(id, 'Keep Me', '🧩', '#333333');

    harness.manifests.set(id, 'name: Only The Name\nroutes:\n  - path: /\n    label: Home\n');
    expect(syncManifestMeta(id)).toBe(true);
    expect(meta.get('name')).toBe('Only The Name');
    expect(meta.get('icon')).toBe('🧩');
    expect(catalogEntry(id).get('color')).toBe('#333333');

    harness.manifests.set(id, 'name: Broken\ncolor: not-a-color\nroutes:\n  - path: /\n    label: Home\n');
    expect(syncManifestMeta(id)).toBe(false);
    expect(meta.get('name')).toBe('Only The Name');

    harness.manifests.set(id, 'routes:\n  - path: /\n    label: Home\n');
    expect(syncManifestMeta(id)).toBe(false);
  });
});
