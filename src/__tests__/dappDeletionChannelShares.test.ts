import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const state = vi.hoisted(() => ({
  removeChannelSharesForDapp: vi.fn(),
  removeChannelDescriptorsForDapp: vi.fn(),
}));

vi.mock('../services/browserRelationshipRuntime.ts', () => ({ queueRemoteChannelPurge: vi.fn() }));
vi.mock('../services/sharingRuntime.ts', () => ({ destroyDappRelationshipChannels: vi.fn(() => Promise.resolve()) }));
vi.mock('../services/store/config.ts', () => ({ removeDappCatalogEntry: vi.fn() }));
vi.mock('../services/store/docs.ts', () => {
  const rootDoc = new Y.Doc();
  return {
    compactRootPersistence: vi.fn(() => Promise.resolve()),
    getRootDoc: vi.fn(() => rootDoc),
    purgeDappLocalResources: vi.fn(() => Promise.resolve()),
  };
});
vi.mock('../services/store/channelRegistry.ts', () => ({
  listChannelDescriptorsForDapp: vi.fn(() => []),
  removeChannelDescriptorsForDapp: state.removeChannelDescriptorsForDapp,
}));
vi.mock('../services/store/directBindings.ts', () => ({ removeDirectBindingsForDapp: vi.fn() }));
vi.mock('../services/store/channelShares.ts', () => ({ removeChannelSharesForDapp: state.removeChannelSharesForDapp }));

import { deleteDapp } from '../services/dappDeletionRuntime.ts';

describe('dapp deletion channel lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes channel-share rows together with channel descriptors', async () => {
    await deleteDapp('deleted-demo');

    expect(state.removeChannelSharesForDapp).toHaveBeenCalledWith('deleted-demo', expect.any(Y.Doc));
    expect(state.removeChannelDescriptorsForDapp).toHaveBeenCalledWith('deleted-demo', expect.any(Y.Doc));
  });
});
