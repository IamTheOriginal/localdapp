/**
 * "Keep this device awake" — an opt-in screen wake lock so a device with the
 * app open can serve as an always-on peer (a poor man's keeper node): while
 * the screen stays on, the tab keeps syncing docs and serving blobs to other
 * members. Device-local preference (localStorage, never synced).
 *
 * The lock is re-acquired whenever the tab becomes visible again — the
 * browser silently releases it on tab switch/minimize by design.
 */

const STORAGE_KEY = 'keep-awake';

export interface KeepAwakeState {
  supported: boolean;
  enabled: boolean;
  /** A wake lock is currently held (screen will not sleep). */
  active: boolean;
}

interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
}

type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
};

let sentinel: WakeLockSentinelLike | null = null;
let initialized = false;
const listeners = new Set<(state: KeepAwakeState) => void>();

function supported(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as WakeLockNavigator).wakeLock;
}

function isKeepAwakeEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function getKeepAwakeState(): KeepAwakeState {
  return { supported: supported(), enabled: isKeepAwakeEnabled(), active: sentinel !== null };
}

function notify(): void {
  const state = getKeepAwakeState();
  listeners.forEach((listener) => listener(state));
}

async function acquire(): Promise<void> {
  if (sentinel || !supported() || !isKeepAwakeEnabled()) return;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  try {
    const lock = await (navigator as WakeLockNavigator).wakeLock.request('screen');
    sentinel = lock;
    lock.addEventListener('release', () => {
      if (sentinel === lock) sentinel = null;
      notify();
    });
  } catch {
    // Denied (battery saver, hidden tab). The visibility handler retries.
    sentinel = null;
  }
  notify();
}

async function release(): Promise<void> {
  const lock = sentinel;
  sentinel = null;
  if (lock) await lock.release().catch(() => {});
  notify();
}

export async function setKeepAwakeEnabled(enabled: boolean): Promise<void> {
  try {
    if (enabled) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage unavailable: still honor the choice this session */ }
  if (enabled) await acquire();
  else await release();
}

export function subscribeKeepAwake(listener: (state: KeepAwakeState) => void): () => void {
  listeners.add(listener);
  listener(getKeepAwakeState());
  return () => listeners.delete(listener);
}

/** Called once at app start: restores the persisted preference across reloads. */
export function initKeepAwake(): () => void {
  if (initialized) return () => {};
  initialized = true;
  const onVisibility = () => { void acquire(); };
  document.addEventListener('visibilitychange', onVisibility);
  void acquire();
  return () => {
    initialized = false;
    document.removeEventListener('visibilitychange', onVisibility);
    void release();
  };
}
