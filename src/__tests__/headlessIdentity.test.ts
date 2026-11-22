import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installLocalStoragePolyfill } from '../headless/env.ts';
import { loadOrCreateHeadlessIdentity } from '../headless/identityFile.ts';

let dir: string;

beforeAll(() => {
  installLocalStoragePolyfill();
});

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  localStorage.removeItem('dapp-builder-identity');
});

describe('headless identity', () => {
  it('creates a complete identity on first boot and reloads the same one', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-id-'));
    const created = await loadOrCreateHeadlessIdentity(dir, 'Keeper');
    expect(created.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(created.privateKey).toMatch(/^[0-9a-f]+$/);
    expect(created.encPublicKey).toBeTruthy();
    expect(created.encPrivateKey).toBeTruthy();

    // Seeded into localStorage in the store stack's identity format.
    const seeded = JSON.parse(localStorage.getItem('dapp-builder-identity') ?? '{}') as { publicKey: string };
    expect(seeded.publicKey).toBe(created.publicKey);

    const reloaded = await loadOrCreateHeadlessIdentity(dir, 'Renamed');
    expect(reloaded.publicKey).toBe(created.publicKey);
    expect(reloaded.deviceId).toBe(created.deviceId);
  });

  it('refuses to regenerate over a malformed identity file', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-id-'));
    await fs.writeFile(path.join(dir, 'identity.json'), JSON.stringify({ publicKey: 'orphan' }));
    await expect(loadOrCreateHeadlessIdentity(dir, 'Keeper')).rejects.toThrow('refusing to regenerate');
  });
});
