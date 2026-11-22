import * as Y from 'yjs';
import { getIdentity } from './identity.ts';
import { parseCodeAppManifest } from './codeAppManifest.ts';
import { projectPayload, suggestFieldMap, validateFieldMap, validatePayload } from './bindingPayload.ts';
import { getRunnableCodeAppFile } from './store/sourceSeal.ts';
import {
  checkpointRootPersistence,
  getDappsList,
  getDappSourceDoc,
  getDappSourcePersistence,
  getRootDoc,
  getRootPersistence,
} from './store/docs.ts';
import {
  createDirectBinding,
  enqueueDirectDelivery,
  fingerprintBindingDeclaration,
  listDirectBindings,
  listDirectDeliveries,
  setDirectBindingStatus,
  updateDirectDelivery,
  type DirectBinding,
  type DirectDelivery,
} from './store/directBindings.ts';

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

type ActionInvoker = (delivery: DirectDelivery) => Promise<void>;
interface RegisteredAction { runtimeId: string; invoke: ActionInvoker }

function declarationFor(dappId: string, kind: 'events' | 'actions', endpointId: string) {
  const result = parseCodeAppManifest(getRunnableCodeAppFile(dappId, 'manifest.yaml')); // owner-sealed (sourceSeal.ts)
  if (result.error) return null;
  return result.manifest.bindings?.[kind]?.find(({ id }) => id === endpointId) ?? null;
}

type DeclarationResolver = typeof declarationFor;

function bindingDeclarationsUnchanged(binding: DirectBinding, resolveDeclaration: DeclarationResolver): boolean {
  const source = resolveDeclaration(binding.sourceDappId, 'events', binding.sourceEvent.id);
  const destination = resolveDeclaration(binding.destinationDappId, 'actions', binding.destinationAction.id);
  return !!source && !!destination
    && fingerprintBindingDeclaration(source) === binding.sourceFingerprint
    && fingerprintBindingDeclaration(destination) === binding.destinationFingerprint;
}

function getCatalogCodeDapp(dappId: string): { role: string } | null {
  for (const item of getDappsList()) {
    if (item.get('id') !== dappId) continue;
    return { role: String(item.get('role') || '') };
  }
  return null;
}

async function awaitCodeManifestReady(dappId: string): Promise<void> {
  getDappSourceDoc(dappId);
  await (getDappSourcePersistence(dappId)?.whenSynced ?? Promise.resolve());
}

/** Resolves both declarations from trusted local source documents before storing approval. */
export async function approveDirectCodeBinding(input: {
  sourceDappId: string;
  sourceEventId: string;
  destinationDappId: string;
  destinationActionId: string;
  fieldMap?: Record<string, string>;
}): Promise<DirectBinding> {
  await (getRootPersistence()?.whenSynced ?? Promise.resolve());
  const sourceCatalog = getCatalogCodeDapp(input.sourceDappId);
  const destinationCatalog = getCatalogCodeDapp(input.destinationDappId);
  if (!sourceCatalog || !destinationCatalog) throw new Error('Both endpoints must belong to local Code Apps.');
  if (destinationCatalog.role === 'viewer') throw new Error('Destination action approval requires editor or owner access.');
  await Promise.all([awaitCodeManifestReady(input.sourceDappId), awaitCodeManifestReady(input.destinationDappId)]);
  const sourceEvent = declarationFor(input.sourceDappId, 'events', input.sourceEventId);
  const destinationAction = declarationFor(input.destinationDappId, 'actions', input.destinationActionId);
  if (!sourceEvent || !destinationAction) throw new Error('The selected manifest endpoint is no longer declared.');
  const fieldMap = input.fieldMap ?? suggestFieldMap(sourceEvent.payload, destinationAction.payload);
  const fieldMapValidation = validateFieldMap(sourceEvent.payload, destinationAction.payload, fieldMap);
  if (!fieldMapValidation.ok) throw new Error(fieldMapValidation.error);
  const identity = getIdentity();
  if (!identity) throw new Error('A local identity is required to approve bindings.');
  const binding = createDirectBinding({
    sourceDappId: input.sourceDappId,
    sourceEvent,
    destinationDappId: input.destinationDappId,
    destinationAction,
    fieldMap,
    approvedBy: identity.publicKey,
  });
  await checkpointRootPersistence();
  return binding;
}

export class DirectCodeBindingRuntime {
  private readonly actions = new Map<string, RegisteredAction>();
  private readonly processing = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly doc: Y.Doc;
  private readonly resolveDeclaration: DeclarationResolver;
  private readonly persistentRoot: boolean;

  constructor(doc?: Y.Doc, resolveDeclaration: DeclarationResolver = declarationFor) {
    this.persistentRoot = doc === undefined;
    this.doc = doc ?? getRootDoc();
    this.resolveDeclaration = resolveDeclaration;
  }

  private async checkpoint(): Promise<void> {
    if (this.persistentRoot) await checkpointRootPersistence();
  }

  async initialize(): Promise<void> {
    await (this.persistentRoot ? getRootPersistence()?.whenSynced : Promise.resolve());
    for (const delivery of listDirectDeliveries(this.doc)) {
      if (delivery.status === 'delivering') updateDirectDelivery(delivery.id, { status: 'pending', nextAttemptAt: new Date().toISOString() }, this.doc);
    }
    await this.checkpoint();
    if (!this.timer) this.timer = setInterval(() => { void this.dispatchPending(); }, 1_000);
    await this.dispatchPending();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.actions.clear();
    this.processing.clear();
  }

