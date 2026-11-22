// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubOrigin } from '../services/store/githubOrigin.ts';

const state = vi.hoisted(() => {
  const origin: unknown = null;
  const role: string | null = 'owner';
  return { origin, role, probe: vi.fn() };
});

vi.mock('../services/store/githubOrigin.ts', () => ({ getGithubOrigin: () => state.origin }));
vi.mock('../services/store/auth.ts', () => ({ getRole: () => state.role }));
vi.mock('../services/identity.ts', () => ({ getIdentity: () => ({ publicKey: 'me' }) }));
vi.mock('../services/githubSource.ts', () => ({ probeGithubLocation: state.probe }));

import {
  GITHUB_AUTO_CHECK_INTERVAL_MS, checkGithubUpdate, clearGithubUpdateCheck, githubSourceMismatch, isGithubUpdateAvailable, pinGithubSource,
  readGithubUpdateCheck, recordGithubInstall, subscribeGithubUpdateChecks,
} from '../services/githubUpdateState.ts';

const F1 = '1'.repeat(64);
const F2 = '2'.repeat(64);
const F3 = '3'.repeat(64);
const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);

function origin(overrides: Partial<GithubOrigin> = {}): GithubOrigin {
  return { owner: 'acme', repo: 'app', ref: 'main', path: '', commitSha: C1, fingerprint: F1, installedAt: '', ...overrides };
}

