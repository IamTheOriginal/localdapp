import * as Y from 'yjs';
import { getDappDoc } from './docs.ts';
import { getRole, requireRole, signRecord } from './auth.ts';
import { getIdentity, getSigningIdentity } from '../identity.ts';
import { mapToObject, timestampAfter, writeSignedRecordTombstone, yMapFromObject } from './protocolCore.ts';
import {
  containerRecords, isCompactContainer, isFieldsContainer, plainRecordValue,
  type CompactContainer,
} from './recordContainers.ts';

import type { RecordData } from '../../types.ts';

// ───── Data Operations ─────
//
// Collections have two on-wire representations (see recordContainers.ts).
// New collections are always compact; a legacy array container keeps its
// shape until an owner device converts it (migrateLegacyCollections).

export function getEntityRecords(dappId: string, entityId: string): RecordData[] | undefined {
  const doc = getDappDoc(dappId);
  const container = doc.getMap('data').get(entityId);
  if (container === undefined) return undefined;
  return containerRecords(container) as RecordData[];
}

async function signRecordPayload(recordData: Record<string, unknown>, existing?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const identity = getIdentity();
  if (!identity) throw new Error('auth: No identity — cannot write');
  const payload: Record<string, unknown> = existing
    ? {
        ...existing,
        ...recordData,
        updatedAt: timestampAfter(existing.updatedAt, existing.createdAt),
        _updatedBy: identity.publicKey,
        createdBy: existing._createdBy ?? existing.createdBy,
      }
    : {
        ...recordData,
        createdAt: new Date().toISOString(),
        createdBy: identity.publicKey,
        _createdBy: identity.publicKey,
      };
  delete payload._signature;
  delete payload._signedBy;
  const { _signedBy, _signature } = await signRecord(payload);
  payload._signedBy = _signedBy;
  payload._signature = _signature;
  return payload;
}

export async function addRecord(dappId: string, entityId: string, recordData: Record<string, unknown>): Promise<void> {
  requireRole(dappId, 'editor');

  const doc = getDappDoc(dappId);
  const data = doc.getMap('data');
  const rawId = recordData.id;
  if (!rawId) {
    throw new Error('Record ID is required for addRecord');
  }
  const recordIdKey = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : '';
  const recordPayload = await signRecordPayload(recordData);

  const existing = data.get(entityId);
  if (isFieldsContainer(existing)) {
    existing.push([yMapFromObject(recordPayload)]);
    return;
  }
  if (isCompactContainer(existing)) {
    existing.set(recordIdKey, recordPayload);
    return;
  }
  // First record of a collection nobody created a container for (declared entities get
  // theirs from the owner, config.ts::seedDappSchema). Should another device create one
  // concurrently and win, recordContainerMerge.ts puts this record into the survivor.
  const container: CompactContainer = new Y.Map<Record<string, unknown>>();
  container.set(recordIdKey, recordPayload);
  data.set(entityId, container);
}

/**
 * Rewrites every legacy array collection of a dapp into the compact shape,
 * all in one transaction so the auth observer sees the same verified record
 * set before and after (records keep their signatures — the container is not
 * part of what gets signed). Owner devices only, idempotent; returns how many
 * collections were converted. An editor write that raced the conversion into
 * the old array is put back into the new container by the editor's own device
 * (recordContainerMerge.ts) — every peer reads both shapes, so nobody else
 * needs to be upgraded first.
 */
export function migrateLegacyCollections(dappId: string): number {
  const identity = getIdentity();
  if (!identity || getRole(dappId, identity.publicKey) !== 'owner') return 0;
  const doc = getDappDoc(dappId);
  const data = doc.getMap('data');
  const legacy: string[] = [];
  data.forEach((container, entityId) => { if (isFieldsContainer(container)) legacy.push(entityId); });
  if (legacy.length === 0) return 0;
  doc.transact(() => {
    for (const entityId of legacy) {
      const container: CompactContainer = new Y.Map<Record<string, unknown>>();
      for (const record of containerRecords(data.get(entityId))) {
        if (typeof record.id === 'string' || typeof record.id === 'number') container.set(String(record.id), record);
      }
      data.set(entityId, container);
    }
  }, 'migrate-legacy-collections');
  return legacy.length;
}

export async function updateRecord(dappId: string, entityId: string, recordId: string, updates: Record<string, unknown>): Promise<void> {
  requireRole(dappId, 'editor');

  const doc = getDappDoc(dappId);
  const data = doc.getMap('data');
  const container = data.get(entityId);
  if (!container) return;

  const cleanUpdates: Record<string, unknown> = { ...updates };
  for (const reserved of ['id', 'createdAt', 'createdBy', '_createdBy', '_updatedBy', '_signedBy', '_signature']) {
    delete cleanUpdates[reserved];
  }

  if (isCompactContainer(container)) {
    const current = container.get(recordId);
    if (current === undefined) return;
    const next = await signRecordPayload(cleanUpdates, plainRecordValue(current));
    container.set(recordId, next);
    return;
  }
  if (!isFieldsContainer(container)) return;

  for (let i = 0; i < container.length; i++) {
    const record = container.get(i);
    if (record.get('id') === recordId) {
      const next = await signRecordPayload(cleanUpdates, mapToObject(record));

      doc.transact(() => {
        record.set('updatedAt', next.updatedAt as string);
        record.set('_updatedBy', next._updatedBy as string);
        if (next.createdBy !== undefined) record.set('createdBy', next.createdBy);
        if (next._createdBy !== undefined) record.set('_createdBy', next._createdBy);
        record.set('_signedBy', next._signedBy);
        record.set('_signature', next._signature);
        Object.entries(cleanUpdates).forEach(([k, v]) => {
          record.set(k, v);
        });
      });
      break;
    }
  }
}

export async function deleteRecord(dappId: string, entityId: string, recordId: string): Promise<void> {
  requireRole(dappId, 'editor');

  const doc = getDappDoc(dappId);
  const identity = getIdentity();
  if (!identity) throw new Error('auth: No identity to sign with');

  const deleted = await writeSignedRecordTombstone(doc, entityId, recordId, await getSigningIdentity());
  if (!deleted && doc.getMap('data').get(entityId)) {
    throw new Error(`Record "${recordId}" not found in entity "${entityId}"`);
  }
}
