import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { VerifiedRecordsChange } from '../services/store/auth.ts';
import { inviteLinkFromUri } from '../services/inviteLinks.ts';
import type { BlobReplicationMode } from '../services/store/docs.ts';
import type { AutomationRule, MemberRole } from '../types.ts';
import type { ControlStore, LobbyPeer, OperatorDevice, PendingApproval } from './controlStore.ts';
import type { GenerateRequest, GeneratedDapp } from './dappGenerator.ts';
import type { RevisionSummary } from './revisions.ts';
import type { RuntimeStatus } from './runtime.ts';

/**
 * The "Keeper Control" dapp (docs/HEADLESS.md, "Control dapp"): a dapp the
 * keeper creates itself, owns, and watches. Operators — the dapp's other
 * owner devices — steer the keeper by writing `commands` records; the keeper
 * mirrors its status into the `keeper` record and executes commands whose
 * verified signer is an operator. That signer check (`_signedBy`, set by the
 * auth observer's verification, not the writer-claimed `createdBy`) is the
 * trust anchor: an editor member can chat, but cannot make the keeper act.
 *
 * Operators are also trusted as owners of every dapp the keeper owns: when
 * an operator device shows up in such a dapp's invite lobby it is approved
 * as owner without a safety-number ceremony — its key was verified once,
 * when it was admitted to the control dapp through the token-guarded
 * dashboard.
 */

export const CONTROL_DAPP_NAME = 'Keeper Control';
const CONTROL_DAPP_ICON = '🛰️';
const CONTROL_DAPP_COLOR = '#0ea5e9';
const STATUS_RECORD_ID = 'status';
const COMMANDS = 'commands';
const KEEPER = 'keeper';
const TICK_MS = 5_000;
const STATUS_INTERVAL_MS = 30_000;
const COMMAND_MAX_AGE_MS = 10 * 60_000;
/** Far more than ten minutes of commands; the age check covers everything older. */
const MAX_REMEMBERED_COMMANDS = 500;
const MODELS_REFRESH_MS = 5 * 60_000;
const MAX_PROMPT = 8_000;
const REPLICATION_MODES: readonly BlobReplicationMode[] = ['pinAll', 'onDemand'];
const MEMBER_ROLES: readonly MemberRole[] = ['owner', 'editor', 'viewer'];

/** What the control dapp needs from the runtime. */
export interface KeeperOps {
  status(): RuntimeStatus;
  join(invite: string): Promise<string>;
  removeDapp(dappId: string, options?: { dropFounded?: boolean }): Promise<boolean>;
  setReplication(dappId: string, mode: BlobReplicationMode): Promise<void>;
  decideGrant(dappId: string, accept: boolean): boolean;
  putRule(rule: Omit<AutomationRule, 'schemaVersion' | 'createdAt' | 'updatedAt'>): AutomationRule;
  deleteRule(id: string): boolean;
  runRuleNow(ruleId: string): Promise<void>;
}

/** Everything AI-related the control dapp needs; absent = AI commands fail with "not configured". */
export interface AiAccess {
  llm: { model: string | null; baseUrl: string; keyConfigured: boolean; listModels(): Promise<string[]> };
  generator: { generate(request: GenerateRequest): Promise<GeneratedDapp> };
  revisions: {
    save(dappId: string, files: Record<string, string>, note: string): Promise<string>;
    list(dappId: string): Promise<RevisionSummary[]>;
    load(dappId: string, id: string): Promise<Record<string, string>>;
  };
  persistModel(model: string): Promise<void>;
}

export interface ControlDappOptions {
  store: ControlStore;
  keeper: KeeperOps;
  identity: { publicKey: string; displayName: string };
  /** Source files of the control dapp (index.html, manifest.yaml, …). */
  files: Record<string, string>;
  controlDappId?: string;
  appUrl?: string;
  ai?: AiAccess;
  persistControlDappId: (id: string) => Promise<void>;
  /** Ids of commands an earlier session already started (see "Replay" at `onChange`). */
  executedCommandIds?: string[];
  /** Called with the full remembered list whenever a command starts; absent = memory of this session only. */
  persistExecutedCommands?: (ids: string[]) => Promise<void>;
  now?: () => Date;
  /** Tests drive `tick()` by hand. */
  timers?: boolean;
}

