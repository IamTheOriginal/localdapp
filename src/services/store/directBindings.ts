import * as Y from 'yjs';
import type { CodeAppBindingDeclaration } from '../../types.ts';
import { getRootDoc } from './docs.ts';

const MAX_DIRECT_BINDINGS = 256;
const MAX_DIRECT_DELIVERIES = 1000;
export const MAX_DIRECT_PAYLOAD_BYTES = 64 * 1024;

type DirectBindingStatus = 'active' | 'paused' | 'blocked';

export interface DirectBinding {
  id: string;
  sourceDappId: string;
  sourceEvent: CodeAppBindingDeclaration;
  sourceFingerprint: string;
  destinationDappId: string;
  destinationAction: CodeAppBindingDeclaration;
  destinationFingerprint: string;
  /** Destination payload field name -> source payload field name. Missing on bindings approved before payload schemas existed; treat as `{}`. */
  fieldMap: Record<string, string>;
  status: DirectBindingStatus;
  statusReason?: string;
  approvedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DirectDelivery {
  id: string;
  bindingId: string;
  sourceDappId: string;
  eventId: string;
  destinationDappId: string;
  actionId: string;
  payload: unknown;
  status: 'pending' | 'delivering' | 'delivered';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  lastError?: string;
}

const bindingsMap = (doc: Y.Doc) => doc.getMap<DirectBinding>('directCodeBindings');
const deliveriesMap = (doc: Y.Doc) => doc.getMap<DirectDelivery>('directCodeDeliveries');

/** Fingerprints the complete normalized declaration snapshot using deterministic FNV-1a. */
export function fingerprintBindingDeclaration(declaration: CodeAppBindingDeclaration): string {
  const normalized = JSON.stringify({
    id: declaration.id,
    label: declaration.label,
    ...(declaration.description ? { description: declaration.description } : {}),
    ...(declaration.payload ? { payload: declaration.payload } : {}),
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `v1-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function listDirectBindings(doc: Y.Doc = getRootDoc()): DirectBinding[] {
  return [...bindingsMap(doc).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function createDirectBinding(input: {
  sourceDappId: string;
  sourceEvent: CodeAppBindingDeclaration;
  destinationDappId: string;
  destinationAction: CodeAppBindingDeclaration;
  fieldMap?: Record<string, string>;
  approvedBy?: string;
}, doc: Y.Doc = getRootDoc()): DirectBinding {
  const map = bindingsMap(doc);
  if (map.size >= MAX_DIRECT_BINDINGS) throw new Error(`Direct bindings are limited to ${MAX_DIRECT_BINDINGS}.`);
  for (const binding of map.values()) {
    if (binding.sourceDappId === input.sourceDappId && binding.sourceEvent.id === input.sourceEvent.id
      && binding.destinationDappId === input.destinationDappId && binding.destinationAction.id === input.destinationAction.id) {
      throw new Error('This direct binding is already approved.');
    }
  }
  const now = new Date().toISOString();
  const binding: DirectBinding = {
    id: crypto.randomUUID(),
    sourceDappId: input.sourceDappId,
    destinationDappId: input.destinationDappId,
    sourceEvent: { ...input.sourceEvent },
    destinationAction: { ...input.destinationAction },
    sourceFingerprint: fingerprintBindingDeclaration(input.sourceEvent),
    destinationFingerprint: fingerprintBindingDeclaration(input.destinationAction),
    fieldMap: input.fieldMap ?? {},
    status: 'active',
    approvedBy: input.approvedBy ?? 'local-device',
    createdAt: now,
    updatedAt: now,
  };
  map.set(binding.id, binding);
  return binding;
}

export function setDirectBindingStatus(id: string, status: DirectBindingStatus, reason?: string, doc: Y.Doc = getRootDoc()): void {
  const map = bindingsMap(doc);
  const current = map.get(id);
  if (!current) throw new Error('Direct binding not found.');
  map.set(id, { ...current, status, statusReason: reason, updatedAt: new Date().toISOString() });
}

export function pauseDirectBinding(id: string, doc?: Y.Doc): void { setDirectBindingStatus(id, 'paused', undefined, doc); }
export function resumeDirectBinding(id: string, doc?: Y.Doc): void { setDirectBindingStatus(id, 'active', undefined, doc); }

export function deleteDirectBinding(id: string, doc: Y.Doc = getRootDoc()): void {
  doc.transact(() => {
    bindingsMap(doc).delete(id);
    const deliveries = deliveriesMap(doc);
    for (const [deliveryId, delivery] of deliveries) if (delivery.bindingId === id) deliveries.delete(deliveryId);
  }, 'delete-direct-binding');
}

export function listDirectDeliveries(doc: Y.Doc = getRootDoc()): DirectDelivery[] {
  return [...deliveriesMap(doc).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Keeps bounded delivery history without ever evicting pending work. */
export function pruneDeliveredDirectDeliveries(maxHistory = 100, doc: Y.Doc = getRootDoc()): void {
  const delivered = listDirectDeliveries(doc).filter(({ status }) => status === 'delivered');
  const removeCount = Math.max(0, delivered.length - maxHistory);
  if (removeCount === 0) return;
  const map = deliveriesMap(doc);
  doc.transact(() => delivered.slice(0, removeCount).forEach(({ id }) => map.delete(id)), 'prune-direct-deliveries');
}

export function enqueueDirectDelivery(delivery: Omit<DirectDelivery, 'status' | 'attempts' | 'createdAt' | 'updatedAt' | 'nextAttemptAt'>, doc: Y.Doc = getRootDoc()): DirectDelivery {
  const map = deliveriesMap(doc);
  const existing = map.get(delivery.id);
  if (existing) return existing;
  pruneDeliveredDirectDeliveries(100, doc);
  if (map.size >= MAX_DIRECT_DELIVERIES) throw new Error(`Direct delivery queue is limited to ${MAX_DIRECT_DELIVERIES}.`);
  const now = new Date().toISOString();
  const stored: DirectDelivery = { ...delivery, status: 'pending', attempts: 0, createdAt: now, updatedAt: now, nextAttemptAt: now };
  map.set(stored.id, stored);
  return stored;
}

export function updateDirectDelivery(id: string, update: Partial<DirectDelivery>, doc: Y.Doc = getRootDoc()): DirectDelivery | null {
  const map = deliveriesMap(doc);
  const current = map.get(id);
  if (!current) return null;
  const next = { ...current, ...update, id: current.id, updatedAt: new Date().toISOString() };
  map.set(id, next);
  return next;
}

export function removeDirectBindingsForDapp(dappId: string, doc: Y.Doc = getRootDoc()): void {
  doc.transact(() => {
    const bindings = bindingsMap(doc);
    const removed = new Set<string>();
    for (const [id, binding] of bindings) {
      if (binding.sourceDappId === dappId || binding.destinationDappId === dappId) {
        removed.add(id);
        bindings.delete(id);
      }
    }
    const deliveries = deliveriesMap(doc);
    for (const [id, delivery] of deliveries) {
      if (removed.has(delivery.bindingId) || delivery.sourceDappId === dappId || delivery.destinationDappId === dappId) deliveries.delete(id);
    }
  }, 'purge-direct-bindings');
}
