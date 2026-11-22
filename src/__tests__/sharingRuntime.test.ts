import { must } from './helpers/must.ts';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  activateChannelDescriptor, getChannelDescriptor, registerChannelDescriptor,
} from '../services/store/channelRegistry.ts';
import { purgeRelationshipChannelLocal } from '../services/sharingRuntime.ts';

describe('relationship sharing runtime commands', () => {
  it('activates a prepared descriptor only after a relationship signer is admitted', () => {
    const rootDoc = new Y.Doc();
    const tuple = { relationshipId: 'bob', dappId: 'tracker' };
    registerChannelDescriptor(tuple, rootDoc);
    expect(() => activateChannelDescriptor(tuple, rootDoc)).toThrow(/admitted signer/i);
    const map = must(rootDoc.getMap<Y.Map<unknown>>('channelDescriptors').get(JSON.stringify(['bob', 'tracker', null])));
    map.set('memberDeviceKeys', ['a'.repeat(64)]);
    expect(activateChannelDescriptor(tuple, rootDoc).status).toBe('active');
    expect(getChannelDescriptor(tuple, rootDoc)?.status).toBe('active');
  });

  it('rejects a purge request from a different authenticated relationship', async () => {
    const rootDoc = new Y.Doc();
    const descriptor = registerChannelDescriptor({ relationshipId: 'alice-bob', dappId: 'habits' }, rootDoc);
    await expect(purgeRelationshipChannelLocal(descriptor.id, 'alice-mallory', rootDoc)).rejects.toThrow(/ownership mismatch/);
    expect(getChannelDescriptor({ relationshipId: 'alice-bob', dappId: 'habits' }, rootDoc)?.id).toBe(descriptor.id);
  });
});
