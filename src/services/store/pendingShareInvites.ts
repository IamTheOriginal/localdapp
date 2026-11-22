import * as Y from 'yjs';
import { getRootDoc } from './docs.ts';
import type { PendingShareInvite } from '../../types.ts';

function pendingShareInvitesMap(doc: Y.Doc = getRootDoc()): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>('pendingShareInvites');
}

function toPendingShareInvite(value: Y.Map<unknown>): PendingShareInvite {
  return {
    id: String(value.get('id')),
    schemaVersion: 1,
    relationshipId: String(value.get('relationshipId')),
    dappId: String(value.get('dappId')),
    shareId: String(value.get('shareId')),
    shareLabel: String(value.get('shareLabel')),
    instanceId: String(value.get('instanceId')),
    offerId: String(value.get('offerId')),
    dappMeta: value.get('dappMeta') as PendingShareInvite['dappMeta'],
    events: value.get('events') as PendingShareInvite['events'],
    actions: value.get('actions') as PendingShareInvite['actions'],
    routes: value.get('routes') as PendingShareInvite['routes'],
    definition: value.get('definition') as PendingShareInvite['definition'],
    channel: value.get('channel') as PendingShareInvite['channel'],
    offerMessageId: String(value.get('offerMessageId')),
    offerMessageHash: String(value.get('offerMessageHash')),
    receivedAt: String(value.get('receivedAt')),
    status: value.get('status') as PendingShareInvite['status'],
  };
}

/**
 * Stages an incoming channel-share-offer for the user to see before anything installs.
 * Never call this from an auto-accept path — see docs/plans/2026-08-20-code-app-platform-expansion.md Phase 5.
 */
export function createPendingShareInvite(
  input: Omit<PendingShareInvite, 'id' | 'schemaVersion' | 'receivedAt' | 'status'>,
  doc: Y.Doc = getRootDoc(),
): PendingShareInvite {
  const id = crypto.randomUUID();
  const value = new Y.Map<unknown>();
  value.set('id', id);
  value.set('schemaVersion', 1);
  value.set('relationshipId', input.relationshipId);
  value.set('dappId', input.dappId);
  value.set('shareId', input.shareId);
  value.set('shareLabel', input.shareLabel);
  value.set('instanceId', input.instanceId);
  value.set('offerId', input.offerId);
  value.set('dappMeta', input.dappMeta);
  value.set('events', input.events);
  value.set('actions', input.actions);
  value.set('routes', input.routes);
  if (input.definition) value.set('definition', input.definition);
  value.set('channel', input.channel);
  value.set('offerMessageId', input.offerMessageId);
  value.set('offerMessageHash', input.offerMessageHash);
  value.set('receivedAt', new Date().toISOString());
  value.set('status', 'pending');
  pendingShareInvitesMap(doc).set(id, value);
  return toPendingShareInvite(value);
}

export function listPendingShareInvites(doc: Y.Doc = getRootDoc()): PendingShareInvite[] {
  return Array.from(pendingShareInvitesMap(doc).values()).map(toPendingShareInvite)
    .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
}

export function getPendingShareInvite(id: string, doc: Y.Doc = getRootDoc()): PendingShareInvite | null {
  const value = pendingShareInvitesMap(doc).get(id);
  return value ? toPendingShareInvite(value) : null;
}

/** Guards against staging the same offer twice if the control room is rescanned. */
export function findPendingShareInviteByOfferMessageId(offerMessageId: string, doc: Y.Doc = getRootDoc()): PendingShareInvite | null {
  return listPendingShareInvites(doc).find((invite) => invite.offerMessageId === offerMessageId) ?? null;
}

export function setPendingShareInviteStatus(id: string, status: PendingShareInvite['status'], doc: Y.Doc = getRootDoc()): PendingShareInvite {
  const value = pendingShareInvitesMap(doc).get(id);
  if (!value) throw new Error('pending share invites: Unknown invite');
  value.set('status', status);
  return toPendingShareInvite(value);
}

/** Retains declined tombstones so revoked offers cannot be staged again after a control-room rescan. */
export function declinePendingShareInvitesByChannel(
  relationshipId: string,
  channelId: string,
  doc: Y.Doc = getRootDoc(),
): PendingShareInvite[] {
  const declined: PendingShareInvite[] = [];
  for (const [id, value] of pendingShareInvitesMap(doc)) {
    const invite = toPendingShareInvite(value);
    if (invite.status !== 'pending' || invite.relationshipId !== relationshipId || invite.channel.id !== channelId) continue;
    declined.push(setPendingShareInviteStatus(id, 'declined', doc));
  }
  return declined;
}
