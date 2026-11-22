import * as Y from 'yjs';

/**
 * Shared lifecycle core for Yjs room managers (channel rooms, relationship
 * pairing rooms). Subclasses supply descriptor typing, capability comparison,
 * awareness payloads, and their own error-message wording; the base owns the
 * state machine: persistence-only open → lazy provider connect → status
 * tracking → deduplicated destroy.
 *
 * Wire-level behaviors that must not drift:
 *  - Opening a room never constructs a provider; connection is explicit.
 *  - Awareness fields are relationship-scoped only — no device or global identity.
 *  - Destroying a room tears down provider, persistence, and doc exactly once,
 *   even under concurrent calls (destroying-map guard).
 */

export type RoomConnectionState = 'open' | 'connecting' | 'connected' | 'disconnected' | 'destroyed' | 'error';

export interface RoomProviderLike {
  awareness: { setLocalStateField(name: string, value: unknown): void };
  connect(): void;
  disconnect(): void;
  destroy(): void;
  on(name: 'status', listener: (event: { connected: boolean }) => void): void;
  off(name: 'status', listener: (event: { connected: boolean }) => void): void;
}

interface RoomPersistenceLike {
  whenSynced: PromiseLike<unknown>;
  destroy(): Promise<unknown> | void;
  clearData(): Promise<unknown> | void;
}

interface RoomManagerDependencies<
  TDescriptor extends { id: string },
  TProvider extends RoomProviderLike = RoomProviderLike,
  TPersistence extends RoomPersistenceLike = RoomPersistenceLike,
> {
  createDoc(): Y.Doc;
  createProvider(descriptor: Readonly<TDescriptor>, doc: Y.Doc): TProvider;
  createPersistence(persistenceKey: string, doc: Y.Doc): TPersistence;
}

export interface RoomHandleLike<TDescriptor> {
  readonly descriptor: Readonly<TDescriptor>;
  readonly doc: Y.Doc;
  readonly persistenceReady: Promise<void>;
  readonly state: RoomConnectionState;
  readonly error?: unknown;
}

interface ManagedRoom<
  TDescriptor extends { id: string },
  TContext extends object,
  TProvider extends RoomProviderLike,
  TPersistence extends RoomPersistenceLike,
> {
  descriptor: Readonly<TDescriptor>;
  context: Readonly<TContext>;
  doc: Y.Doc;
  persistence: TPersistence;
  persistenceReady: Promise<void>;
  provider: TProvider | null;
  state: RoomConnectionState;
  error?: unknown;
  listeners: Set<(handle: RoomHandleLike<TDescriptor>) => void>;
  statusListener: (event: { connected: boolean }) => void;
}

export abstract class RoomManagerBase<
  TDescriptor extends { id: string; persistenceKey: string },
  TContext extends object = Record<never, never>,
  TProvider extends RoomProviderLike = RoomProviderLike,
  TPersistence extends RoomPersistenceLike = RoomPersistenceLike,
