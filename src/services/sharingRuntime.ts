import * as Y from 'yjs';
import type { ChannelDescriptor, Relationship } from '../types.ts';
import { createBrowserChannelRoomManager, type ChannelRoomHandle, type ChannelRoomManager } from './channelRoomManager.ts';
import { clearIndexeddbDocument, getRootDoc } from './store/docs.ts';
import { clearChannelBindingHistory } from './channelBindingHistory.ts';
import { getChannelDescriptorById, listChannelDescriptorsForDapp, removeChannelDescriptorById } from './store/channelRegistry.ts';

const roomManager: ChannelRoomManager | null = typeof window === 'undefined'
  ? null
  : createBrowserChannelRoomManager();

function requireRoomManager(): ChannelRoomManager {
  if (!roomManager) throw new Error('sharing runtime: Browser room manager is unavailable');
  return roomManager;
}

async function deriveChannelPseudonym(relationshipPublicKey: string, channelId: string): Promise<string> {
  const data = new TextEncoder().encode(`relationship-channel-pseudonym-v1\0${channelId}\0${relationshipPublicKey}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).slice(0, 12).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function openRelationshipChannel(
  descriptor: ChannelDescriptor,
  relationship: Relationship,
  connect = true,
  options: { allowPending?: boolean } = {},
): Promise<ChannelRoomHandle> {
  const rooms = requireRoomManager();
  const acceptableStatus = descriptor.status === 'active' || (options.allowPending === true && descriptor.status === 'prepared');
  if (relationship.status !== 'active' || descriptor.relationshipId !== relationship.id || !acceptableStatus) {
    throw new Error('sharing runtime: Active matching relationship and channel are required');
  }
  const pseudonym = await deriveChannelPseudonym(relationship.localIdentity.publicKey, descriptor.id);
  const room = rooms.open(descriptor, {
    relationshipPublicKey: relationship.localIdentity.publicKey,
    channelPseudonym: pseudonym,
  });
  if (connect) rooms.connect(descriptor.id);
  return room;
}

export async function purgeRelationshipChannelLocal(
  channelId: string,
  expectedRelationshipId: string,
  rootDoc: Y.Doc = getRootDoc(),
): Promise<void> {
  const tombstones = rootDoc.getMap<string>('purgedRelationshipChannels');
  const priorOwner = tombstones.get(channelId);
  if (priorOwner) {
    if (priorOwner !== expectedRelationshipId) throw new Error('relationship channel purge: Relationship ownership mismatch');
    return;
  }
  const descriptor = getChannelDescriptorById(channelId, rootDoc);
  if (!descriptor) throw new Error('relationship channel purge: Unknown channel');
  if (descriptor.relationshipId !== expectedRelationshipId) {
    throw new Error('relationship channel purge: Relationship ownership mismatch');
  }
  await roomManager?.destroy(channelId, { clearPersistence: true });
  await clearIndexeddbDocument(descriptor.persistenceKey);
  removeChannelDescriptorById(channelId, rootDoc);
  // Replay and diagnostic rows of a purged channel were kept for ever (the root doc only grew).
  clearChannelBindingHistory(rootDoc, channelId);
  tombstones.set(channelId, expectedRelationshipId);
}

export async function destroyDappRelationshipChannels(dappId: string, clearPersistence = true): Promise<void> {
  for (const descriptor of listChannelDescriptorsForDapp(dappId)) {
    await roomManager?.destroy(descriptor.id, { clearPersistence });
    if (clearPersistence) await clearIndexeddbDocument(descriptor.persistenceKey);
  }
}
