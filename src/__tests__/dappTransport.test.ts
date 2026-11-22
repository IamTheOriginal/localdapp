import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

/**
 * The whitelist only holds if a dapp's documents have exactly one way out: the
 * member mesh. These tests pin that docs.ts never opens a y-webrtc room for
 * the data or source document (y-webrtc hands the whole doc to anyone holding
 * the room password) and that opening a dapp with credentials starts the mesh.
 */

const state = vi.hoisted(() => ({
  rooms: [] as string[],
  ensured: [] as string[],
}));

vi.mock('y-webrtc', () => ({
  WebrtcProvider: class {
    awareness = { setLocalStateField: vi.fn(), setLocalState: vi.fn(), getLocalState: () => null, getStates: () => new Map(), on: vi.fn(), off: vi.fn() };
    constructor(roomId: string) { state.rooms.push(roomId); }
    on(): void { /* noop */ }
    destroy(): void { /* noop */ }
  },
}));
vi.mock('../services/blobRoomManager.ts', () => ({
  ensureBlobChannel: (dappId: string) => {
    state.ensured.push(dappId);
    return Promise.resolve(true);
  },
  destroyBlobChannel: vi.fn(),
}));
vi.mock('../services/signalingConfig.ts', () => ({
  signalingEndpoints: () => ['ws://broker.test'],
  webrtcPeerOpts: () => undefined,
}));
vi.mock('../services/identity.ts', () => ({
  getIdentity: () => ({ publicKey: 'aa'.repeat(32), displayName: 'Me', encPublicKey: '{}', deviceId: 'd' }),
  // Never resolves: this suite is about which rooms get opened, not about the (signed) announce.
  getSigningIdentity: vi.fn(() => new Promise(() => undefined)),
}));

const {
  getDappDoc, getDappSourceDoc, getDappsList, initDappDoc, reconnectDappProviders, disconnectDappNetwork, setMeshAutoConnect,
} = await import('../services/store/docs.ts');

function addCatalogEntry(fields: Record<string, string>): void {
  const item = new Y.Map<string>();
  Object.entries(fields).forEach(([key, value]) => item.set(key, value));
  getDappsList().push([item]);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('dapp document transport', () => {
  beforeEach(() => {
    state.rooms.length = 0;
    state.ensured.length = 0;
    setMeshAutoConnect(true);
  });

  it('opens no y-webrtc room for the data or source document and starts the member mesh once', async () => {
    addCatalogEntry({ id: 'member-dapp', roomId: 'dapp-room-1', roomPassword: 'pw', joinMethod: 'lobby' });

    getDappDoc('member-dapp');
    getDappDoc('member-dapp');
    getDappSourceDoc('member-dapp');
    await settle();

    expect(state.rooms).toEqual([]);
    expect(state.ensured).toEqual(['member-dapp']);
  });

  it('asks the mesh again after the transport was torn down or the credentials rotated', async () => {
    addCatalogEntry({ id: 'rotating-dapp', roomId: 'dapp-room-2', roomPassword: 'pw', joinMethod: 'lobby' });
    getDappDoc('rotating-dapp');
    await settle();

    reconnectDappProviders('rotating-dapp');
    await settle();
    expect(state.ensured).toEqual(['rotating-dapp', 'rotating-dapp']);

    disconnectDappNetwork('rotating-dapp');
    getDappDoc('rotating-dapp');
    await settle();
    expect(state.ensured).toHaveLength(3);
  });

  it('a device still waiting for approval joins only the lobby room — no mesh, no data room', async () => {
    addCatalogEntry({ id: 'waiting-dapp', lobbyId: 'lobby-room-9', lobbyPassword: 'lpw', joinMethod: 'lobby' });

    getDappDoc('waiting-dapp');
    await settle();

    expect(state.rooms).toEqual(['lobby-room-9']);
    expect(state.ensured).toEqual([]);
  });

  it('leaves mesh start-up to the runtime when auto-connect is off (headless keeper)', async () => {
    setMeshAutoConnect(false);
    addCatalogEntry({ id: 'keeper-dapp', roomId: 'dapp-room-3', roomPassword: 'pw', joinMethod: 'lobby' });

    getDappDoc('keeper-dapp');
    await settle();

    expect(state.ensured).toEqual([]);
  });
});

describe('founder entry of a new dapp', () => {
  const founderEntry = (dappId: string) => (getDappDoc(dappId).getMap('members').get('ff'.repeat(32)) as Y.Map<unknown>).toJSON();

  it('carries the creating device name, so member lists never show an anonymous "Owner"', () => {
    initDappDoc('named-founder', 'Recipes', 'R', '#fff', 'ff'.repeat(32), 'enc-key', '  Kitchen tablet ');
    expect(founderEntry('named-founder')).toMatchObject({ name: 'Kitchen tablet', role: 'owner', encPublicKey: 'enc-key' });
  });

  it('falls back to the placeholder for a device without a name', () => {
    initDappDoc('nameless-founder', 'Recipes', 'R', '#fff', 'ff'.repeat(32), 'enc-key');
    expect(founderEntry('nameless-founder').name).toBe('Owner');
  });
});

describe('mesh lifecycle ownership', () => {
  it('no page, component or hook tears the member mesh down — it is the dapp’s only sync transport', async () => {
    // Regression: FilesPage closed "its" blob channel on unmount. Once that channel became the
    // live-sync mesh, leaving the Files page took the whole dapp offline until it was reopened.
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const path = await import('node:path');
    const roots = ['src/pages', 'src/components', 'src/hooks'];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && /\bdestroyBlobChannel\b/.test(readFileSync(full, 'utf8'))) offenders.push(full);
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});
