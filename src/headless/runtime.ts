import * as Y from 'yjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  getRootDoc,
  getDappsList,
  getDappDoc,
  getDappSourceDoc,
  getDappCredentials,
  getDappBlobReplication,
  setDappBlobReplication,
  purgeDappLocalResources,
  setMeshAutoConnect,
  type BlobReplicationMode,
} from '../services/store/docs.ts';
import { joinDapp, addDappByCredentials, removeDappCatalogEntry } from '../services/store/config.ts';
import { leaveDappMembership } from '../services/store/members.ts';
import { keeperLeaveKind } from './leavePolicy.ts';
import { inviteUriFromText, isPairingInviteUri } from '../services/inviteLinks.ts';
import { addRecord, updateRecord, deleteRecord, getEntityRecords } from '../services/store/data.ts';
import {
  listAutomationRules,
  putAutomationRule,
  deleteAutomationRule,
  recordAutomationRun,
} from '../services/store/automations.ts';
import { runAutomationRule, dueCronRules, type AutomationHost } from '../automations/engine.ts';
import { parseCron } from '../automations/cron.ts';
import {
  ensureBlobChannel,
  destroyBlobChannel,
  replicateAllBlobs,
  syncDappStateFromPeers,
  getBlobChannelStatus,
} from '../services/blobRoomManager.ts';
import { getMeshPeerKeys } from '../services/meshPresence.ts';
import { watchSourceSeal } from '../services/store/sourceSeal.ts';
import { releaseBlobsOfDeletedFiles, sweepUnreferencedBlobs } from '../services/blobCleanup.ts';
import { blobHashesReferencedByAnyDapp } from '../services/store/blobReferences.ts';
import {
  confirmPendingAccessGrant, getPendingAccessGrant, refusePendingAccessGrant, setAccessGrantAutoConfirm,
} from '../services/store/pendingGrant.ts';
import { onVerifiedRecordsChange } from '../services/store/auth.ts';
import { FileDocPersistence } from './filePersistence.ts';
import { writeFileAtomic } from './atomicFile.ts';
import { installHeadlessDeviceStore, uninstallHeadlessDeviceStore, type FileDeviceStore } from './deviceStateFile.ts';
import { EventSink, type EventSinkStatus } from './eventSink.ts';
import { RecordEventFeed } from './recordEvents.ts';
import { LlmClient } from './llm.ts';
import { DappGenerator, loadCodeAppDocs } from './dappGenerator.ts';
import { RevisionStore } from './revisions.ts';
import { ControlDapp, loadControlDappFiles, type ControlDappInfo, type InviteResult } from './controlDapp.ts';
import { liveControlStore, type LobbyPeer } from './controlStore.ts';
import { patchHeadlessConfig, type LlmEndpointConfig, type N8nWebhookConfig } from './config.ts';
import type { AutomationRule, DeviceIdentity, MemberRole, RecordData } from '../types.ts';

/**
 * The always-on headless runtime ("keeper node", docs/HEADLESS.md): a full
 * dapp peer without a UI. It joins each dapp in its catalog exactly like a
 * browser device — same providers, same auth observer, same rekey observer,
 * same blob mesh — so every security invariant is enforced identically. On
 * top of the reused store stack it adds durable file persistence (the Node
 * stand-ins for localStorage/IndexedDB are volatile), pin-all blob
 * replication, and the first wired execution path for the automation engine.
 */

const EXECUTED_COMMANDS_FILE = 'executed-commands.json';
/** Last minute the cron ticker handled, so a restart across a rule's minute still fires it. */
const CRON_STATE_FILE = 'cron-state.json';
/** Events n8n has not accepted yet; survives restarts (eventSink.ts). */
const EVENT_QUEUE_FILE = 'event-queue.json';

/** Command ids the control dapp already started in earlier sessions (replay protection). */
async function readExecutedCommands(dataDir: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(dataDir, EXECUTED_COMMANDS_FILE), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return []; // first boot, or an unreadable file: the age check still bounds what can be replayed
  }
}

