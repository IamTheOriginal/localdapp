import * as Y from 'yjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  list: null as Y.Array<Y.Map<string>> | null,
  initDappDoc: vi.fn(),
  initializeCodeAppSource: vi.fn(),
  purgeDappLocalResources: vi.fn(() => Promise.resolve()),
}));

vi.mock('../services/store/docs.ts', () => ({
  getDappsList: () => state.list,
  generateRoomPassword: () => 'room-password',
  initDappDoc: state.initDappDoc,
  getDappDoc: vi.fn(),
  purgeDappLocalResources: state.purgeDappLocalResources,
}));
vi.mock('../services/store/source.ts', () => ({ initializeCodeAppSource: state.initializeCodeAppSource }));
vi.mock('../services/store/auth.ts', () => ({ requireRole: vi.fn() }));
vi.mock('../services/identity.ts', () => ({ getIdentity: () => ({ publicKey: 'owner-public-key' }) }));

import { createDapp } from '../services/store/config.ts';

function catalog(): Y.Array<Y.Map<string>> {
  if (!state.list) throw new Error('Catalog is not initialized');
  return state.list;
}

describe('createDapp atomic initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.list = new Y.Doc().getArray<Y.Map<string>>('dapps');
  });

  it('removes catalog state and schedules cleanup when dapp document initialization fails', async () => {
    state.initDappDoc.mockImplementationOnce(() => { throw new Error('doc failed'); });

    expect(() => createDapp('Broken', 'X', '#000000')).toThrow('doc failed');
    await Promise.resolve();

    expect(catalog().length).toBe(0);
    expect(state.initializeCodeAppSource).not.toHaveBeenCalled();
    expect(state.purgeDappLocalResources).toHaveBeenCalledTimes(1);
  });

  it('removes catalog state and schedules cleanup when default source initialization fails', async () => {
    state.initializeCodeAppSource.mockImplementationOnce(() => { throw new Error('source failed'); });

    expect(() => createDapp('Broken', 'X', '#000000')).toThrow('source failed');
    await Promise.resolve();

    expect(catalog().length).toBe(0);
    expect(state.initDappDoc).toHaveBeenCalledTimes(1);
    expect(state.purgeDappLocalResources).toHaveBeenCalledTimes(1);
  });
});
