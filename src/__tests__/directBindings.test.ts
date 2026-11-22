import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  createDirectBinding,
  deleteDirectBinding,
  enqueueDirectDelivery,
  listDirectBindings,
  listDirectDeliveries,
  pauseDirectBinding,
  pruneDeliveredDirectDeliveries,
  removeDirectBindingsForDapp,
  resumeDirectBinding,
  updateDirectDelivery,
} from '../services/store/directBindings.ts';
import { DirectCodeBindingRuntime } from '../services/directCodeBindingRuntime.ts';

const event = { id: 'order.created', label: 'Order created', description: 'A new order' };
const action = { id: 'notify', label: 'Notify' };

describe('device-local direct binding store', () => {
  it('snapshots declarations and supports pause, resume, and durable Yjs persistence', () => {
    vi.stubGlobal('crypto', { ...crypto, randomUUID: () => 'binding-1' });
    const doc = new Y.Doc();
    const binding = createDirectBinding({ sourceDappId: 'source', sourceEvent: event, destinationDappId: 'destination', destinationAction: action }, doc);
    expect(binding.sourceEvent).toEqual(event);
    expect(binding.sourceFingerprint).toMatch(/^v1-/);
    pauseDirectBinding(binding.id, doc);
    expect(listDirectBindings(doc)[0].status).toBe('paused');
    resumeDirectBinding(binding.id, doc);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc));
    expect(listDirectBindings(restored)).toEqual(listDirectBindings(doc));
    vi.unstubAllGlobals();
  });

  it('enqueues stable delivery IDs idempotently and deletes binding deliveries', () => {
    vi.stubGlobal('crypto', { ...crypto, randomUUID: () => 'binding-2' });
    const doc = new Y.Doc();
    const binding = createDirectBinding({ sourceDappId: 'source', sourceEvent: event, destinationDappId: 'destination', destinationAction: action }, doc);
    const input = { id: 'delivery-stable', bindingId: binding.id, sourceDappId: 'source', eventId: event.id, destinationDappId: 'destination', actionId: action.id, payload: { value: 1 } };
    enqueueDirectDelivery(input, doc);
    enqueueDirectDelivery({ ...input, payload: { value: 2 } }, doc);
    expect(listDirectDeliveries(doc)).toHaveLength(1);
    expect(listDirectDeliveries(doc)[0].payload).toEqual({ value: 1 });
    deleteDirectBinding(binding.id, doc);
    expect(listDirectDeliveries(doc)).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('removes every related approval and delivery during Dapp cleanup', () => {
    let id = 0;
    vi.stubGlobal('crypto', { ...crypto, randomUUID: () => `id-${++id}` });
    const doc = new Y.Doc();
    const related = createDirectBinding({ sourceDappId: 'deleted', sourceEvent: event, destinationDappId: 'destination', destinationAction: action }, doc);
    createDirectBinding({ sourceDappId: 'other', sourceEvent: event, destinationDappId: 'destination', destinationAction: action }, doc);
    enqueueDirectDelivery({ id: 'delivery', bindingId: related.id, sourceDappId: 'deleted', eventId: event.id, destinationDappId: 'destination', actionId: action.id, payload: null }, doc);
    removeDirectBindingsForDapp('deleted', doc);
    expect(listDirectBindings(doc).map(({ sourceDappId }) => sourceDappId)).toEqual(['other']);
    expect(listDirectDeliveries(doc)).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('delivers at least once with a stable id and does not redeliver after success', async () => {
    let sequence = 0;
    vi.stubGlobal('crypto', { ...crypto, randomUUID: () => `runtime-${++sequence}` });
    const doc = new Y.Doc();
    createDirectBinding({ sourceDappId: 'source', sourceEvent: event, destinationDappId: 'destination', destinationAction: action }, doc);
    const resolve = (dappId: string, kind: 'events' | 'actions', endpointId: string) => {
      if (dappId === 'source' && kind === 'events' && endpointId === event.id) return event;
      if (dappId === 'destination' && kind === 'actions' && endpointId === action.id) return action;
      return null;
    };
    const runtime = new DirectCodeBindingRuntime(doc, resolve);
    await runtime.initialize();
    const seen: string[] = [];
    runtime.registerActionRuntime('destination', 'iframe-1', action.id, (delivery) => {
      seen.push(delivery.id);
      return Promise.resolve();
    });
    const published = await runtime.publishDirectEvent('source', event.id, { mealId: 'm-1' });
    await runtime.dispatchPending();
    expect(seen).toEqual(published.deliveryIds);
    expect(listDirectDeliveries(doc)[0]).toMatchObject({ status: 'delivered', attempts: 1 });
    await runtime.dispatchPending();
    expect(seen).toHaveLength(1);
    runtime.dispose();
    vi.unstubAllGlobals();
  });

  it('retries failed actions with the same delivery id', async () => {
    let sequence = 0;
    vi.stubGlobal('crypto', { ...crypto, randomUUID: () => `retry-${++sequence}` });
    const doc = new Y.Doc();
    createDirectBinding({ sourceDappId: 'source', sourceEvent: event, destinationDappId: 'destination', destinationAction: action }, doc);
    const resolve = (dappId: string, kind: 'events' | 'actions', endpointId: string) => {
      if (dappId === 'source' && kind === 'events' && endpointId === event.id) return event;
      if (dappId === 'destination' && kind === 'actions' && endpointId === action.id) return action;
      return null;
    };
    const runtime = new DirectCodeBindingRuntime(doc, resolve);
    const seen: string[] = [];
    runtime.registerActionRuntime('destination', 'iframe-1', action.id, (delivery) => {
      seen.push(delivery.id);
      return seen.length === 1 ? Promise.reject(new Error('temporary failure')) : Promise.resolve();
    });
    const { deliveryIds } = await runtime.publishDirectEvent('source', event.id, { value: 1 });
    updateDirectDelivery(deliveryIds[0], { nextAttemptAt: new Date(0).toISOString() }, doc);
    await runtime.dispatchPending();
    expect(seen).toEqual([deliveryIds[0], deliveryIds[0]]);
    expect(listDirectDeliveries(doc)[0]).toMatchObject({ status: 'delivered', attempts: 2 });
    runtime.dispose();
    vi.unstubAllGlobals();
  });

  it('blocks delivery after either approved declaration changes', async () => {
    vi.stubGlobal('crypto', { ...crypto, randomUUID: () => 'changed-1' });
    const doc = new Y.Doc();
    createDirectBinding({ sourceDappId: 'source', sourceEvent: event, destinationDappId: 'destination', destinationAction: action }, doc);
    const changedAction = { ...action, label: 'Changed action' };
    const resolve = (_dappId: string, kind: 'events' | 'actions') => kind === 'events' ? event : changedAction;
    const runtime = new DirectCodeBindingRuntime(doc, resolve);
    const result = await runtime.publishDirectEvent('source', event.id, null);
    expect(result.deliveryIds).toEqual([]);
    expect(listDirectBindings(doc)[0]).toMatchObject({ status: 'blocked' });
    runtime.dispose();
    vi.unstubAllGlobals();
  });

  it('re-blocks a previously approved binding when the source payload schema changes', async () => {
    vi.stubGlobal('crypto', { ...crypto, randomUUID: () => 'payload-schema-1' });
    const doc = new Y.Doc();
    createDirectBinding({ sourceDappId: 'source', sourceEvent: event, destinationDappId: 'destination', destinationAction: action }, doc);
    const changedEvent = { ...event, payload: [{ name: 'x', type: 'string' as const }] };
    const resolve = (_dappId: string, kind: 'events' | 'actions') => kind === 'events' ? changedEvent : action;
    const runtime = new DirectCodeBindingRuntime(doc, resolve);
    const result = await runtime.publishDirectEvent('source', event.id, { x: 'hi' });
    expect(result.deliveryIds).toEqual([]);
    expect(listDirectBindings(doc)[0]).toMatchObject({ status: 'blocked' });
    runtime.dispose();
    vi.unstubAllGlobals();
  });

  it('projects and validates payload fields end-to-end through a field-mapped binding', async () => {
    vi.stubGlobal('crypto', { ...crypto, randomUUID: () => 'projected-1' });
    const doc = new Y.Doc();
    const typedEvent = { id: 'order.created', label: 'Order created', payload: [{ name: 'orderTitle', type: 'string' as const, required: true }] };
    const typedAction = { id: 'notify', label: 'Notify', payload: [{ name: 'title', type: 'string' as const, required: true }] };
    createDirectBinding({
      sourceDappId: 'source',
      sourceEvent: typedEvent,
      destinationDappId: 'destination',
      destinationAction: typedAction,
      fieldMap: { title: 'orderTitle' },
    }, doc);
    const resolve = (_dappId: string, kind: 'events' | 'actions') => kind === 'events' ? typedEvent : typedAction;
    const runtime = new DirectCodeBindingRuntime(doc, resolve);
    const seen: unknown[] = [];
    runtime.registerActionRuntime('destination', 'iframe-1', typedAction.id, (delivery) => {
      seen.push(delivery.payload);
      return Promise.resolve();
    });
    await runtime.publishDirectEvent('source', typedEvent.id, { orderTitle: 'Widget' });
    await runtime.dispatchPending();
    expect(seen).toEqual([{ title: 'Widget' }]);
    runtime.dispose();
    vi.unstubAllGlobals();
  });

  it('blocks a binding at dispatch time when the projected payload fails destination validation', async () => {
    vi.stubGlobal('crypto', { ...crypto, randomUUID: () => 'projected-invalid-1' });
    const doc = new Y.Doc();
    const typedEvent = { id: 'order.created', label: 'Order created', payload: [{ name: 'orderTitle', type: 'string' as const }] };
    const typedAction = { id: 'notify', label: 'Notify', payload: [{ name: 'title', type: 'string' as const, required: true }] };
    createDirectBinding({
      sourceDappId: 'source',
      sourceEvent: typedEvent,
      destinationDappId: 'destination',
      destinationAction: typedAction,
      fieldMap: {},
    }, doc);
    const resolve = (_dappId: string, kind: 'events' | 'actions') => kind === 'events' ? typedEvent : typedAction;
    const runtime = new DirectCodeBindingRuntime(doc, resolve);
    const result = await runtime.publishDirectEvent('source', typedEvent.id, {});
    expect(result.deliveryIds).toEqual([]);
    expect(listDirectBindings(doc)[0]).toMatchObject({ status: 'blocked' });
    runtime.dispose();
    vi.unstubAllGlobals();
  });

  it('prunes only completed delivery history', () => {
    const doc = new Y.Doc();
    const binding = createDirectBinding({ sourceDappId: 'source', sourceEvent: event, destinationDappId: 'destination', destinationAction: action }, doc);
    for (let index = 0; index < 102; index++) {
      enqueueDirectDelivery({ id: `done-${String(index).padStart(3, '0')}`, bindingId: binding.id, sourceDappId: 'source', eventId: event.id, destinationDappId: 'destination', actionId: action.id, payload: null }, doc);
      updateDirectDelivery(`done-${String(index).padStart(3, '0')}`, { status: 'delivered' }, doc);
    }
    enqueueDirectDelivery({ id: 'pending', bindingId: binding.id, sourceDappId: 'source', eventId: event.id, destinationDappId: 'destination', actionId: action.id, payload: null }, doc);
    pruneDeliveredDirectDeliveries(100, doc);
    expect(listDirectDeliveries(doc).filter(({ status }) => status === 'delivered')).toHaveLength(100);
    expect(listDirectDeliveries(doc).some(({ id }) => id === 'pending')).toBe(true);
  });
});
