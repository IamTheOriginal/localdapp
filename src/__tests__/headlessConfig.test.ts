import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadHeadlessConfig, parseSignalingUrls, patchHeadlessConfig, DEFAULT_CONTROL_PORT } from '../headless/config.ts';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('loadHeadlessConfig', () => {
  it('generates a token on first boot and keeps it across loads', async () => {
    const dir = await tempDir();
    const first = await loadHeadlessConfig(dir, {});
    expect(first.controlToken).toMatch(/^[0-9a-f]{64}$/);
    expect(first.controlHost).toBe('127.0.0.1');
    expect(first.controlPort).toBe(DEFAULT_CONTROL_PORT);
    expect(first.replicateFiles).toBe(true);

    const second = await loadHeadlessConfig(dir, {});
    expect(second.controlToken).toBe(first.controlToken);
  });

  it('applies env overrides and persists them', async () => {
    const dir = await tempDir();
    await loadHeadlessConfig(dir, {});
    const overridden = await loadHeadlessConfig(dir, {
      HEADLESS_PORT: '9999',
      SIGNALING_URLS: 'wss://a.example, wss://b.example',
      HEADLESS_REPLICATE_FILES: 'false',
    });
    expect(overridden.controlPort).toBe(9999);
    expect(overridden.signalingUrls).toEqual(['wss://a.example', 'wss://b.example']);
    expect(overridden.replicateFiles).toBe(false);

    const reread = await loadHeadlessConfig(dir, {});
    expect(reread.controlPort).toBe(9999);
    expect(reread.signalingUrls).toEqual(['wss://a.example', 'wss://b.example']);
    expect(reread.replicateFiles).toBe(false);
  });
});

describe('integration settings', () => {
  it('reads LLM and n8n settings from env, persists them, and lets an empty env value switch them off', async () => {
    const dir = await tempDir();
    const configured = await loadHeadlessConfig(dir, {
      LLM_BASE_URL: 'http://192.168.8.229:4000/v1/',
      LLM_API_KEY: 'sk-virtual',
      LLM_MODEL: 'claude-opus-5',
      N8N_WEBHOOK_URL: 'http://192.168.8.229:5678/webhook/keeper',
      N8N_WEBHOOK_SECRET: 'hook-secret',
    });
    expect(configured.llm).toEqual({ baseUrl: 'http://192.168.8.229:4000/v1', apiKey: 'sk-virtual', model: 'claude-opus-5' });
    expect(configured.n8n).toEqual({ url: 'http://192.168.8.229:5678/webhook/keeper', secret: 'hook-secret' });

    const reread = await loadHeadlessConfig(dir, {});
    expect(reread.llm).toEqual(configured.llm);
    expect(reread.n8n).toEqual(configured.n8n);

    // LLM_MODEL only seeds: a stored (operator-chosen) model wins over the env on later boots.
    const partial = await loadHeadlessConfig(dir, { LLM_MODEL: 'gpt-x' });
    expect(partial.llm).toEqual({ baseUrl: 'http://192.168.8.229:4000/v1', apiKey: 'sk-virtual', model: 'claude-opus-5' });
    await patchHeadlessConfig(dir, { llm: { baseUrl: 'http://192.168.8.229:4000/v1', apiKey: 'sk-virtual', model: 'picked-in-app' } });
    expect((await loadHeadlessConfig(dir, { LLM_MODEL: 'gpt-x' })).llm?.model).toBe('picked-in-app');

    const off = await loadHeadlessConfig(dir, { LLM_BASE_URL: '', N8N_WEBHOOK_URL: '' });
    expect(off.llm).toBeUndefined();
    expect(off.n8n).toBeUndefined();
  });

  it('keeps a patched control dapp id and the app url across loads', async () => {
    const dir = await tempDir();
    await loadHeadlessConfig(dir, { HEADLESS_APP_URL: 'https://dapp.example/' });
    await patchHeadlessConfig(dir, { controlDappId: 'control-123' });
    const reread = await loadHeadlessConfig(dir, {});
    expect(reread.controlDappId).toBe('control-123');
    expect(reread.appUrl).toBe('https://dapp.example');
    expect(reread.controlToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves the integrations unset when nothing is configured', async () => {
    const dir = await tempDir();
    const config = await loadHeadlessConfig(dir, { LLM_MODEL: 'model-without-url' });
    expect(config.llm).toBeUndefined();
    expect(config.n8n).toBeUndefined();
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'))).not.toHaveProperty('llm');
    // A base URL without a model still enables the endpoint (model picked later in the control dapp).
    const noModel = await loadHeadlessConfig(dir, { LLM_BASE_URL: 'http://gw/v1', LLM_API_KEY: 'k' });
    expect(noModel.llm).toEqual({ baseUrl: 'http://gw/v1', apiKey: 'k' });
  });
});

describe('damaged config file', () => {
  it('refuses to regenerate over a config.json that does not parse', async () => {
    const dir = await tempDir();
    await patchHeadlessConfig(dir, { controlDappId: 'control-1' });
    const file = path.join(dir, 'config.json');
    await fs.writeFile(file, '{"controlToken": "abc", "controlDa');

    await expect(loadHeadlessConfig(dir, {})).rejects.toThrow(/refusing to regenerate/);
    await expect(patchHeadlessConfig(dir, { appUrl: 'https://dapp.example' })).rejects.toThrow(/refusing to regenerate/);
    expect(await fs.readFile(file, 'utf8')).toBe('{"controlToken": "abc", "controlDa');
  });

  it('keeps every field when patches overlap', async () => {
    const dir = await tempDir();
    await loadHeadlessConfig(dir, {});
    await Promise.all([
      patchHeadlessConfig(dir, { controlDappId: 'control-1' }),
      patchHeadlessConfig(dir, { appUrl: 'https://dapp.example' }),
      patchHeadlessConfig(dir, { displayName: 'Renamed' }),
    ]);
    const config = await loadHeadlessConfig(dir, {});
    expect(config.controlDappId).toBe('control-1');
    expect(config.appUrl).toBe('https://dapp.example');
    expect(config.displayName).toBe('Renamed');
    expect((await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('parseSignalingUrls', () => {
  it('splits on commas and whitespace and de-duplicates', () => {
    expect(parseSignalingUrls('ws://a ws://b,ws://a,, ws://c')).toEqual(['ws://a', 'ws://b', 'ws://c']);
  });
});
