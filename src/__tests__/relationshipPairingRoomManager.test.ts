import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createRelationshipInvite } from '../services/relationshipProtocol.ts';
import {
  RelationshipPairingRoomManager, type RelationshipPairingProvider,
} from '../services/relationshipPairingRoomManager.ts';
import type { RelationshipControlCapability } from '../types.ts';

function harness() {
  const providers: Array<RelationshipPairingProvider & { fields: Map<string, unknown>; connect: ReturnType<typeof vi.fn> }> = [];
  const manager = new RelationshipPairingRoomManager({
    createDoc: () => new Y.Doc(),
    createPersistence: () => ({ whenSynced: Promise.resolve(), destroy: vi.fn(), clearData: vi.fn() }),
    createProvider: () => {
      const fields = new Map<string, unknown>(); const listeners = new Set<(event: { connected: boolean }) => void>();
      const provider = {
        fields, awareness: { setLocalStateField: (name: string, value: unknown) => fields.set(name, value) }, connect: vi.fn(),
        disconnect: vi.fn(), destroy: vi.fn(), on: (_name: 'status', listener: (event: { connected: boolean }) => void) => listeners.add(listener),
        off: (_name: 'status', listener: (event: { connected: boolean }) => void) => listeners.delete(listener),
      };
      providers.push(provider); return provider;
    },
  });
  return { manager, providers };
}

describe('RelationshipPairingRoomManager', () => {
  it('opens isolated lobby docs and creates providers only on explicit connect', async () => {
    const { manager, providers } = harness();
    const first = await createRelationshipInvite(); const second = await createRelationshipInvite();
    const one = manager.openLobby(first.invite); const two = manager.openLobby(second.invite);
    expect(one.doc).not.toBe(two.doc); expect(providers).toHaveLength(0);
    manager.connect(one.descriptor.id);
    expect(providers).toHaveLength(1); expect(providers[0].connect).toHaveBeenCalledOnce();
    expect(providers[0].fields.size).toBe(0);
    expect(() => manager.openLobby({ ...first.invite, lobbyRoomPassword: 'replacement' })).toThrow(/replace room credentials/);
  });

  it('blocks reopening a lobby until persisted deletion finishes', async () => {
    let releaseClear!: () => void;
    const clearFinished = new Promise<void>((resolve) => { releaseClear = resolve; });
    const manager = new RelationshipPairingRoomManager({
      createDoc: () => new Y.Doc(),
      createPersistence: () => ({ whenSynced: Promise.resolve(), destroy: vi.fn(), clearData: vi.fn(() => clearFinished) }),
      createProvider: () => ({
        awareness: { setLocalStateField: vi.fn() }, connect: vi.fn(), disconnect: vi.fn(), destroy: vi.fn(),
        on: vi.fn(), off: vi.fn(),
      }),
    });
    const created = await createRelationshipInvite();
    const room = manager.openLobby(created.invite);
    const destroying = manager.destroy(room.descriptor.id, { clearPersistence: true });

    expect(() => manager.openLobby(created.invite)).toThrow(/being destroyed/);
    releaseClear();
    await destroying;
    expect(manager.openLobby(created.invite).descriptor).toEqual(room.descriptor);
  });

  it('uses only relationship-scoped awareness in stable control rooms', () => {
    const { manager, providers } = harness();
    const capability: RelationshipControlCapability = { protocol: 'relationship-control-capability', schemaVersion: 1, capabilityId: 'cap',
      pairContextId: 'pair', roomId: 'room', roomPassword: 'secret', createdAt: new Date().toISOString() };
    const room = manager.openControl(capability, 'relationship-key'); manager.connect(room.descriptor.id);
    expect(providers[0].fields.get('relationship')).toEqual({ protocol: 'relationship-control-awareness', schemaVersion: 1, publicKey: 'relationship-key' });
    expect([...providers[0].fields.keys()]).toEqual(['relationship']);
  });
});
