import * as Y from 'yjs';
import { IndexeddbPersistence, storeState } from 'y-indexeddb';
import { WebrtcProvider } from 'y-webrtc';
import type { PairingRequest, PairingResponse, RelationshipControlCapability, RelationshipInvite } from '../types.ts';
import { signalingEndpoints, webrtcPeerOpts } from './signalingConfig.ts';
import { RoomManagerBase, type RoomHandleLike, type RoomProviderLike } from './roomManagerBase.ts';

export type RelationshipPairingRoomDescriptor = Readonly<{
  id: string;
  kind: 'lobby' | 'control';
  roomId: string;
  roomPassword: string;
  persistenceKey: string;
  pairContextId: string;
}>;

export type RelationshipPairingProvider = RoomProviderLike;
export type RelationshipPairingRoomHandle = RoomHandleLike<RelationshipPairingRoomDescriptor>;

interface PairingRoomContext {
  relationshipPublicKey?: string;
}

function sameRoom(a: Readonly<RelationshipPairingRoomDescriptor>, b: Readonly<RelationshipPairingRoomDescriptor>): boolean {
  return a.kind === b.kind && a.roomId === b.roomId && a.roomPassword === b.roomPassword && a.pairContextId === b.pairContextId;
}

function controlDescriptor(capability: RelationshipControlCapability): RelationshipPairingRoomDescriptor {
  return {
    id: `control:${capability.capabilityId}`,
    kind: 'control',
    roomId: capability.roomId,
    roomPassword: capability.roomPassword,
    persistenceKey: `relationship-control-v1:${capability.capabilityId}`,
    pairContextId: capability.pairContextId,
  };
}

export class RelationshipPairingRoomManager extends RoomManagerBase<
  RelationshipPairingRoomDescriptor,
  PairingRoomContext
> {
  openLobby(invite: RelationshipInvite): RelationshipPairingRoomHandle {
    return this.registerRoom(
      {
        id: `lobby:${invite.inviteId}`,
        kind: 'lobby',
        roomId: invite.lobbyRoomId,
        roomPassword: invite.lobbyRoomPassword,
        persistenceKey: `relationship-pairing-lobby-v1:${invite.inviteId}`,
        pairContextId: invite.pairContextId,
      },
      {},
    );
  }

  openControl(capability: RelationshipControlCapability, relationshipPublicKey: string): RelationshipPairingRoomHandle {
    if (!relationshipPublicKey) throw new Error('relationship rooms: Relationship public key is required');
    return this.registerRoom(controlDescriptor(capability), { relationshipPublicKey });
  }

  /** Reopens a lobby from its persisted descriptor (e.g. the pairingLobbyIndex) after a restart. */
  openDescriptor(descriptor: RelationshipPairingRoomDescriptor): RelationshipPairingRoomHandle {
    return this.registerRoom(descriptor, {});
  }

  /** Destroys a control room and its persisted data, whether or not it is currently open. */
  destroyControl(capability: RelationshipControlCapability): Promise<void> {
    return this.destroyDescriptorRoom(controlDescriptor(capability));
  }

  get(id: string): RelationshipPairingRoomHandle | null {
    return this.getRoom(id);
  }

  connect(id: string): RelationshipPairingRoomHandle {
    const handle = this.getRoom(id);
    if (!handle) throw this.unknownRoomError();
    if (handle.state === 'connected' || handle.state === 'connecting') return handle;
    if (handle.state === 'destroyed') throw new Error('relationship rooms: Room is destroyed');
    return this.connectRoom(id);
  }

  disconnect(id: string): void {
    this.disconnectRoom(id);
  }

  async compact(id: string): Promise<void> {
    const persistence = this.getPersistence(id);
    if (persistence) await persistence.whenSynced;
    if (persistence instanceof IndexeddbPersistence) await storeState(persistence, true);
  }

  destroy(id: string, options: { clearPersistence?: boolean } = {}): Promise<void> {
    return this.destroyRoom(id, options);
  }

  /** Clears a persisted room even after restart, when no in-memory room handle exists. */
  destroyDescriptor(descriptor: RelationshipPairingRoomDescriptor): Promise<void> {
    return this.destroyDescriptorRoom(descriptor);
  }

  destroyAll(options: { clearPersistence?: boolean } = {}): Promise<void> {
    const ids = this.openRoomIds();
    return Promise.all(ids.map((id) => this.destroy(id, options))).then(() => undefined);
  }

  protected matchesCapabilities(
    existing: Readonly<RelationshipPairingRoomDescriptor>,
    incoming: Readonly<RelationshipPairingRoomDescriptor>,
  ): boolean {
    return sameRoom(existing, incoming);
  }

  protected credentialMismatchError(): Error {
    return new Error('relationship rooms: Refusing to replace room credentials');
  }

  protected unknownRoomError(): Error {
    return new Error('relationship rooms: Unknown room');
  }

  protected buildAwareness(
    room: { descriptor: Readonly<RelationshipPairingRoomDescriptor>; context: Readonly<PairingRoomContext> },
  ): Record<string, unknown> | null {
    // Lobbies deliberately publish no awareness identity. Stable control rooms expose
    // only their unlinkable relationship key, never device/global identity fields.
    if (room.descriptor.kind !== 'control' || !room.context.relationshipPublicKey) return null;
    return {
      protocol: 'relationship-control-awareness',
      schemaVersion: 1,
      publicKey: room.context.relationshipPublicKey,
    };
  }
}

export function pairingRequests(doc: Y.Doc): Y.Map<PairingRequest> { return doc.getMap<PairingRequest>('pairingRequests'); }
export function pairingResponses(doc: Y.Doc): Y.Map<PairingResponse> { return doc.getMap<PairingResponse>('pairingResponses'); }
/** Joiner-written completion receipts (requestId → ISO timestamp) telling the inviter its lobby can be released. */
export function pairingAcks(doc: Y.Doc): Y.Map<string> { return doc.getMap<string>('pairingAcks'); }

export function createBrowserRelationshipPairingRoomManager(): RelationshipPairingRoomManager {
  return new RelationshipPairingRoomManager({
    createDoc: () => new Y.Doc(),
    createPersistence: (key, doc) => new IndexeddbPersistence(key, doc),
    createProvider: (descriptor, doc) => {
      const provider = new WebrtcProvider(descriptor.roomId, doc, {
        password: descriptor.roomPassword,
        signaling: signalingEndpoints(),
        peerOpts: webrtcPeerOpts(),
      });
      provider.disconnect();
      return provider;
    },
  });
}
