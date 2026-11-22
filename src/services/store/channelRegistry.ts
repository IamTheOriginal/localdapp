import * as Y from 'yjs';
import { generateRoomPassword, getRootDoc } from './docs.ts';
import type { ChannelDescriptor } from '../../types.ts';

export interface ChannelTuple {
  relationshipId: string;
  dappId: string;
  sensitiveShareId?: string;
}

function descriptorsMap(doc: Y.Doc = getRootDoc()): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>('channelDescriptors');
}

function channelTupleKey(tuple: ChannelTuple): string {
  if (!tuple.relationshipId.trim() || !tuple.dappId.trim()) {
    throw new Error('channels: Relationship and dapp IDs are required');
  }
  return JSON.stringify([
    tuple.relationshipId,
    tuple.dappId,
    tuple.sensitiveShareId ?? null,
  ]);
}

function memberKeys(value: Y.Map<unknown>): string[] {
  const keys = value.get('memberDeviceKeys');
  return Array.isArray(keys) ? keys.map(String) : [];
}

/** Writes a plain descriptor into the registry as a fresh Y.Map (undefined fields omitted). */
function writeDescriptor(registry: Y.Map<Y.Map<unknown>>, tupleKey: string, descriptor: ChannelDescriptor): void {
  const value = new Y.Map<unknown>();
  Object.entries(descriptor).forEach(([key, item]) => {
    if (item !== undefined) value.set(key, item);
  });
  registry.set(tupleKey, value);
}

function toDescriptor(value: Y.Map<unknown>): ChannelDescriptor {
  const schemaVersion = value.get('schemaVersion');
  const status = value.get('status');
  if (schemaVersion !== 1 || !['prepared', 'active', 'revoked'].includes(String(status))) {
    throw new Error('channels: Unsupported or malformed channel descriptor');
  }
  return {
    id: String(value.get('id')),
    schemaVersion,
    relationshipId: String(value.get('relationshipId')),
    dappId: String(value.get('dappId')),
    sensitiveShareId: value.get('sensitiveShareId') ? String(value.get('sensitiveShareId')) : undefined,
    roomId: String(value.get('roomId')),
    roomPassword: String(value.get('roomPassword')),
    persistenceKey: String(value.get('persistenceKey')),
    controlOfferMessageId: value.get('controlOfferMessageId') ? String(value.get('controlOfferMessageId')) : undefined,
    memberDeviceKeys: memberKeys(value),
    status: status as ChannelDescriptor['status'],
    createdAt: String(value.get('createdAt')),
    updatedAt: String(value.get('updatedAt')),
  };
}

export function createChannelDescriptor(tuple: ChannelTuple): ChannelDescriptor {
  channelTupleKey(tuple);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  return {
    id,
    schemaVersion: 1,
    relationshipId: tuple.relationshipId,
    dappId: tuple.dappId,
    sensitiveShareId: tuple.sensitiveShareId,
    roomId: `relationship-channel-v1-${crypto.randomUUID()}`,
    roomPassword: generateRoomPassword(),
    persistenceKey: `relationship-channel-v1-${id}`,
    memberDeviceKeys: [],
    status: 'prepared',
    createdAt: now,
    updatedAt: now,
  };
}

export function registerChannelDescriptor(
  tuple: ChannelTuple,
  doc: Y.Doc = getRootDoc(),
): ChannelDescriptor {
  const tupleKey = channelTupleKey(tuple);
  const registry = descriptorsMap(doc);
  const existing = registry.get(tupleKey);
  if (existing) return toDescriptor(existing);

  const descriptor = createChannelDescriptor(tuple);
  writeDescriptor(registry, tupleKey, descriptor);
  return descriptor;
}

/** Installs credentials received over authenticated relationship control without permitting replacement. */
export function installChannelDescriptor(
  tuple: ChannelTuple,
  descriptor: ChannelDescriptor,
  doc: Y.Doc = getRootDoc(),
): ChannelDescriptor {
  const tupleKey = channelTupleKey(tuple);
  if (descriptor.relationshipId !== tuple.relationshipId || descriptor.dappId !== tuple.dappId
    || descriptor.sensitiveShareId !== tuple.sensitiveShareId || descriptor.schemaVersion !== 1) {
    throw new Error('channels: Installed channel tuple mismatch');
  }
  if (descriptor.persistenceKey !== `relationship-channel-v1-${descriptor.id}`) {
    throw new Error('channels: Invalid locally-derived persistence key');
  }
  const keys = [...new Set(descriptor.memberDeviceKeys)];
  if (keys.length !== 2 || keys.some((key) => !/^[a-f0-9]{64}$/.test(key))) {
    throw new Error('channels: Exactly two pinned relationship keys are required');
  }
  const registry = descriptorsMap(doc);
  if (registry.has(tupleKey)) throw new Error('channels: Channel descriptor replacement rejected');
  writeDescriptor(registry, tupleKey, { ...descriptor, memberDeviceKeys: keys });
  return Object.freeze({ ...descriptor, memberDeviceKeys: Object.freeze(keys) }) as unknown as ChannelDescriptor;
}

