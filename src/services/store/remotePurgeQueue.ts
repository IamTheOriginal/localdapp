import * as Y from 'yjs';
import type { PendingRemotePurge, RelationshipChannelControlMessage, RemotePurgeIntent } from '../../types.ts';
import { getRootDoc } from './docs.ts';

const PENDING_MAP = 'pendingRelationshipChannelPurges';
const INTENTS_MAP = 'remoteRelationshipChannelPurgeIntents';
const PROCESSED_MAP = 'processedRelationshipChannelPurges';

interface ProcessedRemotePurge {
  schemaVersion: 1;
  requestId: string;
  requestMessageHash: string;
  channelId: string;
  relationshipId: string;
  ackMessage: RelationshipChannelControlMessage;
  purgedAt: string;
}

function pendingMap(doc: Y.Doc): Y.Map<PendingRemotePurge> {
  return doc.getMap<PendingRemotePurge>(PENDING_MAP);
}

function processedMap(doc: Y.Doc): Y.Map<ProcessedRemotePurge> {
  return doc.getMap<ProcessedRemotePurge>(PROCESSED_MAP);
}

function intentsMap(doc: Y.Doc): Y.Map<RemotePurgeIntent> {
  return doc.getMap<RemotePurgeIntent>(INTENTS_MAP);
}

export function persistRemotePurgeIntent(
  input: Pick<RemotePurgeIntent, 'relationshipId' | 'channelId' | 'controlOfferMessageId' | 'reason'> & { intentId?: string },
  doc: Y.Doc = getRootDoc(),
): RemotePurgeIntent {
  const existing = Array.from(intentsMap(doc).values()).find((intent) =>
    intent.relationshipId === input.relationshipId && intent.channelId === input.channelId && intent.reason === input.reason);
  if (existing) return existing;
  const intent: RemotePurgeIntent = Object.freeze({
    schemaVersion: 1, intentId: input.intentId ?? crypto.randomUUID(), relationshipId: input.relationshipId,
    channelId: input.channelId, controlOfferMessageId: input.controlOfferMessageId,
    reason: input.reason, status: 'unprepared', attempts: 0,
    createdAt: new Date().toISOString(),
  });
  intentsMap(doc).set(intent.intentId, intent);
  return intent;
}

export function listRemotePurgeIntents(doc: Y.Doc = getRootDoc()): RemotePurgeIntent[] {
  return Array.from(intentsMap(doc).values()).filter((intent) => intent.schemaVersion === 1);
}

export function recordRemotePurgeIntentFailure(intentId: string, error: unknown, doc: Y.Doc = getRootDoc()): void {
  const current = intentsMap(doc).get(intentId);
  if (!current) return;
  intentsMap(doc).set(intentId, Object.freeze({
    ...current, attempts: current.attempts + 1, lastAttemptAt: new Date().toISOString(),
    lastError: error instanceof Error ? error.message : 'Unknown purge preparation failure',
  }));
}

export function removeRemotePurgeIntent(intentId: string, doc: Y.Doc = getRootDoc()): void {
  intentsMap(doc).delete(intentId);
}

export function enqueueRemotePurge(
  purge: Omit<PendingRemotePurge, 'schemaVersion' | 'status' | 'attempts' | 'createdAt'> & { createdAt?: string },
  doc: Y.Doc = getRootDoc(),
): PendingRemotePurge {
  const existing = pendingMap(doc).get(purge.requestId);
  if (existing) {
    if (existing.requestMessageHash !== purge.requestMessageHash || existing.channelId !== purge.channelId) {
      throw new Error('remote purge queue: Request identifier reuse rejected');
    }
    return existing;
  }
  const queued: PendingRemotePurge = Object.freeze({
    ...purge,
    schemaVersion: 1,
    status: 'pending',
    attempts: 0,
    createdAt: purge.createdAt ?? new Date().toISOString(),
  });
  pendingMap(doc).set(queued.requestId, queued);
  return queued;
}

export function listPendingRemotePurges(doc: Y.Doc = getRootDoc()): PendingRemotePurge[] {
  return Array.from(pendingMap(doc).values()).filter((item) => item.schemaVersion === 1 && item.status === 'pending');
}

export function listRemotePurges(doc: Y.Doc = getRootDoc()): PendingRemotePurge[] {
  return Array.from(pendingMap(doc).values()).filter((item) => item.schemaVersion === 1);
}

export function recordRemotePurgeAttempt(requestId: string, doc: Y.Doc = getRootDoc()): PendingRemotePurge {
  const current = pendingMap(doc).get(requestId);
  if (!current) throw new Error('remote purge queue: Unknown request');
  const next: PendingRemotePurge = Object.freeze({
    ...current,
    attempts: current.attempts + 1,
    lastAttemptAt: new Date().toISOString(),
  });
  pendingMap(doc).set(requestId, next);
  return next;
}

export function acknowledgeRemotePurge(
  requestId: string,
  acknowledgedAt: string,
  doc: Y.Doc = getRootDoc(),
): PendingRemotePurge {
  const current = pendingMap(doc).get(requestId);
  if (!current) throw new Error('remote purge queue: Unknown request');
  if (current.status === 'acknowledged') return current;
  const next: PendingRemotePurge = Object.freeze({ ...current, status: 'acknowledged', acknowledgedAt });
  pendingMap(doc).set(requestId, next);
  return next;
}

/**
 * Drops every purge intent, queued request, and processed receipt of a removed
 * relationship — once its control room is gone, none of them can ever complete
 * or be replayed, and the 30s retry loop must stop erroring on them.
 */
export function removeRemotePurgesForRelationship(relationshipId: string, doc: Y.Doc = getRootDoc()): void {
  const purge = <T extends { relationshipId: string }>(map: Y.Map<T>) => {
    for (const key of [...map.keys()]) {
      if (map.get(key)?.relationshipId === relationshipId) map.delete(key);
    }
  };
  purge(intentsMap(doc));
  purge(pendingMap(doc));
  purge(processedMap(doc));
}

export function getProcessedRemotePurge(
  requestMessageHash: string,
  doc: Y.Doc = getRootDoc(),
): ProcessedRemotePurge | null {
  return processedMap(doc).get(requestMessageHash) ?? null;
}

export function recordProcessedRemotePurge(
  receipt: ProcessedRemotePurge,
  doc: Y.Doc = getRootDoc(),
): ProcessedRemotePurge {
  const existing = processedMap(doc).get(receipt.requestMessageHash);
  if (existing) return existing;
  const frozen = Object.freeze({ ...receipt, schemaVersion: 1 as const });
  processedMap(doc).set(receipt.requestMessageHash, frozen);
  return frozen;
}
