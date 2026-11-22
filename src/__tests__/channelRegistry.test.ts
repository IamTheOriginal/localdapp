import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createChannelDescriptor,
  getChannelDescriptor,
  registerChannelDescriptor,
  admitChannelDevice,
  removeChannelDevice,
} from '../services/store/channelRegistry.ts';

describe('relationship channel registry', () => {
  it('gives Bob and Carol separate room capabilities and persistence keys', () => {
    const bob = createChannelDescriptor({ relationshipId: 'bob', dappId: 'habits' });
    const carol = createChannelDescriptor({ relationshipId: 'carol', dappId: 'habits' });

    expect(bob.roomId).not.toBe(carol.roomId);
    expect(bob.roomPassword).not.toBe(carol.roomPassword);
    expect(bob.persistenceKey).not.toBe(carol.persistenceKey);
  });

  it('isolates a sensitive share from the ordinary relationship+dapp channel', () => {
    const ordinary = createChannelDescriptor({ relationshipId: 'bob', dappId: 'habits' });
    const sensitive = createChannelDescriptor({
      relationshipId: 'bob',
      dappId: 'habits',
      sensitiveShareId: 'medical-recovery',
    });

    expect(sensitive.roomId).not.toBe(ordinary.roomId);
    expect(sensitive.roomPassword).not.toBe(ordinary.roomPassword);
    expect(sensitive.persistenceKey).not.toBe(ordinary.persistenceKey);
  });

  it('registers the same tuple idempotently without constructing providers', () => {
    const doc = new Y.Doc();
    const tuple = { relationshipId: 'bob', dappId: 'habits' };
    const first = registerChannelDescriptor(tuple, doc);
    const second = registerChannelDescriptor(tuple, doc);

    expect(second).toEqual(first);
    expect(doc.getMap('channelDescriptors').size).toBe(1);
    expect(getChannelDescriptor(tuple, doc)).toEqual(first);
  });

  it('admits and removes valid signing keys idempotently', () => {
    const doc = new Y.Doc();
    const tuple = { relationshipId: 'bob', dappId: 'habits' };
    registerChannelDescriptor(tuple, doc);
    const key = 'a'.repeat(64);

    admitChannelDevice(tuple, key, doc);
    const admittedAgain = admitChannelDevice(tuple, key, doc);
    expect(admittedAgain.memberDeviceKeys).toEqual([key]);
    expect(removeChannelDevice(tuple, key, doc).memberDeviceKeys).toEqual([]);
    expect(() => admitChannelDevice(tuple, 'invalid', doc)).toThrow(/Invalid Ed25519/);
  });
});