const AUTOMATION_TICK_MS = 20_000;
/** After sleep/suspend, fire at most this many missed cron minutes. */
const MAX_CRON_BACKLOG_MINUTES = 5;
const MAINTENANCE_INTERVAL_MS = 5 * 60_000;
/** Grace so a signed departure reaches connected members before the keeper drops out. */
const DEPARTURE_FLUSH_MS = 2000;

function heldGrant(dappId: string): DappStatus['pendingGrant'] {
  const grant = getPendingAccessGrant(dappId);
  return grant ? { approvedBy: grant.approvedBy, approverName: grant.approverName, code: grant.code } : null;
}

interface DappStatus {
  id: string;
  name: string;
  icon: string;
  joinMethod: string;
  /** False while a lobby join still waits for owner approval. */
  hasCredentials: boolean;
  role: MemberRole | null;
  memberCount: number;
  /** Other member devices with a verified, ready session in the dapp's member mesh. */
  connectedPeers: number;
  blob: ReturnType<typeof getBlobChannelStatus>;
  blobReplication: string;
  /**
   * An approval this keeper holds but has not used: it was signed by a device that is not
   * one of its operators, so a person has to confirm it (`decideGrant`) — see pendingGrant.ts.
   */
  pendingGrant: { approvedBy: string; approverName: string; code: string } | null;
}

export interface RuntimeStatus {
  identity: { publicKey: string; displayName: string; deviceId: string };
  startedAt: string;
  signalingUrls: string[];
  dapps: DappStatus[];
  automations: AutomationRule[];
  integrations: {
    /** OpenAI-compatible endpoint (key never reported); `model` is null until one is selected. */
    llm: { baseUrl: string; model: string | null } | null;
    /** Outbound record events to n8n. */
    n8n: EventSinkStatus | null;
  };
}

interface HeadlessRuntimeOptions {
  dataDir: string;
  identity: DeviceIdentity;
  signalingUrls: string[];
  replicateFiles: boolean;
  llm?: LlmEndpointConfig;
  n8n?: N8nWebhookConfig;
  appUrl?: string;
  controlDappId?: string;
}

export class HeadlessRuntime {
  private readonly options: HeadlessRuntimeOptions;
  private readonly startedAt = new Date().toISOString();
  private readonly persistences = new Map<string, FileDocPersistence>();
  private readonly connectedDapps = new Set<string>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastCronMinute: number;
  private automationRunning = false;
  private readonly eventSink: EventSink | null;
  private readonly eventFeed: RecordEventFeed | null;
  /** Present when an LLM endpoint is configured; the only way keeper code talks to a model. */
  readonly llm: LlmClient | null;
  private controlDapp: ControlDapp | null = null;
  /** Device-local keys (founder pin, verified member baseline) on disk instead of volatile localStorage. */
  private deviceStore: FileDeviceStore | null = null;
  private stopReleasingDeletedFiles: (() => void) | null = null;

  constructor(options: HeadlessRuntimeOptions) {
    this.options = options;
    this.lastCronMinute = Math.floor(Date.now() / 60_000);
    this.llm = options.llm ? new LlmClient(options.llm) : null;
    this.eventSink = options.n8n ? new EventSink({ ...options.n8n, queueFile: path.join(options.dataDir, EVENT_QUEUE_FILE) }) : null;
    const sink = this.eventSink;
    this.eventFeed = sink
      ? new RecordEventFeed({
          dataDir: options.dataDir,
          subscribe: onVerifiedRecordsChange,
          dappName: (dappId) => this.dappName(dappId),
          emit: (event) => { sink.post(event); },
        })
      : null;
  }

