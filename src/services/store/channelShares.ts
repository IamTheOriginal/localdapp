import * as Y from 'yjs';
import { getRootDoc } from './docs.ts';
import type { ChannelShare } from '../../types.ts';

function channelSharesMap(doc: Y.Doc = getRootDoc()): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>('channelShares');
}

function toChannelShare(value: Y.Map<unknown>): ChannelShare {
  return {
    id: String(value.get('id')),
    schemaVersion: 1,
    dappId: String(value.get('dappId')),
    shareId: String(value.get('shareId')),
    instanceId: String(value.get('instanceId')),
    relationshipId: String(value.get('relationshipId')),
    channelId: String(value.get('channelId')),
    eventIds: Array.isArray(value.get('eventIds')) ? (value.get('eventIds') as unknown[]).map(String) : [],
    actionIds: Array.isArray(value.get('actionIds')) ? (value.get('actionIds') as unknown[]).map(String) : [],
    offerId: value.has('offerId') ? String(value.get('offerId')) : undefined,
    controlOfferMessageId: value.has('controlOfferMessageId') ? String(value.get('controlOfferMessageId')) : undefined,
    status: value.get('status') as ChannelShare['status'],
    createdAt: String(value.get('createdAt')),
    updatedAt: String(value.get('updatedAt')),
  };
}

/** One row per participant (relationship) — every row sharing the same instanceId is one $share.open call's fan-out. */
export function createChannelShare(input: {
  dappId: string;
  shareId: string;
  instanceId: string;
  relationshipId: string;
  channelId: string;
  eventIds: string[];
  actionIds: string[];
  offerId?: string;
  controlOfferMessageId?: string;
  status?: ChannelShare['status'];
}, doc: Y.Doc = getRootDoc()): ChannelShare {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const value = new Y.Map<unknown>();
  value.set('id', id);
  value.set('schemaVersion', 1);
  value.set('dappId', input.dappId);
  value.set('shareId', input.shareId);
  value.set('instanceId', input.instanceId);
  value.set('relationshipId', input.relationshipId);
  value.set('channelId', input.channelId);
  value.set('eventIds', input.eventIds);
  value.set('actionIds', input.actionIds);
  if (input.offerId) value.set('offerId', input.offerId);
  if (input.controlOfferMessageId) value.set('controlOfferMessageId', input.controlOfferMessageId);
  value.set('status', input.status ?? 'pending');
  value.set('createdAt', now);
  value.set('updatedAt', now);
  channelSharesMap(doc).set(id, value);
  return toChannelShare(value);
}

export function listAllChannelShares(doc: Y.Doc = getRootDoc()): ChannelShare[] {
  return Array.from(channelSharesMap(doc).values()).map(toChannelShare);
}

export function listChannelShares(dappId: string, doc: Y.Doc = getRootDoc()): ChannelShare[] {
  return listAllChannelShares(doc).filter((share) => share.dappId === dappId);
}

export function listChannelSharesByInstance(dappId: string, instanceId: string, doc: Y.Doc = getRootDoc()): ChannelShare[] {
  return listChannelShares(dappId, doc).filter((share) => share.instanceId === instanceId);
}

export function getChannelShareById(id: string, doc: Y.Doc = getRootDoc()): ChannelShare | null {
  const value = channelSharesMap(doc).get(id);
  return value ? toChannelShare(value) : null;
}

export function setChannelShareStatus(id: string, status: ChannelShare['status'], doc: Y.Doc = getRootDoc()): ChannelShare {
  const value = channelSharesMap(doc).get(id);
  if (!value) throw new Error('channel shares: Unknown channel share');
  value.set('status', status);
  value.set('updatedAt', new Date().toISOString());
  return toChannelShare(value);
}

export function removeChannelShare(id: string, doc: Y.Doc = getRootDoc()): boolean {
  const map = channelSharesMap(doc);
  if (!map.has(id)) return false;
  map.delete(id);
  return true;
}

export function removeChannelSharesForDapp(dappId: string, doc: Y.Doc = getRootDoc()): ChannelShare[] {
  const removed = listChannelShares(dappId, doc);
  const map = channelSharesMap(doc);
  removed.forEach((share) => map.delete(share.id));
  return removed;
}
