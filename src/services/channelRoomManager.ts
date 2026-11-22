import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebrtcProvider } from 'y-webrtc';
import type { ChannelDescriptor } from '../types.ts';
import { signalingEndpoints, webrtcPeerOpts } from './signalingConfig.ts';
import { RoomManagerBase, type RoomHandleLike, type RoomProviderLike } from './roomManagerBase.ts';

interface ChannelRoomAwareness {
  relationshipPublicKey: string;
  channelPseudonym: string;
}

export type ChannelRoomProvider = RoomProviderLike;
export type ChannelRoomHandle = RoomHandleLike<ChannelDescriptor>;

interface ChannelRoomContext {
  awareness: Readonly<ChannelRoomAwareness>;
}

function sameCapability(left: Readonly<ChannelDescriptor>, right: Readonly<ChannelDescriptor>): boolean {
  return left.roomId === right.roomId
    && left.roomPassword === right.roomPassword
    && left.persistenceKey === right.persistenceKey
    && left.relationshipId === right.relationshipId
    && left.dappId === right.dappId
    && left.sensitiveShareId === right.sensitiveShareId;
}

export class ChannelRoomManager extends RoomManagerBase<ChannelDescriptor, ChannelRoomContext> {
  open(descriptor: ChannelDescriptor, awareness: ChannelRoomAwareness): ChannelRoomHandle {
    if (descriptor.status === 'revoked') throw new Error('channel rooms: Cannot open a revoked channel');
    if (!awareness.relationshipPublicKey || !awareness.channelPseudonym) {
      throw new Error('channel rooms: Relationship awareness identity is required');
    }
    return this.registerRoom(descriptor, { awareness });
  }

  get(channelId: string): ChannelRoomHandle | null {
    return this.getRoom(channelId);
  }

  connect(channelId: string): ChannelRoomHandle {
    const handle = this.getRoom(channelId);
    if (!handle) throw this.unknownRoomError();
    if (handle.state === 'destroyed') throw new Error('channel rooms: Channel has been destroyed');
    if (handle.descriptor.status === 'revoked') throw new Error('channel rooms: Channel is revoked');
    return this.connectRoom(channelId);
  }

  destroy(channelId: string, options: { clearPersistence?: boolean } = {}): Promise<void> {
    return this.destroyRoom(channelId, options);
  }

  destroyWhere(
    predicate: (descriptor: Readonly<ChannelDescriptor>) => boolean,
    options: { clearPersistence?: boolean } = {},
  ): Promise<void> {
    const ids = this.roomIdsWhere(predicate);
    return Promise.all(ids.map((id) => this.destroy(id, options))).then(() => undefined);
  }

  protected matchesCapabilities(
    existing: Readonly<ChannelDescriptor>,
    incoming: Readonly<ChannelDescriptor>,
  ): boolean {
    return sameCapability(existing, incoming);
  }

  protected credentialMismatchError(): Error {
    return new Error('channel rooms: Refusing to replace credentials for an open channel');
  }

  protected unknownRoomError(): Error {
    return new Error('channel rooms: Unknown channel');
  }

  protected buildAwareness(
    room: { context: Readonly<ChannelRoomContext> },
  ): Record<string, unknown> | null {
    const { relationshipPublicKey, channelPseudonym } = room.context.awareness;
    return {
      protocol: 'relationship-channel-awareness',
      schemaVersion: 1,
      publicKey: relationshipPublicKey,
      pseudonym: channelPseudonym,
    };
  }
}

export function createBrowserChannelRoomManager(): ChannelRoomManager {
  return new ChannelRoomManager({
    createDoc: () => new Y.Doc(),
    createPersistence: (persistenceKey, doc) => new IndexeddbPersistence(persistenceKey, doc),
    createProvider: (descriptor, doc) => {
      const provider = new WebrtcProvider(descriptor.roomId, doc, {
        password: descriptor.roomPassword,
        signaling: signalingEndpoints(),
        peerOpts: webrtcPeerOpts(),
      });
      // y-webrtc connects from its constructor. Disconnect immediately so opening a
      // room remains persistence-only until the runtime explicitly calls connect().
      provider.disconnect();
      return provider;
    },
  });
}
