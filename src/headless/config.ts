import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IceServerEntry } from '../services/signalingConfig.ts';
import { resolveIceServers, resolveIceServersUrl } from '../services/signalingConfig.ts';
import { bufferToHex } from '../lib/hex.ts';
import { writeFileAtomic } from './atomicFile.ts';

/**
 * Headless runtime configuration: `config.json` in the data directory holds
 * durable settings (control token above all); environment variables override
 * per boot and are written back so the file always reflects the running
 * configuration.
 */

interface HeadlessConfig {
  /** Interface the control server binds. Default loopback; expose deliberately. */
  controlHost: string;
  controlPort: number;
  /** Bearer token every /api request must present. Generated on first boot. */
  controlToken: string;
  displayName: string;
  signalingUrls: string[];
  iceServers?: IceServerEntry[];
  /** Optional dynamic ICE/TURN endpoint (e.g. Cloudflare Worker /ice). */
  iceServersUrl?: string;
  /** Optional bearer token sent when fetching `iceServersUrl`. */
  iceAccessToken?: string;
  /** Pin-all blob replication for every dapp (the point of a keeper node). */
  replicateFiles: boolean;
  /** OpenAI-compatible chat endpoint (LiteLLM, OpenRouter, Ollama, …); absent = AI features off. */
  llm?: LlmEndpointConfig;
  /** Single n8n webhook that receives every record event; absent = no event delivery. */
  n8n?: N8nWebhookConfig;
  /** Web app origin used to render clickable invite links (e.g. https://dapp.example); absent = raw codes only. */
  appUrl?: string;
  /** The keeper-created "Keeper Control" dapp (docs/HEADLESS.md, "Control dapp"); set on first creation. */
  controlDappId?: string;
}

export interface LlmEndpointConfig {
  /** Base URL up to and including `/v1`, e.g. `http://192.168.8.229:4000/v1`. */
  baseUrl: string;
  apiKey: string;
  /** Selected model; absent until `LLM_MODEL` seeds it or an operator picks one in the control dapp. */
  model?: string;
}

export interface N8nWebhookConfig {
  url: string;
  /** Sent as `Authorization: Bearer <secret>`; the n8n Webhook node checks it. */
  secret: string;
}

const CONFIG_FILE = 'config.json';
export const DEFAULT_CONTROL_PORT = 8788;
const DEFAULT_SIGNALING_URL = 'ws://127.0.0.1:4444';

function generateToken(): string {
  return bufferToHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

export function parseSignalingUrls(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map((url) => url.trim()).filter(Boolean))];
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/**
 * Env wins field by field; `LLM_BASE_URL=""` (explicitly empty) switches the
 * integration off. The model is the exception: `LLM_MODEL` only seeds a
 * missing choice, because operators change it from the control dapp and that
 * choice must survive a restart.
 */
function resolveLlm(env: NodeJS.ProcessEnv, stored: LlmEndpointConfig | undefined): LlmEndpointConfig | undefined {
  if (env.LLM_BASE_URL !== undefined && !trimmed(env.LLM_BASE_URL)) return undefined;
  const baseUrl = trimmed(env.LLM_BASE_URL) ?? stored?.baseUrl;
  if (!baseUrl) return undefined;
  const model = stored?.model ?? trimmed(env.LLM_MODEL);
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey: trimmed(env.LLM_API_KEY) ?? stored?.apiKey ?? '', ...(model ? { model } : {}) };
}

function resolveN8n(env: NodeJS.ProcessEnv, stored: N8nWebhookConfig | undefined): N8nWebhookConfig | undefined {
  if (env.N8N_WEBHOOK_URL !== undefined && !trimmed(env.N8N_WEBHOOK_URL)) return undefined;
  const url = trimmed(env.N8N_WEBHOOK_URL) ?? stored?.url;
  if (!url) return undefined;
  return { url, secret: trimmed(env.N8N_WEBHOOK_SECRET) ?? stored?.secret ?? '' };
}

