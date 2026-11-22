import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { must } from './helpers/must.ts';
import * as Y from 'yjs';
import type { DeviceIdentity } from '../types.ts';

/**
 * The `.dapp` file format (src/services/dappFile.ts): the signed definition
 * bundle as JSON, plus the OS file-handler registration that opens it.
 */

const mocks = vi.hoisted(() => ({
  sourceDocs: new Map<string, Y.Doc>(),
  dappDocs: new Map<string, Y.Doc>(),
  identity: null as DeviceIdentity | null,
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
vi.mock('../services/store/auth.ts', () => ({ requireRole: vi.fn() }));
vi.mock('../services/store/config.ts', () => ({
  createDapp: vi.fn(() => 'installed'),
  getDappConfig: () => ({
    meta: { name: 'Portable app', icon: '🧳', color: '#7c6aff', createdAt: '2026-08-20T00:00:00.000Z' },
    schema: { entities: [] },
  }),
  syncManifestEntities: vi.fn(() => false),
  syncManifestMeta: vi.fn(() => false),
}));
vi.mock('../services/store/docs.ts', () => ({
  getDappDoc: (id: string) => getOrCreateDoc(mocks.dappDocs, id),
  getDappSourceDoc: (id: string) => getOrCreateDoc(mocks.sourceDocs, id),
  getDappPersistence: () => ({ whenSynced: Promise.resolve() }),
  getDappSourcePersistence: () => ({ whenSynced: Promise.resolve() }),
}));

const { exportDefinitionBundle } = await import('../services/store/definitionBundle.ts');
const {
  DAPP_FILE_ACCEPT, DAPP_FILE_EXTENSION, DAPP_FILE_MAX_BYTES, DAPP_FILE_MIME,
  consumeLaunchedDappFile, dappFileName, parseDappFile, readDappFile, serializeDappFile,
} = await import('../services/dappFile.ts');

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function seedFile(dappId: string, path: string, content: string): void {
  const text = new Y.Text();
  text.insert(0, content);
  getOrCreateDoc(mocks.sourceDocs, dappId).getMap<Y.Text>('files').set(path, text);
}

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
  seedFile('source-app', 'index.html', '<main>Portable</main>');
  seedFile('source-app', 'manifest.yaml', JSON.stringify({ name: 'Portable', routes: [{ path: '/', label: 'Home' }] }));
});

describe('.dapp file format', () => {
  it('round-trips an exported definition through serialize → File → read', async () => {
    const bundle = await exportDefinitionBundle('source-app');
    const file = new File([serializeDappFile(bundle)], dappFileName(bundle.name), { type: DAPP_FILE_MIME });
    expect(file.name).toBe('portable-app.dapp');
    expect(await readDappFile(file)).toEqual(bundle);
  });

  it('rejects files that are not a signed definition bundle', async () => {
    await expect(parseDappFile('{not json')).rejects.toThrow(/invalid JSON/);
    await expect(parseDappFile(JSON.stringify({ hello: 'world' }))).rejects.toThrow(/definition bundle/);
    await expect(parseDappFile(JSON.stringify({ protocol: 'code-app-definition', schemaVersion: 1 }))).rejects.toThrow();
    const bundle = await exportDefinitionBundle('source-app');
    await expect(parseDappFile(serializeDappFile({ ...bundle, name: 'Tampered' }))).rejects.toThrow(/signature/i);
  });

  it('caps the file size before reading it', async () => {
    const huge = { size: DAPP_FILE_MAX_BYTES + 1, text: () => Promise.resolve('') } as unknown as Blob;
    await expect(readDappFile(huge)).rejects.toThrow(/limited to 12 MB/);
  });

  it('names files from the display name and always accepts the registered extension', () => {
    expect(dappFileName('  Shared Expenses!  ')).toBe('shared-expenses.dapp');
    expect(dappFileName('***')).toBe('code-app.dapp');
    expect(DAPP_FILE_ACCEPT.split(',')).toContain(DAPP_FILE_EXTENSION);
    expect(DAPP_FILE_ACCEPT.split(',')).toContain('.dapp.json'); // earlier exports keep importing
  });
});

describe('OS file handling', () => {
  it('registers .dapp with the same MIME and action route the host serves', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../public/manifest.webmanifest', import.meta.url), 'utf8')) as {
      file_handlers: Array<{ action: string; accept: Record<string, string[]> }>;
    };
    expect(manifest.file_handlers).toHaveLength(1);
    expect(manifest.file_handlers[0].action).toBe('/open-file');
    expect(manifest.file_handlers[0].accept[DAPP_FILE_MIME]).toEqual([DAPP_FILE_EXTENSION]);
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('path="/open-file"');
  });

  it('hands the first launched file to the handler and is a no-op without launchQueue', async () => {
    const launched = new File(['{}'], 'x.dapp');
    type Consumer = (params: { files?: Array<{ getFile(): Promise<File> }> }) => void;
    const consumer: { current: Consumer | null } = { current: null };
    const globalWindow = globalThis as unknown as { window?: unknown };
    const previous = globalWindow.window;
    globalWindow.window = { launchQueue: { setConsumer: (fn: Consumer) => { consumer.current = fn; } } };
    try {
      const received: File[] = [];
      consumeLaunchedDappFile((file) => received.push(file));
      must(consumer.current)({ files: [{ getFile: () => Promise.resolve(launched) }] });
      await vi.waitFor(() => expect(received).toEqual([launched]));

      globalWindow.window = {};
      expect(() => consumeLaunchedDappFile(() => undefined)).not.toThrow();
    } finally {
      globalWindow.window = previous;
    }
  });
});