export interface ControlDappInfo {
  dappId: string;
  operators: OperatorDevice[];
  lobby: LobbyPeer[];
}

export interface InviteResult {
  uri: string;
  link: string | null;
}

interface CommandRecord {
  id: string;
  createdAt?: unknown;
  type?: unknown;
  args?: unknown;
  status?: unknown;
  _signedBy?: unknown;
}

type CommandArgs = Record<string, unknown>;

function argString(args: CommandArgs, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"${key}" (string) is required`);
  return value.trim();
}

function argPrompt(args: CommandArgs): string {
  const prompt = argString(args, 'prompt');
  if (prompt.length > MAX_PROMPT) throw new Error(`"prompt" must be at most ${MAX_PROMPT} characters`);
  return prompt;
}

function argRecord(args: CommandArgs, key: string): CommandArgs {
  const value = args[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`"${key}" (object) is required`);
  return value as CommandArgs;
}

/** Reads the control dapp's source bundle shipped next to this module. */
export async function loadControlDappFiles(): Promise<Record<string, string>> {
  const dir = fileURLToPath(new URL('./controlDapp/', import.meta.url));
  const files: Record<string, string> = {};
  for (const name of (await fs.readdir(dir)).sort()) {
    files[name] = await fs.readFile(`${dir}${name}`, 'utf8');
  }
  if (!files['index.html'] || !files['manifest.yaml']) throw new Error('control dapp: source bundle is incomplete');
  return files;
}

export class ControlDapp {
  private readonly options: ControlDappOptions;
  private dappId: string | null;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new Set<string>();
  /** Commands from non-operators, so the periodic reconcile logs each of them once. */
  private readonly ignoredCommands = new Set<string>();
  /** Insertion-ordered, capped — commands this keeper already started, across restarts. */
  private readonly executed: Set<string>;
  private lobbies = new Map<string, LobbyPeer[]>();
  /** Per pending (not yet approved) dapp: the code the approving owner must see — lets the operator rule out a man in the middle. */
  private pending = new Map<string, PendingApproval[]>();
  private revisions = new Map<string, RevisionSummary[]>();
  private models: string[] = [];
  private modelsError: string | null = null;
  private modelsAt = 0;
  private lastStatusJson = '';
  private lastStatusAt = 0;
  private ticking = false;

  constructor(options: ControlDappOptions) {
    this.options = options;
    this.executed = new Set(options.executedCommandIds ?? []);
    this.dappId = options.controlDappId && options.store.hasDapp(options.controlDappId) ? options.controlDappId : null;
  }

  get id(): string | null {
    return this.dappId;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Create the dapp on first use (idempotent) and start watching it. */
  async ensure(): Promise<string> {
    if (!this.dappId) {
      const { store, files } = this.options;
      this.dappId = store.createControlDapp(CONTROL_DAPP_NAME, CONTROL_DAPP_ICON, CONTROL_DAPP_COLOR, files);
      await this.options.persistControlDappId(this.dappId);
    }
    this.start();
    return this.dappId;
  }

  start(): void {
    if (!this.dappId || this.unsubscribe) return;
    const dappId = this.dappId;
    this.syncSource(dappId);
    this.unsubscribe = this.options.store.subscribe(dappId, (change) => { this.onChange(change); });
    if (this.options.timers !== false) {
      this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    }
    void this.tick();
  }

  /**
   * The shipped bundle is the control dapp's source of truth: a keeper
   * upgrade that changes the app is rolled out by replacing the files (the
   * keeper owns the dapp). Local edits made in the code editor are overwritten
   * on the next boot — by design; fork the bundle instead.
   */
  private syncSource(dappId: string): void {
    const { store, files } = this.options;
    try {
      const current = store.sourceFiles(dappId);
      if (JSON.stringify(current) === JSON.stringify(files)) return;
      store.replaceSource(dappId, files);
      console.log(`control dapp: source updated to the shipped bundle (${Object.keys(files).length} files)`);
    } catch (error) {
      console.error('control dapp: source sync failed', error);
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  operators(): OperatorDevice[] {
    return this.dappId ? this.options.store.owners(this.dappId, this.options.identity.publicKey) : [];
  }

  /** For the keeper's own joins: an approval signed by an operator needs no further confirmation. */
  isOperatorKey(publicKey: string): boolean {
    return this.isOperator(publicKey);
  }

  private isOperator(publicKey: unknown): boolean {
    return typeof publicKey === 'string' && this.operators().some((device) => device.publicKey === publicKey);
  }

  async info(): Promise<ControlDappInfo | null> {
    if (!this.dappId) return null;
    return { dappId: this.dappId, operators: this.operators(), lobby: await this.lobby(this.dappId) };
  }

  // ───── Operations shared by the dashboard API and the command handler ─────

  async createInvite(dappId: string, uses = 1): Promise<InviteResult> {
    if (!this.options.store.ownedDappIds(this.options.identity.publicKey).includes(dappId)) {
      throw new Error('the keeper can only invite to dapps it owns');
    }
    const uri = await this.options.store.createInvite(dappId, Math.max(1, Math.floor(uses)));
    return { uri, link: this.options.appUrl ? inviteLinkFromUri(uri, this.options.appUrl) : null };
  }

  lobby(dappId: string): Promise<LobbyPeer[]> {
    return this.options.store.lobbyPeers(dappId, this.options.identity.publicKey);
  }

  async approveDevice(dappId: string, publicKey: string, role: MemberRole): Promise<LobbyPeer> {
    if (!MEMBER_ROLES.includes(role)) throw new Error('role must be owner, editor or viewer');
    const peer = (await this.lobby(dappId)).find((entry) => entry.publicKey === publicKey);
    if (!peer) throw new Error('no such device is waiting in the lobby');
    await this.options.store.approve(dappId, peer, role);
    return peer;
  }

  // ───── Periodic work: lobby sweep (auto-owner for operators) + status mirror ─────

  /**
   * Commands the change feed never delivered: the dapps connect (and the auth
   * observer scans) before this manager subscribes at boot, so a command that
   * arrived in that window would stay `new` forever and one left `working` by
   * the previous session would never be marked failed. The verified set lags
   * the doc by one scan, so only commands whose live status still agrees with
   * it are taken — a command that just finished must not be judged by its
   * previous state.
   */
  private reconcileCommands(): void {
    if (!this.dappId) return;
    const { store } = this.options;
    const liveStatus = new Map(store.records(this.dappId, COMMANDS).map((entry) => [entry.id, entry.status]));
    const upserts = store.verifiedRecords(this.dappId).filter(({ entityId, record }) => entityId === COMMANDS
      && typeof record.id === 'string' && liveStatus.get(record.id) === record.status);
    if (upserts.length > 0) this.onChange({ upserts, deletes: [] });
  }

  async tick(): Promise<void> {
    if (this.ticking || !this.dappId) return;
    this.ticking = true;
    try {
      this.reconcileCommands();
      const lobbies = new Map<string, LobbyPeer[]>();
      for (const dappId of this.options.store.ownedDappIds(this.options.identity.publicKey)) {
        const waiting: LobbyPeer[] = [];
        for (const peer of await this.lobby(dappId)) {
          // A member asking to be let back in (rejoin) is never admitted automatically — an operator approves it.
          if (dappId !== this.dappId && this.isOperator(peer.publicKey) && !peer.rejoin) {
            try {
              await this.options.store.approve(dappId, peer, 'owner');
              console.log(`control dapp: admitted operator ${peer.publicKey.slice(0, 16)}… as owner of ${dappId}`);
              continue;
            } catch (error) {
              console.error(`control dapp: auto-approve of ${peer.publicKey.slice(0, 16)}… in ${dappId} failed`, error);
            }
          }
          waiting.push(peer);
        }
        if (waiting.length > 0) lobbies.set(dappId, waiting);
      }
      const pending = new Map<string, PendingApproval[]>();
      for (const dapp of this.options.keeper.status().dapps) {
        if (dapp.hasCredentials) continue;
        const approvals = await this.options.store.pendingApprovals(dapp.id, this.options.identity.publicKey);
        if (approvals.length > 0) pending.set(dapp.id, approvals);
      }
      const revisions = new Map<string, RevisionSummary[]>();
      if (this.options.ai) {
        for (const dappId of this.options.store.ownedDappIds(this.options.identity.publicKey)) {
          // Cheap per tick: RevisionStore serves this from memory until a save.
          const list = await this.options.ai.revisions.list(dappId);
          if (list.length > 0) revisions.set(dappId, list);
        }
      }
      if (this.now().getTime() - this.modelsAt >= MODELS_REFRESH_MS) await this.refreshModels();
      const changed = JSON.stringify([...lobbies]) !== JSON.stringify([...this.lobbies])
        || JSON.stringify([...pending]) !== JSON.stringify([...this.pending])
        || JSON.stringify([...revisions]) !== JSON.stringify([...this.revisions]);
      this.lobbies = lobbies;
      this.pending = pending;
      this.revisions = revisions;
      await this.writeStatus(changed);
    } catch (error) {
      console.error('control dapp: tick failed', error);
    } finally {
      this.ticking = false;
    }
  }

  private async refreshModels(): Promise<void> {
    this.modelsAt = this.now().getTime();
    if (!this.options.ai) return;
    try {
      this.models = await this.options.ai.llm.listModels();
      this.modelsError = null;
    } catch (error) {
      this.modelsError = error instanceof Error ? error.message : String(error);
    }
  }

  private buildStatus(): Record<string, unknown> {
    const status = this.options.keeper.status();
    return {
      id: STATUS_RECORD_ID,
      identity: { publicKey: status.identity.publicKey, displayName: status.identity.displayName },
      startedAt: status.startedAt,
      controlDappId: this.dappId,
      operators: this.operators(),
      dapps: status.dapps.map((dapp) => ({
        id: dapp.id,
        name: dapp.name,
        icon: dapp.icon,
        role: dapp.role,
        hasCredentials: dapp.hasCredentials,
        memberCount: dapp.memberCount,
        connectedPeers: dapp.connectedPeers,
        blobReplication: dapp.blobReplication,
        isControl: dapp.id === this.dappId,
        canEdit: dapp.role === 'owner' && dapp.id !== this.dappId,
        lobby: this.lobbies.get(dapp.id) ?? [],
        pendingApprovals: this.pending.get(dapp.id) ?? [],
        pendingGrant: dapp.pendingGrant,
        revisions: this.revisions.get(dapp.id) ?? [],
      })),
      automations: status.automations,
      integrations: {
        llm: this.options.ai
          ? {
              baseUrl: this.options.ai.llm.baseUrl,
              model: this.options.ai.llm.model,
              keyConfigured: this.options.ai.llm.keyConfigured,
              models: this.models,
              modelsError: this.modelsError,
            }
          : null,
        n8n: status.integrations.n8n,
      },
    };
  }

  private async writeStatus(force: boolean): Promise<void> {
    if (!this.dappId) return;
    const record = this.buildStatus();
    const json = JSON.stringify(record);
    const nowMs = this.now().getTime();
    // Changed content is written at once; unchanged content only refreshes the heartbeat every interval.
    if (!force && json === this.lastStatusJson && nowMs - this.lastStatusAt < STATUS_INTERVAL_MS) return;
    const data = { ...record, updatedAt: this.now().toISOString() };
    const { store } = this.options;
    const exists = store.records(this.dappId, KEEPER).some((entry) => entry.id === STATUS_RECORD_ID);
    if (exists) await store.updateRecord(this.dappId, KEEPER, STATUS_RECORD_ID, data);
    else await store.createRecord(this.dappId, KEEPER, data);
    this.lastStatusJson = json;
    this.lastStatusAt = nowMs;
  }

  // ───── Commands ─────

  // Replay: a command is an operator-signed record with status `new`, and the auth observer
  // accepts ANY validly signed version of a record. Whoever can write to this dapp (an editor
  // on a patched client) could put the operator's original `new` version of an old command
  // back — approve-device (re-admits a removed key), leave-dapp, create-dapp (LLM cost) would
  // run again. So a command runs once (ids remembered across restarts) and only while fresh.
  private replayReason(command: CommandRecord): string | null {
    if (this.executed.has(command.id)) return 'this command already ran — a repeated copy is ignored';
    const createdAt = typeof command.createdAt === 'string' ? Date.parse(command.createdAt) : NaN;
    if (!Number.isFinite(createdAt)) return 'the command carries no creation time';
    if (Math.abs(this.now().getTime() - createdAt) > COMMAND_MAX_AGE_MS) {
      return 'the command is older than 10 minutes (or the clocks of this keeper and your device disagree) — send it again';
    }
    return null;
  }

  private async remember(commandId: string): Promise<void> {
    this.executed.add(commandId);
    while (this.executed.size > MAX_REMEMBERED_COMMANDS) {
      const oldest = this.executed.values().next().value;
      if (oldest === undefined) break;
      this.executed.delete(oldest);
    }
    try {
      await this.options.persistExecutedCommands?.([...this.executed]);
    } catch (error) {
      console.error('control dapp: could not persist the executed-command list — replay protection covers this session only', error);
    }
  }

  private onChange(change: VerifiedRecordsChange): void {
    for (const { entityId, record } of change.upserts) {
      if (entityId !== COMMANDS || typeof record.id !== 'string') continue;
      const command = record as unknown as CommandRecord;
      if (command.status === 'new') {
        if (!this.isOperator(command._signedBy)) {
          if (!this.ignoredCommands.has(command.id)) console.warn(`control dapp: ignoring command ${command.id} — signer is not an operator`);
          this.ignoredCommands.add(command.id);
          continue;
        }
        if (this.inFlight.has(command.id)) continue;
        const refused = this.replayReason(command);
        if (refused) {
          console.warn(`control dapp: not running command ${command.id} — ${refused}`);
          void this.finish(command.id, { status: 'failed', error: `Not executed: ${refused}.` });
          continue;
        }
        void this.run(command);
      } else if (command.status === 'working' && command._signedBy === this.options.identity.publicKey && !this.inFlight.has(command.id)) {
        // Left over from a previous keeper session that died mid-command.
        void this.finish(command.id, { status: 'failed', error: 'keeper restarted while this command was running' });
      }
    }
  }

  private async run(command: CommandRecord): Promise<void> {
    if (!this.dappId || this.inFlight.has(command.id)) return;
    this.inFlight.add(command.id);
    try {
      await this.remember(command.id); // before anything runs: a crash mid-command must not make it repeatable
      await this.options.store.updateRecord(this.dappId, COMMANDS, command.id, { status: 'working' });
      const result = await this.execute(typeof command.type === 'string' ? command.type : '', (command.args ?? {}) as CommandArgs);
      await this.finish(command.id, { status: 'done', result });
    } catch (error) {
      await this.finish(command.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.inFlight.delete(command.id);
      void this.tick();
    }
  }

  private async finish(commandId: string, outcome: { status: 'done'; result: unknown } | { status: 'failed'; error: string }): Promise<void> {
    if (!this.dappId) return;
    try {
      await this.options.store.updateRecord(this.dappId, COMMANDS, commandId, { ...outcome, finishedAt: this.now().toISOString() });
    } catch (error) {
      console.error(`control dapp: could not record outcome of command ${commandId}`, error);
    }
  }

  private async execute(type: string, args: CommandArgs): Promise<unknown> {
    const { keeper } = this.options;
    switch (type) {
      case 'join-invite':
        return { dappId: await keeper.join(argString(args, 'invite')) };
      case 'confirm-join': {
        // The keeper holds an approval from a device that is not an operator; the operator
        // compared the code with the approving device and says whether to use it.
        const dappId = argString(args, 'dappId');
        const accept = args.accept !== false;
        if (!keeper.decideGrant(dappId, accept)) throw new Error('the keeper holds no approval for this dapp');
        return { dappId, joined: accept };
      }
      case 'leave-dapp': {
        const dappId = argString(args, 'dappId');
        if (args.confirm !== true) throw new Error('leave-dapp needs "confirm": true');
        if (dappId === this.dappId) throw new Error('the keeper cannot leave its own control dapp');
        return { removed: await keeper.removeDapp(dappId, { dropFounded: args.dropFounded === true }) };
      }
      case 'set-replication': {
        const mode = argString(args, 'mode') as BlobReplicationMode;
        if (!REPLICATION_MODES.includes(mode)) throw new Error('mode must be pinAll or onDemand');
        await keeper.setReplication(argString(args, 'dappId'), mode);
        return { mode };
      }
      case 'create-invite': {
        const uses = typeof args.uses === 'number' && Number.isFinite(args.uses) ? args.uses : 1;
        return this.createInvite(argString(args, 'dappId'), uses);
      }
      case 'approve-device': {
        const role = argString(args, 'role') as MemberRole;
        const peer = await this.approveDevice(argString(args, 'dappId'), argString(args, 'publicKey'), role);
        return { approved: peer.publicKey, displayName: peer.displayName, role };
      }
      case 'put-rule': {
        const rule = argRecord(args, 'rule');
        const stored = keeper.putRule({
          id: argString(rule, 'id'),
          name: argString(rule, 'name'),
          enabled: rule.enabled !== false,
          trigger: argRecord(rule, 'trigger') as unknown as AutomationRule['trigger'],
          steps: (Array.isArray(rule.steps) ? rule.steps : []) as AutomationRule['steps'],
        });
        return { rule: stored };
      }
      case 'delete-rule':
        return { deleted: keeper.deleteRule(argString(args, 'ruleId')) };
      case 'run-rule':
        await keeper.runRuleNow(argString(args, 'ruleId'));
        return { ran: true };
      case 'set-model':
        return this.setModel(argString(args, 'model'));
      case 'create-dapp':
        return this.createDapp(args);
      case 'update-dapp':
        return this.updateDapp(argString(args, 'dappId'), argPrompt(args));
      case 'revert-dapp':
        return this.revertDapp(argString(args, 'dappId'), argString(args, 'revision'));
      default:
        throw new Error(`unknown command type "${type}"`);
    }
  }

  // ───── AI: model selection, generation, revisions ─────

  private ai(): AiAccess {
    if (!this.options.ai) throw new Error('AI is not configured (LLM_BASE_URL/LLM_API_KEY)');
    return this.options.ai;
  }

  private async setModel(model: string): Promise<unknown> {
    const ai = this.ai();
    if (this.models.length === 0) await this.refreshModels();
    if (this.models.length > 0 && !this.models.includes(model)) {
      throw new Error(`unknown model "${model}" — the gateway offers: ${this.models.join(', ')}`);
    }
    ai.llm.model = model;
    await ai.persistModel(model);
    await this.writeStatus(true);
    return { model };
  }

  private async createDapp(args: CommandArgs): Promise<unknown> {
    const ai = this.ai();
    const prompt = argPrompt(args);
    const suggested = {
      ...(typeof args.name === 'string' && args.name.trim() ? { name: args.name.trim().slice(0, 60) } : {}),
      ...(typeof args.icon === 'string' && args.icon.trim() ? { icon: args.icon.trim().slice(0, 8) } : {}),
      ...(typeof args.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(args.color.trim()) ? { color: args.color.trim().toLowerCase() } : {}),
    };
    const generated = await ai.generator.generate({ prompt, suggested });
    const dappId = this.options.store.createDappFromFiles(generated.name, generated.icon, generated.color, generated.files);
    const revision = await ai.revisions.save(dappId, generated.files, `created: ${prompt.slice(0, 120)}`);
    // One use per operator device: each of them is admitted as owner on arrival (tick()).
    const invite = await this.createInvite(dappId, Math.max(1, this.operators().length));
    return { dappId, name: generated.name, icon: generated.icon, inviteLink: invite.link, inviteUri: invite.uri, revision };
  }

  private requireOwnedDapp(dappId: string): void {
    if (dappId === this.dappId) throw new Error('the control dapp is maintained by the keeper itself and cannot be edited here');
    if (this.options.store.roleOf(dappId, this.options.identity.publicKey) !== 'owner') {
      throw new Error('the keeper must be an owner of that dapp to edit its source');
    }
  }

  private async updateDapp(dappId: string, prompt: string): Promise<unknown> {
    const ai = this.ai();
    this.requireOwnedDapp(dappId);
    const current = { ...this.options.store.dappIdentity(dappId), files: this.options.store.sourceFiles(dappId) };
    if (!current.files['index.html']) throw new Error('that dapp has no source to edit yet');
    const generated = await ai.generator.generate({ prompt, current });
    const revision = await ai.revisions.save(dappId, current.files, `before: ${prompt.slice(0, 120)}`);
    this.options.store.replaceSourceAndManifest(dappId, generated.files);
    const changedFiles = Object.keys({ ...current.files, ...generated.files })
      .filter((file) => current.files[file] !== generated.files[file]).sort();
    return { dappId, revision, changedFiles };
  }

  private async revertDapp(dappId: string, revisionId: string): Promise<unknown> {
    const ai = this.ai();
    this.requireOwnedDapp(dappId);
    const files = await ai.revisions.load(dappId, revisionId);
    const revision = await ai.revisions.save(dappId, this.options.store.sourceFiles(dappId), `before revert to ${revisionId}`);
    this.options.store.replaceSourceAndManifest(dappId, files);
    return { dappId, restored: revisionId, revision };
  }
}