/**
 * Read `config.json`; a missing file is a first boot. An existing file that
 * cannot be read or parsed is an error, never silently regenerated (same rule
 * as `identityFile.ts`): regenerating drops the control dapp id — a second
 * control dapp gets created, operators are stranded — and changes the token.
 */
async function readStoredConfig(filePath: string): Promise<Partial<HeadlessConfig>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`headless config: cannot read ${filePath}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`headless config: ${filePath} is not valid JSON — repair it or remove it deliberately; refusing to regenerate over it`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`headless config: ${filePath} does not hold a settings object — refusing to regenerate over it`);
  }
  return parsed;
}

export async function loadHeadlessConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<HeadlessConfig> {
  const filePath = path.join(dataDir, CONFIG_FILE);
  const stored = await readStoredConfig(filePath);

  const envSignaling = env.SIGNALING_URLS ? parseSignalingUrls(env.SIGNALING_URLS) : null;
  const envIce = env.ICE_SERVERS ? resolveIceServers({ VITE_ICE_SERVERS: env.ICE_SERVERS }) : null;
  const iceServersUrl = env.ICE_SERVERS_URL !== undefined
    ? (resolveIceServersUrl({ VITE_ICE_SERVERS_URL: env.ICE_SERVERS_URL }) ?? undefined)
    : stored.iceServersUrl;
  const iceAccessToken = env.ICE_ACCESS_TOKEN !== undefined ? trimmed(env.ICE_ACCESS_TOKEN) : stored.iceAccessToken;
  const envPort = env.HEADLESS_PORT ? Number.parseInt(env.HEADLESS_PORT, 10) : null;

  const config: HeadlessConfig = {
    controlHost: env.HEADLESS_HOST ?? stored.controlHost ?? '127.0.0.1',
    controlPort: envPort !== null && Number.isFinite(envPort) ? envPort : stored.controlPort ?? DEFAULT_CONTROL_PORT,
    controlToken: env.HEADLESS_TOKEN ?? stored.controlToken ?? generateToken(),
    displayName: env.HEADLESS_DISPLAY_NAME ?? stored.displayName ?? 'Headless Keeper',
    signalingUrls: envSignaling ?? stored.signalingUrls ?? [DEFAULT_SIGNALING_URL],
    ...(envIce ?? stored.iceServers ? { iceServers: envIce ?? stored.iceServers } : {}),
    ...(iceServersUrl ? { iceServersUrl } : {}),
    ...(iceAccessToken ? { iceAccessToken } : {}),
    replicateFiles: env.HEADLESS_REPLICATE_FILES !== undefined
      ? env.HEADLESS_REPLICATE_FILES !== 'false'
      : stored.replicateFiles ?? true,
  };

  const llm = resolveLlm(env, stored.llm);
  if (llm) config.llm = llm;
  const n8n = resolveN8n(env, stored.n8n);
  if (n8n) config.n8n = n8n;
  const appUrl = env.HEADLESS_APP_URL !== undefined ? trimmed(env.HEADLESS_APP_URL) : stored.appUrl;
  if (appUrl) config.appUrl = appUrl.replace(/\/+$/, '');
  if (stored.controlDappId) config.controlDappId = stored.controlDappId;

  await fs.mkdir(dataDir, { recursive: true });
  await writeFileAtomic(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return config;
}

/** Patches run one after the other, so two of them never read the same base and drop each other's field. */
let patchChain: Promise<void> = Promise.resolve();

/** Merge a runtime-discovered value (e.g. the control dapp id) into the persisted config. */
export function patchHeadlessConfig(dataDir: string, patch: Partial<HeadlessConfig>): Promise<void> {
  const filePath = path.join(dataDir, CONFIG_FILE);
  const run = patchChain.then(async () => {
    const stored = await readStoredConfig(filePath);
    await writeFileAtomic(filePath, `${JSON.stringify({ ...stored, ...patch }, null, 2)}\n`, { mode: 0o600 });
  });
  patchChain = run.catch(() => undefined);
  return run;
}