  private aiAccess(llm: LlmClient) {
    const apiKey = this.options.llm?.apiKey ?? '';
    return {
      llm,
      generator: new DappGenerator({ llm, docs: loadCodeAppDocs, log: (line) => { console.log(line); } }),
      revisions: new RevisionStore(this.options.dataDir),
      persistModel: (model: string) => patchHeadlessConfig(this.options.dataDir, { llm: { baseUrl: llm.baseUrl, apiKey, model } }),
    };
  }

  private dappName(dappId: string): string {
    const list = getDappsList();
    for (let i = 0; i < list.length; i++) {
      const item = list.get(i);
      if (item.get('id') === dappId) return item.get('name') ?? 'Unnamed Dapp';
    }
    return 'Unnamed Dapp';
  }

  private docDir(name: string): string {
    return path.join(this.options.dataDir, 'docs', name);
  }

  /** True for the keeper's own control dapp — known from config at boot, from the manager once it exists. */
  private isControlDapp(dappId: string): boolean {
    return dappId === (this.controlDapp?.id ?? this.options.controlDappId);
  }

  private async attachPersistence(name: string, doc: Y.Doc, options: { critical?: boolean } = {}): Promise<void> {
    // Every caller waits for the SAME load. Returning early for the second one let the mesh
    // start on an empty document: the first pull asked for everything, and the restore from
    // disk was then broadcast to every member as if it were a fresh local change.
    let persistence = this.persistences.get(name);
    if (!persistence) {
      persistence = new FileDocPersistence(this.docDir(name), doc, options);
      this.persistences.set(name, persistence);
    }
    await persistence.whenLoaded;
  }

  async start(): Promise<void> {
    // Before any document is loaded: the auth observer reads the founder pin and this device's
    // verified member baseline from here, and on Node localStorage is volatile (deviceStateFile.ts).
    this.deviceStore = await installHeadlessDeviceStore(this.options.dataDir);
    // The keeper connects each dapp's member mesh itself, AFTER file persistence
    // has loaded the doc — otherwise the first pull would re-fetch everything on disk.
    setMeshAutoConnect(false);
    // Nobody sits in front of a keeper to compare codes. An approval by one of its operators
    // (an owner of the control dapp — a key this keeper already trusts) is used at once; any
    // other approval is held and shows up in the status until someone decides (decideGrant).
    setAccessGrantAutoConfirm((_dappId, approvedBy) => this.controlDapp?.isOperatorKey(approvedBy) ?? false);
    // Root doc first: the catalog in it decides which dapps to connect.
    // Critical: a root snapshot that does not decode stops the boot instead of being
    // compacted over — it holds every credential and rule and no peer can re-deliver it.
    await this.attachPersistence('root', getRootDoc(), { critical: true });
    await this.restoreCronMinute();

    // Content of a file another member deleted stops being pinned here (blobCleanup.ts).
    this.stopReleasingDeletedFiles = releaseBlobsOfDeletedFiles();
    const list = getDappsList();
    list.observeDeep(() => { this.syncDapps().catch((error: unknown) => console.error('connecting catalog dapps failed', error)); });
    await this.syncDapps();

    this.timers.push(setInterval(() => {
      this.automationTick().catch((error: unknown) => console.error('automation tick failed', error));
    }, AUTOMATION_TICK_MS));
    this.timers.push(setInterval(() => { void this.maintenanceSweep(); }, MAINTENANCE_INTERVAL_MS));
    void this.maintenanceSweep();

    // A control dapp created in an earlier session is watched from boot; a
    // missing one is only created when the dashboard asks for it.
    if (this.options.controlDappId) (await this.control()).start();
  }