describe('GitHub update checks', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    state.origin = origin();
    state.role = 'owner';
  });

  it('never asks GitHub for non-owners or unlinked dapps', async () => {
    state.role = 'editor';
    expect(await checkGithubUpdate('d1', { force: true })).toBeNull();
    state.role = 'owner';
    state.origin = null;
    expect(await checkGithubUpdate('d1', { force: true })).toBeNull();
    expect(state.probe).not.toHaveBeenCalled();
  });

  it('never asks a repository a member re-pointed the dapp to until an owner accepts it on this device', async () => {
    recordGithubInstall('d1', origin()); // this device installed from acme/app
    const lookalike = origin({ owner: 'acrne', repo: 'app' });
    state.origin = lookalike; // the synced link is writable by every member

    expect(githubSourceMismatch('d1', lookalike)).toBe('acme/app@main');
    expect(await checkGithubUpdate('d1', { force: true })).toBeNull();
    expect(state.probe).not.toHaveBeenCalled();

    pinGithubSource('d1', lookalike); // the owner's explicit "Accept the new repository"
    expect(githubSourceMismatch('d1', lookalike)).toBeNull();
    state.probe.mockResolvedValueOnce(null);
    expect(await checkGithubUpdate('d1', { force: true })).not.toBeNull();
  });

  it('pins the first location it sees, and forgets the pin with the link', () => {
    expect(githubSourceMismatch('d2', origin())).toBeNull(); // trust on first use
    expect(githubSourceMismatch('d2', origin({ path: 'other' }))).toBe('acme/app@main');
    clearGithubUpdateCheck('d2');
    expect(githubSourceMismatch('d2', origin({ path: 'other' }))).toBeNull();
  });

  it('reports an update only when the tracked folder changed, and notifies listeners', async () => {
    const heard = vi.fn();
    const stop = subscribeGithubUpdateChecks(heard);

    state.probe.mockResolvedValueOnce(null); // commit unchanged
    const first = await checkGithubUpdate('d1', { now: 1_000 });
    expect(state.probe).toHaveBeenCalledWith(origin(), C1, undefined);
    expect(isGithubUpdateAvailable(origin(), first)).toBe(false);

    state.probe.mockResolvedValueOnce({ commitSha: C2, fingerprint: F2 });
    const second = await checkGithubUpdate('d1', { force: true, now: 2_000 });
    expect(isGithubUpdateAvailable(origin(), second)).toBe(true);
    expect(readGithubUpdateCheck('d1', origin())).toEqual(second);
    expect(heard).toHaveBeenCalledTimes(2);
    stop();

    // The next probe starts from the newest commit already seen.
    state.probe.mockResolvedValueOnce(null);
    await checkGithubUpdate('d1', { force: true, now: 3_000 });
    expect(state.probe).toHaveBeenLastCalledWith(origin(), C2, undefined);
    expect(isGithubUpdateAvailable(origin(), readGithubUpdateCheck('d1', origin()))).toBe(true);
  });

  it('rate-limits background checks to one per interval, while a forced check always runs', async () => {
    state.probe.mockResolvedValue(null);
    await checkGithubUpdate('d1', { now: 1_000 });
    await checkGithubUpdate('d1', { now: 1_000 + GITHUB_AUTO_CHECK_INTERVAL_MS - 1 });
    expect(state.probe).toHaveBeenCalledTimes(1);
    await checkGithubUpdate('d1', { now: 1_000 + GITHUB_AUTO_CHECK_INTERVAL_MS });
    expect(state.probe).toHaveBeenCalledTimes(2);
    await checkGithubUpdate('d1', { force: true, now: 1_001 + GITHUB_AUTO_CHECK_INTERVAL_MS });
    expect(state.probe).toHaveBeenCalledTimes(3);
  });

  it('shares one in-flight request between concurrent callers and surfaces failures', async () => {
    let release: (value: null) => void = () => undefined;
    state.probe.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const both = Promise.all([checkGithubUpdate('d1', { force: true }), checkGithubUpdate('d1', { force: true })]);
    release(null);
    await both;
    expect(state.probe).toHaveBeenCalledTimes(1);

    state.probe.mockRejectedValueOnce(new Error('github: GitHub is not reachable right now'));
    await expect(checkGithubUpdate('d1', { force: true })).rejects.toThrow('not reachable');
    expect(isGithubUpdateAvailable(origin(), readGithubUpdateCheck('d1', origin()))).toBe(false);
  });

  it('clears the marker on every owner device once any owner installed the update', async () => {
    state.probe.mockResolvedValueOnce({ commitSha: C2, fingerprint: F2 });
    await checkGithubUpdate('d1', { force: true });
    expect(isGithubUpdateAvailable(origin(), readGithubUpdateCheck('d1', origin()))).toBe(true);

    // Another owner applied exactly that revision — the synced origin now matches what we saw.
    const updated = origin({ commitSha: C2, fingerprint: F2 });
    expect(isGithubUpdateAvailable(updated, readGithubUpdateCheck('d1', updated))).toBe(false);

    // Another owner applied a revision we never saw: our result is stale, not an "update".
    const newer = origin({ commitSha: 'c'.repeat(40), fingerprint: F3 });
    expect(readGithubUpdateCheck('d1', newer)).toBeNull();
    // A check for a different repository location never leaks over either.
    expect(readGithubUpdateCheck('d1', origin({ repo: 'other' }))).toBeNull();
  });

  it('counts a fresh install as checked, so the background check stays quiet', async () => {
    recordGithubInstall('d1', origin(), 5_000);
    await checkGithubUpdate('d1', { now: 6_000 });
    expect(state.probe).not.toHaveBeenCalled();
    expect(isGithubUpdateAvailable(origin(), readGithubUpdateCheck('d1', origin()))).toBe(false);
  });
});

describe('keeper nodes and the store never poll GitHub', () => {
  const SRC = join(__dirname, '..');
  const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js)$/.test(entry) ? [path] : [];
  });

  it('keeps update checks and source downloads out of src/headless and the store layer', () => {
    const offenders = [...sourceFiles(join(SRC, 'headless')), ...sourceFiles(join(SRC, 'services', 'store')), ...sourceFiles(join(SRC, 'automations'))]
      .filter((path) => /githubUpdateState|fetchGithubSource|probeGithubLocation|downloadGithubSnapshot/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
