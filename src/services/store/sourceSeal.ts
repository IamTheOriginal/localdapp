import * as Y from 'yjs';
import { getDappDoc, getDappSourceDoc, getDappSourcePersistence } from './docs.ts';
import { formerOwnerUntil, getRole, getVerifiedMembers, onVerifiedMembersChange } from './auth.ts';
import { getIdentity, getSigningIdentity } from '../identity.ts';
import { signWithIdentity, verifySignature } from './protocolCore.ts';
import { bufferToHex } from '../../lib/hex.ts';
import { readDeviceLocal, removeDeviceLocal, writeDeviceLocal } from './deviceStore.ts';
import { clearGenesisMemory, ensureGenesis, onGenesisChange, readGenesisId } from './dappGenesis.ts';

/**
 * Source seal — owner-signed Code App source.
 *
 * The source doc rides the member mesh, and the mesh applies every update of every
 * trusted member: a VIEWER on a patched client could rewrite `index.html` and
 * `manifest.yaml`, and the new code then ran on every device — on an owner's device
 * inside the owner's bridge (signed writes, role changes, file deletion), with
 * whatever network permissions the rewritten manifest granted itself.
 *
 * So the files are sealed: an owner signs the list `path → SHA-256` (map `seal`, key
 * `current` in the source doc). Every local source write by an owner re-seals. Devices
 * RUN — and read the manifest for permissions from — only a snapshot whose hashes match
 * a seal signed by an owner:
 *
 *   sealed   live source matches a valid seal → runs the live source
 *   held     live source does not match (someone is editing, or tampering) → keeps running
 *            the last snapshot that did match; nothing reloads
 *   blocked  no matching seal and nothing verified in memory (fresh load of tampered state)
 *   legacy   the dapp never had a seal on this device (created before seals existed) →
 *            runs as before; owner devices seal it on first open. Once a device has seen a
 *            valid seal for a dapp, a MISSING seal counts as tampering (no downgrade).
 *   pending  still loading
 *
 * Owner devices that hold a verified snapshot put it back when the live source stays
 * unsealed for a few seconds — with an always-on keeper that is the guard that heals
 * everyone. Trust is rooted in the verified member set of the dapp doc (auth.ts).
 *
 * A seal survives the loss of its signer (2026-09-22). Before, "is the signer an owner right
 * now" decided, so a dapp whose founder had left stopped running on every device that could
 * not find a tombstone proving the founder once was an owner. Now:
 *   - every device remembers the last seal it VERIFIED (device-local, `deviceStore.ts`, so the
 *     keeper keeps it across restarts). That exact seal stays valid on that device after its
 *     signer is gone: the device checked it while the signer was an owner;
 *   - a device that never verified a seal for the dapp treats a validly signed seal from a key
 *     it cannot place (no member, no proof it was an owner) like no seal at all: `legacy`. That
 *     is the trust-on-first-use footing it already had, since deleting the seal got the same result;
 *   - a seal signed by a CURRENT member that is not an owner is tampering, as before;
 *   - an owner device re-signs a seal whose signer it cannot place any more — but only over
 *     content IT verified (at most once per `repairIntervalMs`), which makes the dapp `sealed`
 *     for fresh devices again.
 *
 * Owner devices sign only what they verified (2026-09-23). Before, they "repaired" a seal by an
 * unplaceable or non-owner key by signing the live files, so a member could seal its own rewrite
 * with a throwaway key and have the keeper sign it for everyone. Now files this device verified
 * stay approved whatever happens to the seal (and are re-signed); anything else is restored, and
 * a device that verified nothing yet signs nothing.
 *
 * Seals are bound to their dapp (v2, 2026-09-23): they carry the dapp's genesis id
 * (`dappGenesis.ts` — founder-signed, pinned per device), because the local dapp id differs on
 * every device. A v2 seal for another genesis is tampering; unbound v1 seals keep working and
 * owner devices upgrade them, and once a device verified a v2 seal a new v1 one no longer counts.
 */

type SealStatus = 'pending' | 'sealed' | 'held' | 'blocked' | 'legacy';

