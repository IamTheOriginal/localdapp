#!/usr/bin/env node
/**
 * Keeper smoke test: boots the real headless entry point (`server/headless.mjs`) against a
 * throwaway data directory and waits until the control API reports a running keeper. It
 * covers what unit tests cannot — the boot order (Node shims → file persistence → runtime →
 * control server) on the Node version the keeper image uses. No signaling broker is needed:
 * a keeper without dapps never dials one.
 *
 *   node scripts/keeper-smoke.mjs        (exit code 0 = the keeper came up)
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const BOOT_TIMEOUT_MS = 60_000;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'keeper-smoke-'));
const port = await freePort();
const keeper = spawn(process.execPath, ['server/headless.mjs'], {
  env: {
    ...process.env,
    HEADLESS_DATA_DIR: dataDir,
    HEADLESS_PORT: String(port),
    HEADLESS_HOST: '127.0.0.1',
    LLM_BASE_URL: '',
    N8N_WEBHOOK_URL: '',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

let exited = null;
keeper.on('exit', (code) => { exited = code; });

async function finish(code, message) {
  console.log(message);
  keeper.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  process.exit(code);
}

const started = Date.now();
for (;;) {
  if (exited !== null) await finish(1, `keeper smoke: the keeper exited with code ${exited} before it answered`);
  if (Date.now() - started > BOOT_TIMEOUT_MS) await finish(1, 'keeper smoke: no answer from the control API in time');
  try {
    const { controlToken } = JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8'));
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Authorization: `Bearer ${controlToken}` } });
    if (response.ok) {
      const status = await response.json();
      if (typeof status.identity?.publicKey === 'string' && Array.isArray(status.dapps)) {
        await finish(0, `keeper smoke: up after ${Date.now() - started} ms (device key ${status.identity.publicKey.slice(0, 16)}…)`);
      }
      await finish(1, `keeper smoke: unexpected status payload ${JSON.stringify(status).slice(0, 200)}`);
    }
  } catch {
    // not up yet
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
