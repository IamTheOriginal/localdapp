import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ChannelRoomManager, type ChannelRoomProvider } from '../services/channelRoomManager.ts';
import { createChannelDescriptor } from '../services/store/channelRegistry.ts';

function harness() {
  const providers: Array<ChannelRoomProvider & {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    fields: Map<string, unknown>;
    fire(connected: boolean): void;
  }> = [];
  const clearData = vi.fn(() => Promise.resolve());
  const destroyPersistence = vi.fn(() => Promise.resolve());
  const manager = new ChannelRoomManager({
    createDoc: () => new Y.Doc(),
    createPersistence: () => ({ whenSynced: Promise.resolve(), clearData, destroy: destroyPersistence }),
    createProvider: () => {
      const listeners = new Set<(event: { connected: boolean }) => void>();
      const fields = new Map<string, unknown>();
      const provider = {
        awareness: { setLocalStateField: (name: string, value: unknown) => fields.set(name, value) },
        connect: vi.fn(),
        disconnect: vi.fn(),
        destroy: vi.fn(),
        on: (_name: 'status', listener: (event: { connected: boolean }) => void) => listeners.add(listener),
        off: (_name: 'status', listener: (event: { connected: boolean }) => void) => listeners.delete(listener),
        fields,
        fire: (connected: boolean) => listeners.forEach((listener) => listener({ connected })),
      };
      providers.push(provider);
      return provider;
    },
  });
  return { manager, providers, clearData, destroyPersistence };
}

const awareness = { relationshipPublicKey: 'a'.repeat(64), channelPseudonym: 'training-pal' };

describe('ChannelRoomManager', () => {
  it('opens isolated docs without constructing or connecting a provider', () => {
    const { manager, providers } = harness();
    const bob = createChannelDescriptor({ relationshipId: 'bob', dappId: 'habits' });
    const carol = createChannelDescriptor({ relationshipId: 'carol', dappId: 'habits' });

    const bobRoom = manager.open(bob, awareness);
    const carolRoom = manager.open(carol, awareness);

    expect(providers).toHaveLength(0);
    expect(bobRoom.doc).not.toBe(carolRoom.doc);
    expect(bobRoom.descriptor.roomId).not.toBe(carolRoom.descriptor.roomId);
  });

  it('connects lazily using only relationship-scoped awareness', () => {
    const { manager, providers } = harness();
    const descriptor = createChannelDescriptor({ relationshipId: 'bob', dappId: 'habits' });
    manager.open(descriptor, awareness);
    manager.connect(descriptor.id);

    expect(providers).toHaveLength(1);
    expect(providers[0].connect).toHaveBeenCalledOnce();
    expect(providers[0].fields.get('relationship')).toEqual({
      protocol: 'relationship-channel-awareness',
      schemaVersion: 1,
      publicKey: awareness.relationshipPublicKey,
      pseudonym: awareness.channelPseudonym,
    });
    expect(providers[0].fields.has('deviceId')).toBe(false);
    expect(providers[0].fields.has('displayName')).toBe(false);
    providers[0].fire(true);
    expect(manager.get(descriptor.id)?.state).toBe('connected');
  });

  it('destroys only matching relationship rooms and can clear persistence', async () => {
    const { manager, providers, clearData, destroyPersistence } = harness();
    const bob = createChannelDescriptor({ relationshipId: 'bob', dappId: 'habits' });
    const carol = createChannelDescriptor({ relationshipId: 'carol', dappId: 'habits' });
    manager.open(bob, awareness);
    manager.open(carol, awareness);
    manager.connect(bob.id);
    manager.connect(carol.id);

    await manager.destroyWhere((descriptor) => descriptor.relationshipId === 'bob', { clearPersistence: true });

    expect(manager.get(bob.id)).toBeNull();
    expect(manager.get(carol.id)).not.toBeNull();
    expect(providers[0].destroy).toHaveBeenCalledOnce();
    expect(providers[1].destroy).not.toHaveBeenCalled();
    expect(clearData).toHaveBeenCalledOnce();
    expect(destroyPersistence).not.toHaveBeenCalled();
  });

  it('rejects credential replacement and revoked descriptors', () => {
    const { manager } = harness();
    const descriptor = createChannelDescriptor({ relationshipId: 'bob', dappId: 'habits' });
    manager.open(descriptor, awareness);
    expect(() => manager.open({ ...descriptor, roomPassword: 'replaced' }, awareness)).toThrow(/replace credentials/);
    expect(() => manager.open({ ...descriptor, id: 'revoked', status: 'revoked' }, awareness)).toThrow(/revoked/);
  });
});