export interface SourceSealState {
  status: SealStatus;
  /** The snapshot that may run (and whose manifest counts); null while pending / blocked. */
  files: Record<string, string> | null;
  /** Why the live source is not accepted (held / blocked). */
  reason?: string;
}

interface StoredSeal {
  /** 1: bound to no dapp (before 2026-09-23); 2: carries the dapp's genesis id (`dappGenesis.ts`). */
  v: 1 | 2;
  /** The SIGNING device's local id for the dapp — device-local, only a hint. */
  dappId: string;
  /** v2: the genesis id every member shares — what binds the seal to this dapp. */
  genesis?: string;
  files: Record<string, string>;
  sealedAt: string;
  _signedBy: string;
  _signature: string;
}

const SEAL_MAP = 'seal';
const SEAL_KEY = 'current';
const SEEN_PREFIX = 'vibedapp:source-sealed:';
/** Set once this device verified a genesis-bound (v2) seal for the dapp: unbound seals no longer count for new content. */
const BOUND_PREFIX = 'vibedapp:source-seal-bound:';
const EVALUATE_DEBOUNCE_MS = 80;
/**
 * Timings; `restoreGraceMs` = how long an owner device tolerates an unsealed live source before
 * restoring what it verified, `repairIntervalMs` = the floor between two re-seals this device
 * starts on its own (see `scheduleRepairSeal`).
 */
export const SOURCE_SEAL_TIMINGS = { restoreGraceMs: 4_000, repairIntervalMs: 30_000 };

/**
 * Whether the seal decides what RUNS. Switched off 2026-09-18 while seals could not survive
 * the loss of their signer, back on since 2026-09-22 (seal history, see the top of the file).
 * With `enforce: false` every source runs as `legacy` and owner devices only repair seals, so
 * a member on a patched client can rewrite the app everyone runs. Kept as a switch for an
 * emergency roll-back; the tests cover both settings.
 */
export const SOURCE_SEAL_POLICY = { enforce: true };

interface Watch {
  state: SourceSealState;
  listeners: Set<() => void>;
  evaluateTimer: ReturnType<typeof setTimeout> | null;
  sealTimer: ReturnType<typeof setTimeout> | null;
  restoreTimer: ReturnType<typeof setTimeout> | null;
  round: number;
  ready: boolean;
  /** When this device last re-sealed a dapp on its own initiative (not following a local write). */
  repairedAt: number;
  /** When this device last put its verified snapshot back (`restoreVerifiedSource`). */
  restoredAt: number;
}

const watches = new Map<string, Watch>();
const PENDING: SourceSealState = { status: 'pending', files: null };

/**
 * Re-seal a dapp nobody else can vouch for, at most once per `repairIntervalMs`. Unlike the
 * write path (`scheduleSourceSeal`, called by `source.ts` after a local edit) this one is
 * driven by what PEERS send, so it is the one that can be made to run in a loop — the cap is
 * what keeps a disagreement between two owner devices from costing a seal write per evaluation.
 */
function scheduleRepairSeal(dappId: string, watch: Watch, vouched: Record<string, string>): void {
  const now = Date.now();
  if (now - watch.repairedAt < SOURCE_SEAL_TIMINGS.repairIntervalMs) return;
  watch.repairedAt = now;
  // Sign exactly what was vouched for: whatever lands in the live doc meanwhile is not.
  setTimeout(() => {
    if (watches.get(dappId) !== watch || !sameFiles(liveFiles(dappId), vouched)) return;
    void sealSourceNow(dappId, vouched).catch((error: unknown) => console.error('source seal: re-signing failed', error));
  }, 30);
}

function liveFiles(dappId: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  getDappSourceDoc(dappId).getMap<Y.Text>('files').forEach((value, path) => {
    Object.defineProperty(snapshot, path, { value: value instanceof Y.Text ? value.toJSON() : '', enumerable: true, configurable: true, writable: true });
  });
  return snapshot;
}

async function digestOf(files: Record<string, string>): Promise<Record<string, string>> {
  const encoder = new TextEncoder();
  const entries = await Promise.all(Object.keys(files).sort().map(async (path) => (
    [path, bufferToHex(await crypto.subtle.digest('SHA-256', encoder.encode(files[path])))] as const
  )));
  return Object.fromEntries(entries);
}