export function setChannelControlOfferMessage(
  channelId: string,
  messageId: string,
  doc: Y.Doc = getRootDoc(),
): ChannelDescriptor {
  for (const value of descriptorsMap(doc).values()) {
    if (String(value.get('id')) === channelId) {
      value.set('controlOfferMessageId', messageId);
      value.set('updatedAt', new Date().toISOString());
      return toDescriptor(value);
    }
  }
  throw new Error('channels: Unknown channel descriptor');
}

export function listChannelDescriptors(doc: Y.Doc = getRootDoc()): ChannelDescriptor[] {
  return Array.from(descriptorsMap(doc).values()).map(toDescriptor);
}

export function getChannelDescriptorById(channelId: string, doc: Y.Doc = getRootDoc()): ChannelDescriptor | null {
  return listChannelDescriptors(doc).find((descriptor) => descriptor.id === channelId) ?? null;
}

export function listChannelDescriptorsForDapp(dappId: string, doc: Y.Doc = getRootDoc()): ChannelDescriptor[] {
  return listChannelDescriptors(doc).filter((descriptor) => descriptor.dappId === dappId);
}

export function removeChannelDescriptorById(channelId: string, doc: Y.Doc = getRootDoc()): boolean {
  const registry = descriptorsMap(doc);
  for (const [key, value] of registry) {
    if (String(value.get('id')) === channelId) {
      registry.delete(key);
      return true;
    }
  }
  return false;
}

export function removeChannelDescriptorsForDapp(dappId: string, doc: Y.Doc = getRootDoc()): ChannelDescriptor[] {
  const removed = listChannelDescriptorsForDapp(dappId, doc);
  const ids = new Set(removed.map((descriptor) => descriptor.id));
  const registry = descriptorsMap(doc);
  for (const [key, value] of registry) {
    if (ids.has(String(value.get('id')))) registry.delete(key);
  }
  return removed;
}

export function getChannelDescriptor(
  tuple: ChannelTuple,
  doc: Y.Doc = getRootDoc(),
): ChannelDescriptor | null {
  const value = descriptorsMap(doc).get(channelTupleKey(tuple));
  return value ? toDescriptor(value) : null;
}

export function activateChannelDescriptor(
  tuple: ChannelTuple,
  doc: Y.Doc = getRootDoc(),
): ChannelDescriptor {
  const value = descriptorsMap(doc).get(channelTupleKey(tuple));
  if (!value) throw new Error('channels: Unknown channel descriptor');
  if (value.get('status') === 'revoked') throw new Error('channels: A revoked channel cannot be activated');
  if (memberKeys(value).length === 0) throw new Error('channels: At least one admitted signer is required');
  value.set('status', 'active');
  value.set('updatedAt', new Date().toISOString());
  return toDescriptor(value);
}

export function revokeChannelDescriptor(
  tuple: ChannelTuple,
  doc: Y.Doc = getRootDoc(),
): ChannelDescriptor {
  const value = descriptorsMap(doc).get(channelTupleKey(tuple));
  if (!value) throw new Error('channels: Unknown channel descriptor');
  value.set('status', 'revoked');
  value.set('updatedAt', new Date().toISOString());
  return toDescriptor(value);
}

export function admitChannelDevice(
  tuple: ChannelTuple,
  signingPublicKey: string,
  doc: Y.Doc = getRootDoc(),
): ChannelDescriptor {
  if (!/^[a-f0-9]{64}$/.test(signingPublicKey)) {
    throw new Error('channels: Invalid Ed25519 device public key');
  }
  const value = descriptorsMap(doc).get(channelTupleKey(tuple));
  if (!value) throw new Error('channels: Unknown channel descriptor');
  if (value.get('status') === 'revoked') throw new Error('channels: Channel is revoked');
  const current = memberKeys(value);
  if (!current.includes(signingPublicKey)) value.set('memberDeviceKeys', [...current, signingPublicKey]);
  value.set('updatedAt', new Date().toISOString());
  return toDescriptor(value);
}

export function removeChannelDevice(
  tuple: ChannelTuple,
  signingPublicKey: string,
  doc: Y.Doc = getRootDoc(),
): ChannelDescriptor {
  const value = descriptorsMap(doc).get(channelTupleKey(tuple));
  if (!value) throw new Error('channels: Unknown channel descriptor');
  value.set('memberDeviceKeys', memberKeys(value).filter((key) => key !== signingPublicKey));
  value.set('updatedAt', new Date().toISOString());
  return toDescriptor(value);
}