  async publishDirectEvent(sourceDappId: string, eventId: string, payload: unknown): Promise<{ deliveryIds: string[] }> {
    const source = this.resolveDeclaration(sourceDappId, 'events', eventId);
    if (!source) throw new Error(`Undeclared Code App event: ${eventId}`);
    const validatedEvent = validatePayload(source.payload, payload);
    if (!validatedEvent.ok) throw new Error(validatedEvent.error);
    const normalizedPayload = validatedEvent.value;
    const deliveryIds: string[] = [];
    for (const binding of listDirectBindings(this.doc)) {
      if (binding.status !== 'active' || binding.sourceDappId !== sourceDappId || binding.sourceEvent.id !== eventId) continue;
      if (!bindingDeclarationsUnchanged(binding, this.resolveDeclaration)) {
        setDirectBindingStatus(binding.id, 'blocked', 'Manifest declaration changed; approval required again.', this.doc);
        continue;
      }
      const destination = this.resolveDeclaration(binding.destinationDappId, 'actions', binding.destinationAction.id);
      let deliveredPayload: unknown = normalizedPayload;
      if (destination?.payload) {
        const projected = projectPayload(binding.fieldMap ?? {}, normalizedPayload);
        const validatedAction = validatePayload(destination.payload, projected);
        if (!validatedAction.ok) {
          setDirectBindingStatus(binding.id, 'blocked', `Payload validation failed: ${validatedAction.error}`, this.doc);
          continue;
        }
        deliveredPayload = validatedAction.value;
      }
      const id = crypto.randomUUID();
      enqueueDirectDelivery({
        id,
        bindingId: binding.id,
        sourceDappId,
        eventId,
        destinationDappId: binding.destinationDappId,
        actionId: binding.destinationAction.id,
        payload: deliveredPayload,
      }, this.doc);
      deliveryIds.push(id);
    }
    // Publishing does not resolve until the complete fan-out is durably checkpointed.
    await this.checkpoint();
    await this.dispatchPending();
    return { deliveryIds };
  }

  registerActionRuntime(dappId: string, runtimeId: string, actionId: string, invoke: ActionInvoker): () => void {
    if (!this.resolveDeclaration(dappId, 'actions', actionId)) throw new Error(`Undeclared Code App action: ${actionId}`);
    const key = `${dappId}\u0000${actionId}`;
    this.actions.set(key, { runtimeId, invoke });
    void this.dispatchPending();
    return () => {
      const current = this.actions.get(key);
      if (current?.runtimeId === runtimeId) this.actions.delete(key);
    };
  }

  async dispatchPending(): Promise<void> {
    const now = Date.now();
    const pending = listDirectDeliveries(this.doc).filter((delivery) =>
      delivery.status !== 'delivered' && Date.parse(delivery.nextAttemptAt) <= now && !this.processing.has(delivery.id));
    await Promise.all(pending.map((delivery) => this.dispatchOne(delivery)));
  }

  private async dispatchOne(delivery: DirectDelivery): Promise<void> {
    const binding = listDirectBindings(this.doc).find(({ id }) => id === delivery.bindingId);
    if (!binding || binding.status !== 'active') return;
    if (this.persistentRoot) {
      const sourceCatalog = getCatalogCodeDapp(binding.sourceDappId);
      const destinationCatalog = getCatalogCodeDapp(binding.destinationDappId);
      if (!sourceCatalog || !destinationCatalog || destinationCatalog.role === 'viewer') {
        setDirectBindingStatus(binding.id, 'blocked', 'A bound Code App is missing or destination write access was revoked.', this.doc);
        await this.checkpoint();
        return;
      }
    }
    if (!bindingDeclarationsUnchanged(binding, this.resolveDeclaration)) {
      setDirectBindingStatus(binding.id, 'blocked', 'Manifest declaration changed; approval required again.', this.doc);
      await this.checkpoint();
      return;
    }
    const registered = this.actions.get(`${delivery.destinationDappId}\u0000${delivery.actionId}`);
    if (!registered) return; // Destination iframe must be open and have the exact action registered.
    this.processing.add(delivery.id);
    const attempts = delivery.attempts + 1;
    updateDirectDelivery(delivery.id, { status: 'delivering', attempts }, this.doc);
    try {
      await registered.invoke({ ...delivery, status: 'delivering', attempts });
      updateDirectDelivery(delivery.id, { status: 'delivered', lastError: undefined }, this.doc);
      await this.checkpoint();
    } catch (error) {
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 6)));
      const message = error instanceof Error ? error.message : String(error);
      updateDirectDelivery(delivery.id, {
        status: 'pending',
        lastError: message.slice(0, 512),
        nextAttemptAt: new Date(Date.now() + delay).toISOString(),
      }, this.doc);
      await this.checkpoint();
    } finally {
      this.processing.delete(delivery.id);
    }
  }
}

let globalRuntime: DirectCodeBindingRuntime | null = null;

export function initializeDirectCodeBindingRuntime(): () => void {
  if (!globalRuntime) {
    globalRuntime = new DirectCodeBindingRuntime();
    void globalRuntime.initialize();
  }
  return () => {
    globalRuntime?.dispose();
    globalRuntime = null;
  };
}

export function getDirectCodeBindingRuntime(): DirectCodeBindingRuntime {
  if (!globalRuntime) globalRuntime = new DirectCodeBindingRuntime();
  return globalRuntime;
}

