/**
 * Device-local key/value storage — small strings a device keeps for ITSELF and
 * never syncs: the founder pin, the verified member baseline (memberBaseline.ts).
 *
 * In the browser this is plain `localStorage`, wrapped so a private window (or a
 * blocked-storage setting) throws nothing at the caller. The seam exists for ONE
 * reason: `src/headless/env.ts` installs a VOLATILE localStorage polyfill, so on
 * the keeper — the one always-on device — everything stored here would be empty
 * again at every boot, silently downgrading trust-on-first-use protections to
 * "on first use, every boot". The keeper therefore installs a file-backed store
 * from its data directory (`src/headless/deviceStateFile.ts`) before it connects
 * any dapp. Nothing else may use this seam to swap storage out.
 */

export interface DeviceLocalStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

let backend: DeviceLocalStore | null = null;

/** Replace the storage behind the device-local keys; `null` restores `localStorage`. */
export function setDeviceLocalStore(store: DeviceLocalStore | null): void {
  backend = store;
}

/** The stored value, or null when nothing is stored AND when storage cannot be read at all. */
export function readDeviceLocal(key: string): string | null {
  try {
    return backend ? backend.read(key) : localStorage.getItem(key);
  } catch {
    return null; // no storage: callers fall back to their session-only behaviour
  }
}

/** False when the write did not happen (quota, private window, read-only file system). */
export function writeDeviceLocal(key: string, value: string): boolean {
  try {
    if (backend) backend.write(key, value);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeDeviceLocal(key: string): void {
  try {
    if (backend) backend.remove(key);
    else localStorage.removeItem(key);
  } catch { /* nothing stored / no storage — nothing to forget */ }
}
