import { beforeEach, describe, expect, it, vi } from 'vitest';

// The module keeps one health state per session, so every test gets a fresh copy.
async function freshModule() {
  vi.resetModules();
  return import('../services/store/storageHealth.ts');
}

describe('storage health', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('reports a loaded local copy and leaves the health alone', async () => {
    const health = await freshModule();
    expect(await health.whenLocalCopyLoaded({ whenSynced: Promise.resolve() })).toBe(true);
    expect(await health.whenLocalCopyLoaded(null)).toBe(true);
    expect(health.getStorageHealth()).toBe('ok');
  });

  it('stops waiting for a database that never opens and marks the storage unavailable', async () => {
    const health = await freshModule();
    const changes: string[] = [];
    health.onStorageHealthChange(() => { changes.push(health.getStorageHealth()); });
    // y-indexeddb's behaviour when `indexedDB.open` fails: the promise stays pending forever.
    const neverOpens = { whenSynced: new Promise<void>(() => undefined) };

    expect(await health.whenLocalCopyLoaded(neverOpens, 20)).toBe(false);
    expect(health.getStorageHealth()).toBe('unavailable');
    expect(changes).toEqual(['unavailable']);
    await expect(health.requireLocalCopyLoaded(neverOpens, 20)).rejects.toBeInstanceOf(health.LocalStorageUnavailableError);
  });

  it('treats a rejected load as unavailable storage', async () => {
    const health = await freshModule();
    expect(await health.whenLocalCopyLoaded({ whenSynced: Promise.reject(new Error('blocked')) })).toBe(false);
    expect(health.getStorageHealth()).toBe('unavailable');
  });

  it('keeps a failed write visible even when a later load succeeds or times out', async () => {
    const health = await freshModule();
    health.reportStorageWriteFailure(new Error('QuotaExceededError'));
    health.reportStorageUnavailable(new Error('later'));
    expect(health.getStorageHealth()).toBe('write-failed');
  });
});
