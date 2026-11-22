import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setDeviceLocalStore, type DeviceLocalStore } from '../services/store/deviceStore.ts';
import { writeFileAtomic } from './atomicFile.ts';

/**
 * Durable backing for the store stack's device-local keys on the keeper.
 *
 * `env.ts` gives Node a VOLATILE localStorage, so everything a browser device
 * keeps for itself — the founder pin, the verified member baseline
 * (`store/memberBaseline.ts`) — would be empty again at every boot. That is not
 * a missing convenience: both are trust-on-FIRST-use protections, and a device
 * whose "first use" is every boot has none of them. The always-on device is
 * exactly the one that must not lose them.
 *
 * So the keeper fills the seam `store/deviceStore.ts` leaves with this file:
 * one small JSON object of key → value in the data directory, read once at
 * boot and written back atomically. Writes are coalesced — the caller's API is
 * synchronous like localStorage, the disk write runs behind it — so `stop()`
 * waits for `whenIdle()` before the process exits.
 *
 * A file that does not parse starts empty: every key behind this store falls
 * back to trust on first use, never to deleting something unproven.
 */

const DEVICE_STATE_FILE = 'device-state.json';

export class FileDeviceStore implements DeviceLocalStore {
  private readonly filePath: string;
  private readonly entries = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private queued = false;

  private constructor(filePath: string) {
    this.filePath = filePath;
  }

  static async open(dataDir: string): Promise<FileDeviceStore> {
    const store = new FileDeviceStore(path.join(dataDir, DEVICE_STATE_FILE));
    const raw = await fs.readFile(store.filePath, 'utf8').catch(() => null); // null: first boot
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === 'string') store.entries.set(key, value);
          }
        }
      } catch (error) {
        console.error(`device state: ${store.filePath} does not parse — starting with none`, error);
      }
    }
    return store;
  }

  read(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  write(key: string, value: string): void {
    if (this.entries.get(key) === value) return;
    this.entries.set(key, value);
    this.persist();
  }

  remove(key: string): void {
    if (!this.entries.delete(key)) return;
    this.persist();
  }

  private persist(): void {
    if (this.queued) return; // a write is already on its way and will see this change too
    this.queued = true;
    this.chain = this.chain.then(async () => {
      this.queued = false;
      await writeFileAtomic(this.filePath, `${JSON.stringify(Object.fromEntries(this.entries))}\n`, { mode: 0o600 });
    }).catch((error: unknown) => {
      console.error('device state: write failed', this.filePath, error);
    });
  }

  /** Resolves when everything written so far is on disk. */
  async whenIdle(): Promise<void> {
    let awaited: Promise<void>;
    do {
      awaited = this.chain;
      await awaited;
    } while (awaited !== this.chain);
  }
}

/** Route the store stack's device-local keys through the data directory. Returns the store so it can be flushed. */
export async function installHeadlessDeviceStore(dataDir: string): Promise<FileDeviceStore> {
  await fs.mkdir(dataDir, { recursive: true });
  const store = await FileDeviceStore.open(dataDir);
  setDeviceLocalStore(store);
  return store;
}

/** Back to the (volatile) localStorage polyfill — the keeper does this when it shuts down. */
export function uninstallHeadlessDeviceStore(): void {
  setDeviceLocalStore(null);
}