  /** Lazily builds the control-dapp manager (loads its source bundle once). */
  private async control(): Promise<ControlDapp> {
    this.controlDapp ??= new ControlDapp({
      store: liveControlStore,
      keeper: this,
      identity: { publicKey: this.options.identity.publicKey, displayName: this.options.identity.displayName },
      files: await loadControlDappFiles(),
      ...(this.options.controlDappId ? { controlDappId: this.options.controlDappId } : {}),
      ...(this.options.appUrl ? { appUrl: this.options.appUrl } : {}),
      ...(this.llm ? { ai: this.aiAccess(this.llm) } : {}),
      persistControlDappId: (id) => patchHeadlessConfig(this.options.dataDir, { controlDappId: id }),
      executedCommandIds: await readExecutedCommands(this.options.dataDir),
      persistExecutedCommands: (ids) => writeFileAtomic(path.join(this.options.dataDir, EXECUTED_COMMANDS_FILE), `${JSON.stringify(ids)}\n`, { mode: 0o600 }),
    });
    return this.controlDapp;
  }

  async stop(): Promise<void> {
    this.timers.forEach((timer) => clearInterval(timer));
    this.timers = [];
    this.stopReleasingDeletedFiles?.();
    this.stopReleasingDeletedFiles = null;
    this.controlDapp?.stop();
    await this.eventSink?.stop();
    await this.eventFeed?.stop();
    for (const persistence of this.persistences.values()) await persistence.destroy();
    this.persistences.clear();
    await this.deviceStore?.whenIdle();
    this.deviceStore = null;
    uninstallHeadlessDeviceStore();
  }

  private syncing: Promise<void> | null = null;
  private syncAgain = false;

