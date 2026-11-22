import { probeGithubLocation, type GithubLocation } from './githubSource.ts';
import { getGithubOrigin, type GithubOrigin } from './store/githubOrigin.ts';
import { getRole } from './store/auth.ts';
import { getIdentity } from './identity.ts';

/**
 * Device-local memory of the last GitHub update check per dapp (localStorage,
 * never synced). Checks are owner-only and are started exclusively by the
 * browser UI (`useGithubUpdate`) or an owner's "Check now" click — nothing in
 * the store, the runtime, or the headless keeper calls into this module, so a
 * keeper never polls GitHub and never updates a dapp on its own.
 *
 * "Update available" is derived, not stored: the remembered remote fingerprint
 * is compared with the synced origin's installed fingerprint, so the marker
 * clears on every owner device as soon as any owner applies the update.
 */
export interface GithubUpdateCheck {
  /** `owner/repo@ref:path` the check belongs to — a re-linked dapp ignores stale results. */
  source: string;
  checkedAt: number;
  /** Newest commit seen on the tracked ref. */
  commitSha: string;
  /** Fingerprint of the app folder at that commit. */
  fingerprint: string;
  /** Installed fingerprint the check compared against — detects results made stale by another owner's update. */
  installedFingerprint: string;
}

const STORAGE_PREFIX = 'dapp-builder-github-update:';
/**
 * The repository location THIS device agreed to take updates from. The synced
 * origin is writable by every member — without a local pin a member could point it
 * at a look-alike repository and the owner would review "an update" of foreign code.
 */
const PIN_PREFIX = 'dapp-builder-github-source:';
export const GITHUB_AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<GithubUpdateCheck | null>>();

function sourceKey(location: GithubLocation): string {
  return `${location.owner}/${location.repo}@${location.ref}:${location.path}`;
}

/** `owner/repo/path@ref` — what people should read before installing anything. */
export function githubSourceLabel(location: GithubLocation): string {
  return `${location.owner}/${location.repo}${location.path ? `/${location.path}` : ''}@${location.ref || 'default branch'}`;
}

/** Remember `origin` as the location this device trusts for updates. */
export function pinGithubSource(dappId: string, origin: GithubLocation): void {
  writeSourcePin(dappId, origin);
  listeners.forEach((listener) => listener());
}

function writeSourcePin(dappId: string, origin: GithubLocation): void {
  try { localStorage.setItem(PIN_PREFIX + dappId, JSON.stringify({ key: sourceKey(origin), label: githubSourceLabel(origin) })); } catch { /* unpinned: next read pins again */ }
}

/**
 * Null while the synced origin is the location this device pinned (the first one it
 * sees is pinned — trust on first use). Otherwise the label of the pinned location:
 * someone re-pointed the dapp, and nothing may be fetched or installed from the new
 * place until an owner accepts it here (`pinGithubSource`).
 */
export function githubSourceMismatch(dappId: string, origin: GithubLocation): string | null {
  const readPin = (): { key?: unknown; label?: unknown } | null => {
    try {
      return JSON.parse(localStorage.getItem(PIN_PREFIX + dappId) ?? 'null') as { key?: unknown; label?: unknown } | null;
    } catch {
      return null; // an unreadable pin counts as none
    }
  };
  const pinned = readPin();
  if (!pinned || typeof pinned.key !== 'string') {
    writeSourcePin(dappId, origin); // silent: this runs during render, and nothing visible changes
    return null;
  }
  if (pinned.key === sourceKey(origin)) return null;
  return typeof pinned.label === 'string' ? pinned.label : pinned.key;
}

export function subscribeGithubUpdateChecks(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function readGithubUpdateCheck(dappId: string, origin: GithubOrigin): GithubUpdateCheck | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + dappId);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<GithubUpdateCheck> | null;
    if (!value || value.source !== sourceKey(origin) || typeof value.checkedAt !== 'number'
      || typeof value.commitSha !== 'string' || typeof value.fingerprint !== 'string' || typeof value.installedFingerprint !== 'string') return null;
    // Another owner installed a revision this check never saw: the result says
    // nothing about the new state — drop it so the next check starts fresh.
    if (value.installedFingerprint !== origin.fingerprint && value.fingerprint !== origin.fingerprint) return null;
    return { source: value.source, checkedAt: value.checkedAt, commitSha: value.commitSha, fingerprint: value.fingerprint, installedFingerprint: value.installedFingerprint };
  } catch {
    return null;
  }
}

export function isGithubUpdateAvailable(origin: GithubOrigin | null, check: GithubUpdateCheck | null): boolean {
  return Boolean(origin && check && check.fingerprint !== origin.fingerprint);
}

function store(dappId: string, check: GithubUpdateCheck): void {
  try { localStorage.setItem(STORAGE_PREFIX + dappId, JSON.stringify(check)); } catch { /* storage full/blocked — listeners still hear about it */ }
  listeners.forEach((listener) => listener());
}

/** Remember that this device just installed `commitSha` — the freshly applied revision is, by definition, up to date. */
export function recordGithubInstall(dappId: string, origin: GithubOrigin, now = Date.now()): void {
  pinGithubSource(dappId, origin);
  store(dappId, { source: sourceKey(origin), checkedAt: now, commitSha: origin.commitSha, fingerprint: origin.fingerprint, installedFingerprint: origin.fingerprint });
}

function isOwner(dappId: string): boolean {
  const identity = getIdentity();
  return Boolean(identity) && getRole(dappId, identity?.publicKey ?? '') === 'owner';
}

/**
 * Asks GitHub whether the tracked folder changed. Without `force` it is a
 * no-op while the last check is younger than the auto-check interval. Resolves
 * to the stored check (null when the dapp has no origin or this device is not
 * an owner); rejects when GitHub cannot be asked.
 */
export function checkGithubUpdate(dappId: string, options: { force?: boolean; fetchImpl?: typeof fetch; now?: number } = {}): Promise<GithubUpdateCheck | null> {
  const origin = getGithubOrigin(dappId);
  if (!origin || !isOwner(dappId)) return Promise.resolve(null);
  // A re-pointed origin is not even asked: no red dot for a location nobody here accepted.
  if (githubSourceMismatch(dappId, origin)) return Promise.resolve(null);
  const now = options.now ?? Date.now();
  const previous = readGithubUpdateCheck(dappId, origin);
  if (!options.force && previous && now - previous.checkedAt < GITHUB_AUTO_CHECK_INTERVAL_MS) return Promise.resolve(previous);
  const running = inFlight.get(dappId);
  if (running) return running;

  const task = (async () => {
    const known = previous ?? { commitSha: origin.commitSha, fingerprint: origin.fingerprint };
    const tree = await probeGithubLocation(origin, known.commitSha, options.fetchImpl);
    const check: GithubUpdateCheck = {
      source: sourceKey(origin),
      checkedAt: now,
      commitSha: tree?.commitSha ?? known.commitSha,
      fingerprint: tree?.fingerprint ?? known.fingerprint,
      installedFingerprint: origin.fingerprint,
    };
    store(dappId, check);
    return check;
  })().finally(() => { inFlight.delete(dappId); });
  inFlight.set(dappId, task);
  return task;
}

/** Forget the remembered check (dapp deleted or unlinked). */
export function clearGithubUpdateCheck(dappId: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + dappId);
    localStorage.removeItem(PIN_PREFIX + dappId);
  } catch { /* nothing to clear */ }
  listeners.forEach((listener) => listener());
}
