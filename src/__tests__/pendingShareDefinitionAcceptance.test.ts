import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelDescriptor, ChannelShare, CodeAppDefinitionBundle, PendingShareInvite, Relationship, RelationshipChannelShareOfferPayload } from '../types.ts';

const state = vi.hoisted(() => {
  const offerMessage = { messageId: 'offer-message', recipientPublicKey: 'recipient', sequence: 0 };
  return {
    rootDoc: {},
    controlDoc: {},
    offerMessage,
    relationship: null as Relationship | null,
    invite: null as PendingShareInvite | null,
    canonicalShare: null as ChannelShare | null,
    descriptor: null as ChannelDescriptor | null,
    payload: null as RelationshipChannelShareOfferPayload | null,
    removeChannelShare: vi.fn(),
    purgeRelationshipChannelLocal: vi.fn(() => Promise.resolve()),
    importDefinitionBundle: vi.fn(() => Promise.resolve('fresh-local-dapp')),
    inspectChannelShareOffer: vi.fn(),
    acceptChannelShareOffer: vi.fn(),
    createChannelShare: vi.fn(),
    setInviteStatus: vi.fn(),
    openRelationshipChannel: vi.fn(() => Promise.resolve({ persistenceReady: Promise.resolve() })),
    compactRootPersistence: vi.fn(() => Promise.resolve()),
    compactControl: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('../services/store/docs.ts', () => ({
  getRootDoc: () => state.rootDoc,
  getRootPersistence: () => null,
  compactRootPersistence: state.compactRootPersistence,
}));
vi.mock('../services/store/people.ts', () => ({ createPerson: vi.fn() }));
vi.mock('../services/store/relationships.ts', () => ({
  createRelationship: vi.fn(), listRelationships: vi.fn(() => []), getRelationship: () => state.relationship,
  getRelationshipControlCapability: () => ({ id: 'control', roomId: 'room', roomPassword: 'secret' }),
}));
vi.mock('../services/store/channelRegistry.ts', () => ({
  activateChannelDescriptor: vi.fn(), admitChannelDevice: vi.fn(), getChannelDescriptor: vi.fn(),
  getChannelDescriptorById: () => state.descriptor, registerChannelDescriptor: vi.fn(), revokeChannelDescriptor: vi.fn(),
}));
vi.mock('../services/store/channelShares.ts', () => ({
  createChannelShare: state.createChannelShare,
  getChannelShareById: () => state.canonicalShare, listAllChannelShares: () => state.canonicalShare ? [state.canonicalShare] : [],
  listChannelShares: vi.fn(() => []), listChannelSharesByInstance: vi.fn(() => []), removeChannelShare: state.removeChannelShare,
}));
vi.mock('../services/store/pendingShareInvites.ts', () => ({
  createPendingShareInvite: vi.fn(), findPendingShareInviteByOfferMessageId: vi.fn(),
  getPendingShareInvite: () => state.invite, listPendingShareInvites: vi.fn(() => []),
  setPendingShareInviteStatus: state.setInviteStatus,
}));
vi.mock('../services/store/source.ts', () => ({ getCodeAppFile: vi.fn(() => '') }));
vi.mock('../services/store/definitionBundle.ts', () => ({ importDefinitionBundle: state.importDefinitionBundle }));
vi.mock('../services/shareCompatibility.ts', () => ({ isShareInviteCompatible: vi.fn(() => true) }));
vi.mock('../services/relationshipIdentity.ts', () => ({ createRelationshipIdentity: vi.fn() }));
vi.mock('../services/relationshipPairingRoomManager.ts', () => ({
  createBrowserRelationshipPairingRoomManager: () => ({
    openControl: () => ({ descriptor: { id: 'control' }, doc: state.controlDoc, persistenceReady: Promise.resolve() }),
    connect: vi.fn(), compact: state.compactControl,
  }),
}));
vi.mock('../services/relationshipPairingRuntime.ts', () => ({ RelationshipPairingRuntime: class {} }));
vi.mock('../services/relationshipProtocol.ts', () => ({
  deriveRelationshipSafetyNumber: vi.fn(), hashRelationshipControl: vi.fn(),
}));
vi.mock('../services/relationshipChannelControl.ts', () => ({
  relationshipChannelMessages: () => ({
    get: (id: string) => id === state.offerMessage.messageId ? state.offerMessage : undefined,
    values: () => [], observe: vi.fn(), unobserve: vi.fn(), set: vi.fn(), delete: vi.fn(),
  }),
  inspectChannelShareOffer: state.inspectChannelShareOffer,
  acceptChannelShareOffer: state.acceptChannelShareOffer,
  declineChannelShareOffer: vi.fn(),
  getRelationshipControlOutboxMessage: vi.fn(), listRelationshipControlOutbox: vi.fn(() => []),
  markRelationshipControlOutboxPersisted: vi.fn(), receiveChannelPurgeAck: vi.fn(),
  receiveChannelPurgeRequest: vi.fn(), hashControlMessage: vi.fn(),
  receiveChannelShareOffer: vi.fn(), receiveChannelShareResponse: vi.fn(), sendChannelPurgeRequest: vi.fn(), sendChannelShareOffer: vi.fn(),
  verifyOutgoingRelationshipControlEnvelope: vi.fn(), verifyRelationshipControlEnvelope: vi.fn(),
}));
vi.mock('../services/sharingRuntime.ts', () => ({
  openRelationshipChannel: state.openRelationshipChannel,
  purgeRelationshipChannelLocal: state.purgeRelationshipChannelLocal,
}));
vi.mock('../services/store/remotePurgeQueue.ts', () => ({
  acknowledgeRemotePurge: vi.fn(), enqueueRemotePurge: vi.fn(), getProcessedRemotePurge: vi.fn(),
  listPendingRemotePurges: vi.fn(() => []), listRemotePurgeIntents: vi.fn(() => []), persistRemotePurgeIntent: vi.fn(),
  recordProcessedRemotePurge: vi.fn(), recordRemotePurgeAttempt: vi.fn(), recordRemotePurgeIntentFailure: vi.fn(),
  removeRemotePurgeIntent: vi.fn(),
}));

import {
  acceptPendingShareInvite, declinePendingShareInvite, inspectPendingShareDefinition, removeChannelShareLocally,
} from '../services/browserRelationshipRuntime.ts';

function definition(): CodeAppDefinitionBundle {
  const manifest = {
    routes: [{ path: '/', label: 'Game' }],
    bindings: { events: [{ id: 'move', label: 'Move' }], actions: [{ id: 'apply', label: 'Apply' }] },
    channels: { shares: [{ id: 'match', label: 'Match', events: ['move'], actions: ['apply'], routes: [{ eventId: 'move', actionId: 'apply' }] }] },
  };
  return {
    protocol: 'code-app-definition', schemaVersion: 1, name: 'Game', icon: '🎮', color: '#123456',
    files: { 'index.html': '<main>Game</main>', 'manifest.yaml': JSON.stringify(manifest) },
    manifestVersion: '12345678', createdAt: '2026-08-20T12:00:00.000Z',
    authorPublicKey: 'ab'.repeat(32), signature: 'cd'.repeat(64),
  };
}

describe('pending share definition acceptance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.canonicalShare = null;
    state.descriptor = null;
    state.relationship = {
      id: 'relationship', schemaVersion: 1, personId: 'person', status: 'active',
      localIdentity: { publicKey: 'recipient' } as Relationship['localIdentity'],
      peerPublicKey: 'sender', peerEncPublicKey: 'sender-enc', pairContextId: 'pair',
      createdAt: '2026-08-20T12:00:00.000Z', updatedAt: '2026-08-20T12:00:00.000Z',
    };
    const attached = definition();
    state.payload = {
      protocol: 'relationship-channel-share-offer', schemaVersion: 1, offerId: 'offer',
      dappId: 'remote-dapp', shareId: 'match', shareLabel: 'Match', instanceId: 'instance',
      dappMeta: { name: 'Game', icon: '🎮', color: '#123456' },
      events: [{ id: 'move', label: 'Move' }], actions: [{ id: 'apply', label: 'Apply' }],
      routes: [{ eventId: 'move', actionId: 'apply' }], definition: attached,
      channel: { id: 'channel', schemaVersion: 1, roomId: 'channel-room', roomPassword: 'channel-secret', memberDeviceKeys: ['sender', 'recipient'], createdAt: '2026-08-20T12:00:00.000Z' },
    };
    state.invite = {
      id: 'invite', schemaVersion: 1, relationshipId: 'relationship', dappId: 'mutable-remote',
      shareId: 'mutable-share', shareLabel: 'Mutable', instanceId: 'mutable-instance', offerId: 'offer',
      dappMeta: { name: 'Mutable', icon: '⚠️', color: '#ff0000' }, events: [], actions: [], routes: [],
      channel: state.payload.channel, offerMessageId: 'offer-message', offerMessageHash: 'signed-hash',
      receivedAt: '2026-08-20T12:00:00.000Z', status: 'pending',
    };
    state.inspectChannelShareOffer.mockResolvedValue({ payload: state.payload, messageHash: 'signed-hash' });
    const descriptor: ChannelDescriptor = {
      id: 'channel', schemaVersion: 1, relationshipId: 'relationship', dappId: 'fresh-local-dapp', sensitiveShareId: 'instance',
      roomId: 'channel-room', roomPassword: 'channel-secret', persistenceKey: 'channel', memberDeviceKeys: ['sender', 'recipient'],
      status: 'active', createdAt: '2026-08-20T12:00:00.000Z', updatedAt: '2026-08-20T12:00:00.000Z',
    };
    state.acceptChannelShareOffer.mockResolvedValue({ descriptor, ack: {} });
    state.createChannelShare.mockImplementation((input: Record<string, unknown>) => ({ id: 'share-record', ...input }));
  });

  it('previews the definition from the original signed offer and rejects a different reviewed signature', async () => {
    if (!state.invite || !state.payload?.definition) throw new Error('Missing fixture');
    state.invite.definition = { ...state.payload.definition, name: 'Mutable staged preview' };

    const reviewed = await inspectPendingShareDefinition('invite');
    expect(reviewed).toBe(state.payload.definition);
    expect(reviewed?.name).toBe('Game');
    await expect(acceptPendingShareInvite('invite', undefined, 'different-signature')).rejects.toThrow(/review the original signed/i);
    expect(state.importDefinitionBundle).not.toHaveBeenCalled();
  });

  it('installs only after explicit acceptance and binds the signed offer to the fresh local dapp', async () => {
    expect(state.importDefinitionBundle).not.toHaveBeenCalled();
    const accepted = await acceptPendingShareInvite('invite', undefined, state.payload?.definition?.signature);

    expect(state.inspectChannelShareOffer).toHaveBeenCalledWith(expect.objectContaining({ relationship: state.relationship }));
    expect(state.importDefinitionBundle).toHaveBeenCalledWith(state.payload?.definition);
    expect(state.acceptChannelShareOffer).toHaveBeenCalledWith(expect.objectContaining({
      offerPayload: state.payload, offerMessageHash: 'signed-hash', localDappId: 'fresh-local-dapp',
    }));
    expect(state.createChannelShare).toHaveBeenCalledWith(expect.objectContaining({
      dappId: 'fresh-local-dapp', shareId: 'match', instanceId: 'instance',
    }), state.rootDoc);
    expect(state.setInviteStatus).toHaveBeenCalledWith('invite', 'accepted', state.rootDoc);
    expect(accepted.share.dappId).toBe('fresh-local-dapp');
  });

  it('dismisses a stale invite locally when its relationship is already gone', async () => {
    state.relationship = null;
    await expect(declinePendingShareInvite('invite')).resolves.toBe(false);
    expect(state.setInviteStatus).toHaveBeenCalledWith('invite', 'declined', state.rootDoc);
    expect(state.compactRootPersistence).toHaveBeenCalled();
  });

  it('refuses to remove a stale row that points at another relationship channel', async () => {
    const row: ChannelShare = {
      id: 'share-stale', schemaVersion: 1, dappId: 'dapp', shareId: 'match', instanceId: 'instance',
      relationshipId: 'relationship', channelId: 'channel-other', eventIds: [], actionIds: [], status: 'pending',
      createdAt: '2026-08-20T12:00:00.000Z', updatedAt: '2026-08-20T12:00:00.000Z',
    };
    state.canonicalShare = row;
    state.descriptor = { id: 'channel-other', relationshipId: 'different-relationship' } as ChannelDescriptor;

    await expect(removeChannelShareLocally(row)).rejects.toThrow(/owned by another relationship/i);
    expect(state.purgeRelationshipChannelLocal).not.toHaveBeenCalled();
    expect(state.removeChannelShare).not.toHaveBeenCalled();
  });

  it('rejects a staged invite that no longer points to the original signed offer', async () => {
    state.inspectChannelShareOffer.mockResolvedValue({ payload: state.payload, messageHash: 'different-hash' });
    await expect(acceptPendingShareInvite('invite')).rejects.toThrow(/no longer matches/i);
    expect(state.importDefinitionBundle).not.toHaveBeenCalled();
    expect(state.acceptChannelShareOffer).not.toHaveBeenCalled();
  });
});