> {
  private readonly rooms = new Map<string, ManagedRoom<TDescriptor, TContext, TProvider, TPersistence>>();
  private readonly destroying = new Map<string, Promise<void>>();
  protected readonly dependencies: RoomManagerDependencies<TDescriptor, TProvider, TPersistence>;

  constructor(dependencies: RoomManagerDependencies<TDescriptor, TProvider, TPersistence>) {
    this.dependencies = dependencies;
  }

  // ── subclass hooks ──

  /** Whether two descriptors denote the same underlying room capability. */
  protected abstract matchesCapabilities(
    existing: Readonly<TDescriptor>,
    incoming: Readonly<TDescriptor>,
  ): boolean;

  /** Error thrown when open() would replace credentials of an existing room. */
  protected abstract credentialMismatchError(): Error;

  /** Error thrown when addressing an id that has no room. */
  protected abstract unknownRoomError(): Error;

  /**
   * Relationship-scoped awareness payload to publish on connect, or null to
   * publish nothing (e.g. lobbies).
   */
  protected abstract buildAwareness(
    room: { descriptor: Readonly<TDescriptor>; context: Readonly<TContext> },
  ): Record<string, unknown> | null;

  // ── lifecycle ──

  /**
   * Registers a room (persistence-only, no provider). Throws when the room
   * exists with different credentials or while its persistence is being
   * destroyed by a prior destroy({clearPersistence}).
   */
  protected registerRoom(descriptor: TDescriptor, context: TContext): RoomHandleLike<TDescriptor> {
    if (this.destroying.has(descriptor.id)) {
      throw new Error('room manager: Room persistence is being destroyed');
    }
    const existing = this.rooms.get(descriptor.id);
    if (existing) {
      if (!this.matchesCapabilities(existing.descriptor, descriptor)) {
        throw this.credentialMismatchError();
      }
      return this.handleOf(existing);
    }

    const doc = this.dependencies.createDoc();
    const persistence = this.dependencies.createPersistence(descriptor.persistenceKey, doc);
    const room = {} as ManagedRoom<TDescriptor, TContext, TProvider, TPersistence>;
    room.descriptor = Object.freeze({ ...descriptor });
    room.context = Object.freeze({ ...context });
    room.doc = doc;
    room.persistence = persistence;
    room.persistenceReady = Promise.resolve(persistence.whenSynced).then(() => undefined);
    room.provider = null;
    room.state = 'open';
    room.listeners = new Set();
    room.statusListener = (event) => {
      room.state = event.connected ? 'connected' : 'disconnected';
      this.emitRoom(room);
    };
    this.rooms.set(descriptor.id, room);
    return this.handleOf(room);
  }

  getRoom(id: string): RoomHandleLike<TDescriptor> | null {
    const room = this.rooms.get(id);
    return room ? this.handleOf(room) : null;
  }

  /**
   * Lazily creates and connects the provider. Callers are expected to run
   * their domain-specific preconditions (revocation checks etc.) first.
   */
  protected connectRoom(id: string): RoomHandleLike<TDescriptor> {
    const room = this.requireRoom(id);
    if (room.state === 'connected' || room.state === 'connecting') return this.handleOf(room);

    try {
      if (!room.provider) {
        room.provider = this.dependencies.createProvider(room.descriptor, room.doc);
        const awareness = this.buildAwareness(room);
        if (awareness) room.provider.awareness.setLocalStateField('relationship', awareness);
        room.provider.on('status', room.statusListener);
      }
      room.state = 'connecting';
      room.error = undefined;
      this.emitRoom(room);
      room.provider.connect();
      return this.handleOf(room);
    } catch (error) {
      room.state = 'error';
      room.error = error;
      this.emitRoom(room);
      throw error;
    }
  }

  protected disconnectRoom(id: string): RoomHandleLike<TDescriptor> {
    const room = this.requireRoom(id);
    room.provider?.disconnect();
    if (room.state !== 'destroyed') room.state = 'disconnected';
    this.emitRoom(room);
    return this.handleOf(room);
  }

  subscribeRoom(id: string, listener: (handle: RoomHandleLike<TDescriptor>) => void): () => void {
    const room = this.requireRoom(id);
    room.listeners.add(listener);
    listener(this.handleOf(room));
    return () => room.listeners.delete(listener);
  }

  async destroyRoom(id: string, options: { clearPersistence?: boolean } = {}): Promise<void> {
    const ongoing = this.destroying.get(id);
    if (ongoing) return ongoing;
    const room = this.rooms.get(id);
    if (!room) return;
    return this.trackDestroy(id, (async () => {
      this.rooms.delete(id);
      if (room.provider) {
        room.provider.off('status', room.statusListener);
        room.provider.disconnect();
        room.provider.destroy();
        room.provider = null;
      }
      if (options.clearPersistence) await room.persistence.clearData();
      else await room.persistence.destroy();
      room.doc.destroy();
      room.state = 'destroyed';
      this.emitRoom(room);
      room.listeners.clear();
    })());
  }

  /**
   * Clears a persisted room even after restart, when no in-memory room handle
   * exists. Refuses mismatched credentials for an open room.
   */
  async destroyDescriptorRoom(descriptor: Readonly<TDescriptor>): Promise<void> {
    const openRoom = this.rooms.get(descriptor.id);
    if (openRoom) {
      if (!this.matchesCapabilities(openRoom.descriptor, descriptor)) {
        throw this.credentialMismatchError();
      }
      await this.destroyRoom(descriptor.id, { clearPersistence: true });
      return;
    }
    const ongoing = this.destroying.get(descriptor.id);
    if (ongoing) return ongoing;
    return this.trackDestroy(descriptor.id, (async () => {
      const doc = this.dependencies.createDoc();
      const persistence = this.dependencies.createPersistence(descriptor.persistenceKey, doc);
      try {
        await Promise.resolve(persistence.whenSynced);
        await persistence.clearData();
      } finally {
        doc.destroy();
      }
    })());
  }

  /** Registers `operation` as the single in-flight destroy for `id` so concurrent callers share it. */
  private trackDestroy(id: string, operation: Promise<void>): Promise<void> {
    this.destroying.set(id, operation);
    return operation.finally(() => {
      if (this.destroying.get(id) === operation) this.destroying.delete(id);
    });
  }

  // ── plumbing for subclasses ──

  /** Ids of all currently open rooms. */
  protected openRoomIds(): string[] {
    return Array.from(this.rooms.keys());
  }

  /** Ids of currently open rooms whose descriptor satisfies the predicate. */
  protected roomIdsWhere(
    predicate: (descriptor: Readonly<TDescriptor>) => boolean,
  ): string[] {
    return Array.from(this.rooms.values())
      .filter((room) => predicate(room.descriptor))
      .map((room) => room.descriptor.id);
  }

  /** Persistence adapter of an open room, for domain-specific maintenance (e.g. compaction). */
  protected getPersistence(id: string): TPersistence | null {
    return this.rooms.get(id)?.persistence ?? null;
  }

  protected requireRoom(id: string): ManagedRoom<TDescriptor, TContext, TProvider, TPersistence> {
    const room = this.rooms.get(id);
    if (!room) throw this.unknownRoomError();
    return room;
  }

  protected handleOf(room: ManagedRoom<TDescriptor, TContext, TProvider, TPersistence>): RoomHandleLike<TDescriptor> {
    return {
      descriptor: room.descriptor,
      doc: room.doc,
      persistenceReady: room.persistenceReady,
      state: room.state,
      error: room.error,
    };
  }

  private emitRoom(room: ManagedRoom<TDescriptor, TContext, TProvider, TPersistence>): void {
    const handle = this.handleOf(room);
    room.listeners.forEach((listener) => listener(handle));
  }
}