  /**
   * Connect every catalog dapp; idempotent, re-run on catalog changes (also picks up
   * credentials granted after a lobby join). One run at a time: the catalog observer fires
   * during boot, and a second pass racing the first connected dapps half-way through their
   * setup. A change that arrives meanwhile causes exactly one more pass.
   */
  private syncDapps(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      // Suspend before the first pass: an async function body runs synchronously up to its
      // first await, so with an EMPTY catalog the whole body — `finally` included — used to
      // run before the assignment below, leaving `this.syncing` set for ever. Every later
      // pass then returned early and a dapp joined after the boot was never connected.
      await Promise.resolve();
      try {
        do {
          this.syncAgain = false;
          const list = getDappsList();
          for (let i = 0; i < list.length; i++) {
            const id = list.get(i).get('id');
            if (id) await this.connectDapp(id);
          }
        } while (this.syncAgain);
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  private async connectDapp(dappId: string): Promise<void> {
    const doc = getDappDoc(dappId); // creates providers, auth observer, rekey observer
    await this.attachPersistence(`dapp-${dappId}`, doc);

    const { roomId } = getDappCredentials(dappId);
    if (!roomId) return; // lobby join still pending owner approval

    // The control dapp is keeper-internal chatter (status heartbeat, commands, invite
    // links, connection codes) — not for n8n. On boot the dapps connect BEFORE the
    // control manager instance exists, so the configured id has to count as well;
    // without it every restart fed the control dapp to the webhook.
    if (!this.isControlDapp(dappId)) await this.eventFeed?.attach(dappId);
    const sourceDoc = getDappSourceDoc(dappId);
    await this.attachPersistence(`dapp-${dappId}-source`, sourceDoc);

    if (this.options.replicateFiles && getDappBlobReplication(dappId) !== 'pinAll') {
      setDappBlobReplication(dappId, 'pinAll');
    }
    await ensureBlobChannel(dappId);
    // An always-on owner is the natural guard of the Code App source: it keeps the last
    // owner-sealed version in memory and puts it back when a member rewrites the code.
    watchSourceSeal(dappId);

    if (!this.connectedDapps.has(dappId)) {
      this.connectedDapps.add(dappId);
      // Catch-up pull from every member already connected (each new session
      // pulls by itself as well). Fire-and-forget on connect.
      void syncDappStateFromPeers(dappId).catch(() => undefined);
    }
  }

  private async maintenanceSweep(): Promise<void> {
    for (const dappId of this.connectedDapps) {
      try {
        await ensureBlobChannel(dappId);
        await syncDappStateFromPeers(dappId);
        await replicateAllBlobs(dappId);
      } catch (error) {
        console.error(`maintenance sweep failed for dapp ${dappId}`, error);
      }
    }
    await this.sweepUnreferencedBlobs();
    // Secondary push sender: re-tickle contacts with still-pending outbound
    // share offers (no-op unless this keeper holds relationship state).
    try {
      const { sendPendingShareTickles } = await import('./pushSender.ts');
      await sendPendingShareTickles();
    } catch (error) {
      console.error('push tickle sweep failed', error);
    }
  }

  /**
   * Deletes stored content no catalog dapp lists any more — deletions this keeper
   * missed while it was down included. Only once EVERY catalog dapp is connected
   * (its document loaded from disk): a document still loading lists nothing, and
   * its content would be deleted with the rest.
   */
  private async sweepUnreferencedBlobs(): Promise<void> {
    try {
      const list = getDappsList();
      for (let i = 0; i < list.length; i++) {
        const id = list.get(i).get('id');
        if (id && !this.connectedDapps.has(id)) return;
      }
      const released = await sweepUnreferencedBlobs(await blobHashesReferencedByAnyDapp());
      if (released.length > 0) console.log(`released ${released.length} stored file(s) no dapp lists any more`);
    } catch (error) {
      console.error('unreferenced file sweep failed', error);
    }
  }

  // ───── Automations ─────

  private automationHost(): AutomationHost {
    return {
      createRecord: async (dappId, collection, data) => {
        await addRecord(dappId, collection, { id: crypto.randomUUID(), ...data });
      },
      updateRecord: async (dappId, collection, recordId, data) => {
        await updateRecord(dappId, collection, recordId, data);
      },
      now: () => new Date(),
    };
  }

  /** Only ever moves the ticker back: a stored minute in the future (clock change) is ignored. */
  private async restoreCronMinute(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(this.options.dataDir, CRON_STATE_FILE), 'utf8')) as { lastMinute?: unknown };
      if (typeof parsed.lastMinute === 'number' && Number.isInteger(parsed.lastMinute) && parsed.lastMinute < this.lastCronMinute) {
        this.lastCronMinute = parsed.lastMinute;
      }
    } catch {
      // first boot or unreadable: start from the current minute
    }
  }

  private async automationTick(): Promise<void> {
    if (this.automationRunning) return;
    this.automationRunning = true;
    try {
      const nowMinute = Math.floor(Date.now() / 60_000);
      if (nowMinute <= this.lastCronMinute) return;
      const firstMinute = Math.max(this.lastCronMinute + 1, nowMinute - MAX_CRON_BACKLOG_MINUTES + 1);
      this.lastCronMinute = nowMinute;
      await writeFileAtomic(path.join(this.options.dataDir, CRON_STATE_FILE), `${JSON.stringify({ lastMinute: nowMinute })}\n`)
        .catch((error: unknown) => console.error('could not store the cron state', error));
      for (let minute = firstMinute; minute <= nowMinute; minute++) {
        const fireTime = new Date(minute * 60_000);
        for (const rule of dueCronRules(listAutomationRules(), fireTime)) {
          await this.runRule(rule, fireTime);
        }
      }
    } finally {
      this.automationRunning = false;
    }
  }

  private async runRule(rule: AutomationRule, fireTime: Date): Promise<void> {
    try {
      const report = await runAutomationRule(rule, {
        trigger: { kind: 'cron', firedAt: fireTime.toISOString() },
      }, this.automationHost());
      const failed = report.results.filter((entry) => !entry.ok);
      recordAutomationRun(rule.id, {
        at: fireTime.toISOString(),
        ...(failed.length > 0 ? { error: failed.map((entry) => `step ${entry.stepIndex}: ${entry.error ?? 'failed'}`).join('; ') } : {}),
      });
    } catch (error) {
      recordAutomationRun(rule.id, {
        at: fireTime.toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ───── Control-surface operations ─────

  status(): RuntimeStatus {
    const list = getDappsList();
    const dapps: DappStatus[] = [];
    for (let i = 0; i < list.length; i++) {
      const item = list.get(i);
      const id = item.get('id');
      if (!id) continue;
      const { roomId } = getDappCredentials(id);
      const doc = getDappDoc(id);
      const members = doc.getMap('members');
      const member = members.get(this.options.identity.publicKey) as Y.Map<unknown> | undefined;
      dapps.push({
        id,
        name: item.get('name') ?? 'Unnamed Dapp',
        icon: item.get('icon') ?? '📦',
        joinMethod: item.get('joinMethod') ?? 'unknown',
        hasCredentials: Boolean(roomId),
        role: (member?.get('role') as DappStatus['role'] | undefined) ?? null,
        memberCount: members.size,
        connectedPeers: getMeshPeerKeys(id).length,
        blob: getBlobChannelStatus(id),
        blobReplication: getDappBlobReplication(id),
        pendingGrant: heldGrant(id),
      });
    }
    return {
      identity: {
        publicKey: this.options.identity.publicKey,
        displayName: this.options.identity.displayName,
        deviceId: this.options.identity.deviceId,
      },
      startedAt: this.startedAt,
      signalingUrls: this.options.signalingUrls,
      dapps,
      automations: listAutomationRules(),
      integrations: {
        llm: this.llm ? { baseUrl: this.llm.baseUrl, model: this.llm.model } : null,
        n8n: this.eventSink?.status() ?? null,
      },
    };
  }

  /**
   * Join via anything the browser UI accepts: a clickable https invite link
   * (`https://…/invite#code=…`, older `?code=` links too) or a `dapp://invite/app/...` code. Contact
   * pairing is browser-only for now.
   */
  async join(inviteText: string): Promise<string> {
    const uri = inviteUriFromText(inviteText) ?? inviteText.trim();
    if (isPairingInviteUri(uri)) {
      throw new Error('this is a contact pairing invite — the keeper only joins dapps; pair contacts from a browser device');
    }
    const id = joinDapp(uri);
    await this.connectDapp(id);
    return id;
  }

  /** Direct add with known room credentials (agent/tooling path, no invite URI form — the keeper reads but stays unsigned until an owner admits it). */
  async addByCredentials(roomId: string, roomPassword: string): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{2,200}$/.test(roomId)) throw new Error('invalid roomId');
    if (!/^[A-Za-z0-9_-]{8,256}$/.test(roomPassword)) throw new Error('invalid roomPassword');
    const id = addDappByCredentials(roomId, roomPassword);
    await this.connectDapp(id);
    return id;
  }

  /**
   * Drop a dapp from the keeper. A member says goodbye first (signed departure,
   * like "Leave dapp" in the browser) so the others stop listing it. A dapp the
   * keeper FOUNDED is refused: the founding owner cannot leave, so dropping the
   * local copy would leave the keeper a member everywhere else while it holds
   * nothing — pass `dropFounded` to do that on purpose (another owner can let
   * the keeper back in later through an invite).
   */
  async removeDapp(dappId: string, options: { dropFounded?: boolean } = {}): Promise<boolean> {
    const { roomId } = getDappCredentials(dappId);
    if (roomId) {
      const doc = getDappDoc(dappId);
      const kind = keeperLeaveKind(doc, this.options.identity.publicKey);
      if (kind === 'founder' && !options.dropFounded) {
        throw new Error('the keeper founded this dapp and cannot leave it — it would stay a member that holds no data. Send "dropFounded": true to drop its local copy anyway.');
      }
      if (kind === 'member') {
        try {
          await leaveDappMembership(dappId, doc);
          await new Promise((resolve) => setTimeout(resolve, DEPARTURE_FLUSH_MS));
        } catch (error) {
          console.error(`leaving dapp ${dappId}: could not announce the departure`, error);
        }
      }
    }
    if (!removeDappCatalogEntry(dappId)) return false;
    this.connectedDapps.delete(dappId);
    this.eventFeed?.detach(dappId);
    destroyBlobChannel(dappId);
    for (const name of [`dapp-${dappId}`, `dapp-${dappId}-source`]) {
      const persistence = this.persistences.get(name);
      if (persistence) {
        await persistence.destroy();
        this.persistences.delete(name);
      }
      await fs.rm(this.docDir(name), { recursive: true, force: true });
    }
    await purgeDappLocalResources(dappId);
    return true;
  }

  listRecords(dappId: string, entityId: string): RecordData[] | undefined {
    return getEntityRecords(dappId, entityId);
  }

  listEntities(dappId: string): Array<{ id: string; name: string; recordCount: number }> {
    const doc = getDappDoc(dappId);
    const schema = doc.getMap('config').get('schema') as Y.Map<unknown> | undefined;
    const entities = schema?.get('entities') as Y.Map<Y.Map<unknown>> | undefined;
    const result: Array<{ id: string; name: string; recordCount: number }> = [];
    entities?.forEach((entity, id) => {
      const name = entity.get('name');
      result.push({
        id,
        name: typeof name === 'string' && name ? name : id,
        recordCount: getEntityRecords(dappId, id)?.length ?? 0,
      });
    });
    return result;
  }

  async createRecord(dappId: string, entityId: string, data: Record<string, unknown>): Promise<string> {
    const id = typeof data.id === 'string' && data.id ? data.id : crypto.randomUUID();
    await addRecord(dappId, entityId, { ...data, id });
    return id;
  }

  async updateRecordFields(dappId: string, entityId: string, recordId: string, data: Record<string, unknown>): Promise<void> {
    await updateRecord(dappId, entityId, recordId, data);
  }

  async deleteRecordById(dappId: string, entityId: string, recordId: string): Promise<void> {
    await deleteRecord(dappId, entityId, recordId);
  }

  async setReplication(dappId: string, mode: BlobReplicationMode): Promise<void> {
    if (!this.connectedDapps.has(dappId)) throw new Error('unknown or not yet connected dapp');
    setDappBlobReplication(dappId, mode);
    if (mode === 'pinAll') await replicateAllBlobs(dappId);
  }

  async runRuleNow(ruleId: string): Promise<void> {
    const rule = listAutomationRules().find((entry) => entry.id === ruleId);
    if (!rule) throw new Error('unknown rule');
    await this.runRule(rule, new Date());
  }

  // ───── Control dapp ─────

  async controlDappInfo(): Promise<ControlDappInfo | null> {
    return (await this.control()).info();
  }

  async ensureControlDapp(): Promise<ControlDappInfo> {
    const control = await this.control();
    await control.ensure();
    const info = await control.info();
    if (!info) throw new Error('control dapp could not be created');
    return info;
  }

  async createInvite(dappId: string, uses: number): Promise<InviteResult> {
    return (await this.control()).createInvite(dappId, uses);
  }

  async lobby(dappId: string): Promise<LobbyPeer[]> {
    return (await this.control()).lobby(dappId);
  }

  async approveDevice(dappId: string, publicKey: string, role: MemberRole): Promise<LobbyPeer> {
    return (await this.control()).approveDevice(dappId, publicKey, role);
  }

  /** Use (or refuse) an approval the keeper holds for a dapp it is joining. False when it holds none. */
  decideGrant(dappId: string, accept: boolean): boolean {
    return accept ? confirmPendingAccessGrant(dappId) : refusePendingAccessGrant(dappId);
  }

  listRules(): AutomationRule[] {
    return listAutomationRules();
  }

  putRule(rule: Omit<AutomationRule, 'schemaVersion' | 'createdAt' | 'updatedAt'>): AutomationRule {
    // The ticker skips a schedule it cannot parse, so a typo would mean "never fires" without a word.
    if (rule.trigger.kind === 'cron') parseCron(rule.trigger.schedule);
    return putAutomationRule(rule);
  }

  deleteRule(id: string): boolean {
    return deleteAutomationRule(id);
  }
}
