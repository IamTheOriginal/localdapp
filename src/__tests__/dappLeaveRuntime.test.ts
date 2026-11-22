import * as Y from 'yjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SELF = 'self-key';

const state = vi.hoisted(() => ({
  doc: null as Y.Doc | null,
  persistenceLoaded: null as Promise<void> | null,
  leaveDappMembership: vi.fn(() => Promise.resolve()),
  archiveDappCatalogEntry: vi.fn(() => true),
  disconnectDappNetwork: vi.fn(),
  compactRootPersistence: vi.fn(() => Promise.resolve()),
  deleteDapp: vi.fn(() => Promise.resolve({ remotePurgeRequests: 0, remotePurgeRequestFailures: [] })),
}));

vi.mock('../services/store/docs.ts', () => ({
  getDappDoc: () => state.doc,
  getDappPersistence: () => (state.persistenceLoaded ? { whenSynced: state.persistenceLoaded } : null),
  archiveDappCatalogEntry: state.archiveDappCatalogEntry,
  disconnectDappNetwork: state.disconnectDappNetwork,
  compactRootPersistence: state.compactRootPersistence,
}));
vi.mock('../services/store/members.ts', () => ({ leaveDappMembership: state.leaveDappMembership }));
vi.mock('../services/identity.ts', () => ({ getIdentity: () => ({ publicKey: SELF }) }));
vi.mock('../services/dappDeletionRuntime.ts', () => ({ deleteDapp: state.deleteDapp }));
vi.mock('../services/blobRoomManager.ts', () => ({ destroyBlobChannel: vi.fn() }));

import { leaveDapp, resolveDappLeaveKind } from '../services/dappLeaveRuntime.ts';

function members(): Y.Map<unknown> {
  return (state.doc as Y.Doc).getMap('members');
}

describe('leaveDapp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.doc = new Y.Doc();
    state.persistenceLoaded = null;
  });

  it('a synced member signs its departure, then archives and disconnects', async () => {
    members().set(SELF, new Y.Map());
    expect(await leaveDapp('dapp-1', { flushMs: 0 })).toBe('member');
    expect(state.leaveDappMembership).toHaveBeenCalledTimes(1);
    expect(state.archiveDappCatalogEntry).toHaveBeenCalledWith('dapp-1');
    expect(state.disconnectDappNetwork).toHaveBeenCalledWith('dapp-1');
    expect(state.deleteDapp).not.toHaveBeenCalled();
  });

  it('before the first sync there is nothing to sign or archive — the dapp is removed locally', async () => {
    expect(await leaveDapp('dapp-1', { flushMs: 0 })).toBe('unsynced');
    expect(state.leaveDappMembership).not.toHaveBeenCalled();
    expect(state.archiveDappCatalogEntry).not.toHaveBeenCalled();
    expect(state.deleteDapp).toHaveBeenCalledWith('dapp-1');
  });

  it('a device an owner already removed archives its synced copy without signing', async () => {
    members().set('someone-else', new Y.Map());
    expect(await leaveDapp('dapp-1', { flushMs: 0 })).toBe('removed');
    expect(state.leaveDappMembership).not.toHaveBeenCalled();
    expect(state.deleteDapp).not.toHaveBeenCalled();
    expect(state.archiveDappCatalogEntry).toHaveBeenCalledWith('dapp-1');
  });

  it('waits for local persistence before calling a dapp unsynced', async () => {
    let finishLoading!: () => void;
    state.persistenceLoaded = new Promise<void>((resolve) => { finishLoading = resolve; });
    const kind = resolveDappLeaveKind('dapp-1');
    // The stored membership only shows up once IndexedDB has loaded.
    members().set(SELF, new Y.Map());
    finishLoading();
    expect(await kind).toBe('member');
  });
});