function sameDigest(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

/**
 * The seal in the source doc. `dappId` is NOT compared with the local id: a dapp's id is
 * device-local (every join picks a fresh UUID for its catalog entry), so the comparison
 * rejected every seal written on another device as "no seal" — with enforcement on, two
 * owner devices then restored each other's source every few seconds (2026-09-23, keeper vs.
 * browser). The field stays in the signed payload for older builds and as a hint.
 */
function readSeal(dappId: string): StoredSeal | null {
  const raw = getDappSourceDoc(dappId).getMap(SEAL_MAP).get(SEAL_KEY) as Partial<StoredSeal> | undefined;
  if (!raw || typeof raw !== 'object' || (raw.v !== 1 && raw.v !== 2) || typeof raw.dappId !== 'string') return null;
  if (raw.v === 2 && (typeof raw.genesis !== 'string' || raw.genesis.length === 0)) return null;
  if (typeof raw._signedBy !== 'string' || typeof raw._signature !== 'string' || typeof raw.sealedAt !== 'string') return null;
  if (!raw.files || typeof raw.files !== 'object' || Array.isArray(raw.files)) return null;
  if (!Object.values(raw.files).every((hash) => typeof hash === 'string')) return null;
  return raw as StoredSeal;
}

/**
 * What this device remembers about a dapp's seal: nothing (never verified one), `'1'` (it
 * verified one, written by builds before 2026-09-22), or the signature of the last seal it
 * verified. Device-local through `deviceStore.ts`: on the keeper a file, not the volatile
 * localStorage polyfill, or the downgrade protection would reset at every boot.
 */
function rememberedSeal(dappId: string): string | null {
  return readDeviceLocal(SEEN_PREFIX + dappId);
}

function hasSeenSeal(dappId: string): boolean {
  return rememberedSeal(dappId) !== null;
}

/** Whether `seal` is exactly the seal this device verified last (its signer was an owner then). */
function isRememberedSeal(dappId: string, seal: StoredSeal): boolean {
  return rememberedSeal(dappId) === seal._signature;
}

function rememberSeal(dappId: string, seal: StoredSeal): void {
  if (rememberedSeal(dappId) === seal._signature) return;
  writeDeviceLocal(SEEN_PREFIX + dappId, seal._signature); // no storage: the protection lasts for this session only
}

/** The dapp left this device (purgeDappLocalResources): a rejoin starts from first sight again. */
export function clearSourceSealMemory(dappId: string): void {
  removeDeviceLocal(SEEN_PREFIX + dappId);
  removeDeviceLocal(BOUND_PREFIX + dappId);
  clearGenesisMemory(dappId);
}

function isBound(dappId: string): boolean {
  return readDeviceLocal(BOUND_PREFIX + dappId) !== null;
}

function markBound(dappId: string): void {
  if (!isBound(dappId)) writeDeviceLocal(BOUND_PREFIX + dappId, '1');
}

function localIsOwner(dappId: string): boolean {
  const identity = getIdentity();
  return Boolean(identity) && getRole(dappId, identity?.publicKey ?? '') === 'owner';
}

/**
 * Whether the signer was entitled to seal at `sealedAt`:
 *   'owner'    an owner now, or provably an owner until it was removed / left after sealing;
 *   'notOwner' a current member without the owner role: a seal it signed is tampering;
 *   'unknown'  no member here and no proof either way (e.g. a founder that left before
 *              departures carried their role).
 */
async function sealerAuthority(dappId: string, seal: StoredSeal): Promise<'owner' | 'notOwner' | 'unknown'> {
  const role = getRole(dappId, seal._signedBy);
  if (role === 'owner') return 'owner';
  if (role !== null) return 'notOwner';
  const until = await formerOwnerUntil(dappId, seal._signedBy);
  const sealedAt = Date.parse(seal.sealedAt);
  return until !== null && Number.isFinite(sealedAt) && sealedAt <= until ? 'owner' : 'unknown';
}

function sameFiles(a: Record<string, string> | null, b: Record<string, string> | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((path) => Object.hasOwn(b, path) && a[path] === b[path]);
}

function publish(dappId: string, watch: Watch, next: SourceSealState): void {
  const previous = watch.state;
  // `liveFiles` builds a fresh object every evaluation, so comparing identity called every
  // evaluation a change: each seal write anywhere in the mesh re-rendered the runtime and
  // tore the Code App's iframe down and up again (the 2026-09-18 flicker). Compare the
  // CONTENT, and keep the previous snapshot when it is equal — `useSyncExternalStore`
  // needs a stable object back from `getSourceSealState` as long as nothing really moved.
  if (previous.status === next.status && sameFiles(previous.files, next.files) && previous.reason === next.reason) return;
  watch.state = next;
  watch.listeners.forEach((listener) => {
    try { listener(); } catch (error) { console.error(`source seal listener failed (${dappId})`, error); }
  });
}

async function evaluate(dappId: string, watch: Watch): Promise<void> {
  if (watches.get(dappId) !== watch) return; // forgotten (dapp purged)
  const round = ++watch.round;
  const files = liveFiles(dappId);
  if (!watch.ready || Object.keys(files).length === 0) return; // nothing loaded yet — stays pending
  const seal = readSeal(dappId);
  const digest = await digestOf(files);
  // Founder devices create the genesis once, and put it back when it was deleted or replaced.
  await ensureGenesis(dappId).catch((error: unknown) => console.error('dapp genesis: could not write it', error));
  const genesis = await readGenesisId(dappId).catch(() => null);
  type Verdict =
    | { ok: true; vouch: boolean }
    | { ok: false; reason: string; authority: boolean; unknownSigner?: boolean };
  const verdict = await (async (): Promise<Verdict> => {
    if (!seal) return { ok: false, reason: 'The source carries no owner seal.', authority: false };
    if (!sameDigest(digest, seal.files)) return { ok: false, reason: 'The source was changed after an owner sealed it.', authority: false };
    if (!(await verifySignature(seal as unknown as Record<string, unknown>, seal._signedBy).catch(() => false))) {
      return { ok: false, reason: 'The seal signature is not valid.', authority: false };
    }
    // A seal made for another dapp (its source copied over, seal and all).
    if (genesis && seal.v === 2 && seal.genesis !== genesis) return { ok: false, reason: 'The seal belongs to another app.', authority: false };
    // An owner should re-sign what it accepts here when the seal is unbound (v1) while the dapp
    // has a genesis, or when the signer is no owner any more (fresh devices cannot place it).
    const upgrade = genesis !== null && seal.v === 1;
    // The seal this device verified last stays valid after its signer is gone.
    if (isRememberedSeal(dappId, seal)) return { ok: true, vouch: upgrade || (await sealerAuthority(dappId, seal)) !== 'owner' };
    // Once this device verified a bound seal, an unbound one is how a copied-over seal would look.
    if (upgrade && isBound(dappId)) return { ok: false, reason: 'The seal is not bound to this app.', authority: false };
    const authority = await sealerAuthority(dappId, seal);
    if (authority === 'owner') return { ok: true, vouch: upgrade };
    return { ok: false, reason: 'The seal was not signed by an owner of this app.', authority: true, unknownSigner: authority === 'unknown' };
  })();
  if (round !== watch.round) return; // the source moved on while hashing / verifying
  // A device that just joined has the source before it knows who the owners are — that is
  // "still loading", not tampering. The member list re-triggers the evaluation.
  if (SOURCE_SEAL_POLICY.enforce && !verdict.ok && verdict.authority && getVerifiedMembers(dappId) === null) return;

  const owner = localIsOwner(dappId);
  const verified = watch.state.status === 'sealed' || watch.state.status === 'held' ? watch.state.files : null;

  // An owner device signs only content IT verified — never whatever the live doc holds. Before
  // 2026-09-23 owner devices "repaired" a seal by an unplaceable or non-owner key by signing the
  // live files: a member sealed its own rewrite with a throwaway key, and the keeper signed it
  // for everyone. Files this device verified stay approved whatever the seal says now (the seal
  // was replaced, deleted, is unbound or by a signer that lost its role): they keep running and
  // an owner re-signs them. Re-signing is capped (`scheduleRepairSeal`), so a disagreement
  // between two owner devices costs at most one seal write per interval, never a loop.
  const approved = verdict.ok || (verified !== null && sameFiles(files, verified));
  if (approved) {
    if (watch.restoreTimer) clearTimeout(watch.restoreTimer);
    watch.restoreTimer = null;
    if (verdict.ok && seal) {
      rememberSeal(dappId, seal);
      if (seal.v === 2 && genesis !== null && seal.genesis === genesis) markBound(dappId);
    }
    const runnable = verdict.ok ? files : verified ?? files;
    if (owner && (!verdict.ok || verdict.vouch)) scheduleRepairSeal(dappId, watch, runnable);
    publish(dappId, watch, { status: 'sealed', files: runnable });
    return;
  }

  // Enforcement switched off (emergency roll-back, see SOURCE_SEAL_POLICY): run the live
  // source whatever the seal says. Nothing is signed for it.
  if (!SOURCE_SEAL_POLICY.enforce) {
    publish(dappId, watch, { status: 'legacy', files, reason: verdict.reason });
    return;
  }

  if (!hasSeenSeal(dappId) && (!seal || verdict.unknownSigner === true)) {
    // First sight: created before seals existed, freshly created a moment before its first
    // seal, or sealed by a key this device cannot place (the founder left). A device with no
    // seal history has nothing to hold on to, and a missing seal would get the same result.
    // It runs, but no owner device signs what it never verified.
    publish(dappId, watch, seal ? { status: 'legacy', files, reason: verdict.reason } : { status: 'legacy', files });
    return;
  }

  publish(dappId, watch, verified
    ? { status: 'held', files: verified, reason: verdict.reason }
    : { status: 'blocked', files: null, reason: verdict.reason });

  if (owner && verified && !watch.restoreTimer) {
    watch.restoreTimer = setTimeout(() => {
      watch.restoreTimer = null;
      void restoreVerifiedSource(dappId, watch, verified);
    }, SOURCE_SEAL_TIMINGS.restoreGraceMs);
  }
}

/** Owner devices put the snapshot they verified back when the live source stayed unsealed (tampering, or a write that died before its seal). */
async function restoreVerifiedSource(dappId: string, watch: Watch, verified: Record<string, string>): Promise<void> {
  if (watches.get(dappId) !== watch || watch.state.status !== 'held' || watch.state.files !== verified || !localIsOwner(dappId)) return;
  // The files are what this device verified, only the seal is missing or unreadable: sealing
  // is enough. Rewriting identical files is a full source write that reloads the app for
  // everyone who has it open.
  if (sameFiles(liveFiles(dappId), verified)) {
    scheduleRepairSeal(dappId, watch, verified);
    return;
  }
  // Like re-sealing, restoring answers what PEERS send, so it is capped: whatever two owner
  // devices disagree about, it costs at most one source write per `repairIntervalMs`.
  const now = Date.now();
  if (now - watch.restoredAt < SOURCE_SEAL_TIMINGS.repairIntervalMs) return;
  watch.restoredAt = now;
  console.warn(`source seal: restoring the last owner-sealed source of dapp ${dappId} — the live source was changed without a valid seal`);
  try {
    const { replaceCodeAppFiles } = await import('./source.ts');
    replaceCodeAppFiles(dappId, verified); // re-seals through the normal write path
  } catch (error) {
    console.error('source seal: could not restore the sealed source', error);
  }
}

function scheduleEvaluate(dappId: string, watch: Watch): void {
  if (watch.evaluateTimer) return;
  watch.evaluateTimer = setTimeout(() => {
    watch.evaluateTimer = null;
    void evaluate(dappId, watch).catch((error: unknown) => console.error('source seal: evaluation failed', error));
  }, EVALUATE_DEBOUNCE_MS);
}

/** Start (once) watching a dapp's source; cheap when already running. */
export function watchSourceSeal(dappId: string): void {
  if (watches.has(dappId)) return;
  const watch: Watch = { state: PENDING, listeners: new Set(), evaluateTimer: null, sealTimer: null, restoreTimer: null, round: 0, ready: false, repairedAt: 0, restoredAt: 0 };
  watches.set(dappId, watch);
  const source = getDappSourceDoc(dappId);
  const onChange = () => scheduleEvaluate(dappId, watch);
  source.getMap('files').observeDeep(onChange);
  source.getMap(SEAL_MAP).observe(onChange);
  // Who is an owner decides whether a seal counts — follow the member list too.
  getDappDoc(dappId).getMap('members').observeDeep(onChange);
  onVerifiedMembersChange(dappId, onChange);
  onGenesisChange(dappId, onChange); // a seal's binding is checked against it
  const persistence = getDappSourcePersistence(dappId);
  const becomeReady = () => {
    watch.ready = true;
    onChange();
  };
  if (persistence) void persistence.whenSynced.then(becomeReady, becomeReady);
  else queueMicrotask(becomeReady);
}

/** Drop the in-memory state of a dapp (it was purged from this device; tests use it to simulate a reload). */
export function forgetSourceSeal(dappId: string): void {
  const watch = watches.get(dappId);
  if (!watch) return;
  for (const timer of [watch.evaluateTimer, watch.sealTimer, watch.restoreTimer]) if (timer) clearTimeout(timer);
  watch.round += 1; // an evaluation still in flight must not publish any more
  watch.listeners.clear();
  watches.delete(dappId);
}

export function getSourceSealState(dappId: string): SourceSealState {
  watchSourceSeal(dappId);
  return watches.get(dappId)?.state ?? PENDING;
}

export function subscribeSourceSeal(dappId: string, listener: () => void): () => void {
  watchSourceSeal(dappId);
  const watch = watches.get(dappId);
  watch?.listeners.add(listener);
  return () => { watch?.listeners.delete(listener); };
}

/**
 * One file of the snapshot that may run. Hosts read `manifest.yaml` through this —
 * permissions, channel shares and roles must come from sealed source, never from
 * whatever a member wrote into the live doc. While the first evaluation is still
 * running the live file is returned, so nothing breaks during startup; a BLOCKED
 * source yields '' (no manifest → no permissions).
 */
export function getRunnableCodeAppFile(dappId: string, path: string): string {
  const state = getSourceSealState(dappId);
  if (state.status === 'pending') return liveFiles(dappId)[path] ?? '';
  return state.files && Object.hasOwn(state.files, path) ? state.files[path] : '';
}

/**
 * Sign the current live source. Owner-only; a no-op for everyone else. With `expected`, only
 * when the live source is exactly that snapshot (re-signing what this device verified).
 */
export async function sealSourceNow(dappId: string, expected?: Record<string, string>): Promise<boolean> {
  if (!localIsOwner(dappId)) return false;
  const files = liveFiles(dappId);
  if (Object.keys(files).length === 0) return false;
  if (expected && !sameFiles(files, expected)) return false;
  await ensureGenesis(dappId).catch((error: unknown) => console.error('dapp genesis: could not write it', error));
  const genesis = await readGenesisId(dappId).catch(() => null);
  const common = { dappId, files: await digestOf(files), sealedAt: new Date().toISOString() };
  const payload = genesis ? { v: 2 as const, ...common, genesis } : { v: 1 as const, ...common };
  const signature = await signWithIdentity(await getSigningIdentity(), payload);
  // The source may have moved on while hashing: never sign a list that does not describe it.
  if (!sameDigest(await digestOf(liveFiles(dappId)), payload.files)) {
    if (!expected) scheduleSourceSeal(dappId);
    return false;
  }
  getDappSourceDoc(dappId).getMap(SEAL_MAP).set(SEAL_KEY, { ...payload, ...signature });
  return true;
}

/** Called by every local source write (source.ts): seal once the burst of writes is over. */
export function scheduleSourceSeal(dappId: string): void {
  try {
    watchSourceSeal(dappId);
  } catch (error) {
    // Never let sealing break the write it follows.
    console.error('source seal: could not start watching the source', error);
    return;
  }
  const watch = watches.get(dappId);
  if (!watch || watch.sealTimer) return;
  watch.sealTimer = setTimeout(() => {
    watch.sealTimer = null;
    void sealSourceNow(dappId).catch((error: unknown) => console.error('source seal: signing failed — members keep running the previous version', error));
  }, 30);
}
