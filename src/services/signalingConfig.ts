/**
 * Signaling endpoint resolution for all WebRTC room managers.
 *
 * Defaults to the same-origin `/signaling` path (the dev server proxies it to the
 * y-webrtc broker). Static deployments without a proxy bake in an explicit
 * endpoint at build time: `VITE_SIGNALING_URL=wss://signal.example.com`.
 * Multiple endpoints may be given (comma or whitespace separated); the member
 * mesh holds a socket to all of them at once, y-webrtc races them.
 *
 * Precedence, highest first:
 *   1. runtime overrides — the headless keeper injects its URLs at boot,
 *   2. the device setting — Settings → Signaling, this device only,
 *   3. the build-time default (`VITE_SIGNALING_URL`, else same-origin).
 */

export function sameOriginSignalingUrl(): string {
  if (typeof window === 'undefined') throw new Error('signaling config: Browser signaling URL is unavailable');
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/signaling`;
}

// ───── Runtime overrides (headless Node runtime) ─────
//
// The browser resolves everything from build-time Vite env; the headless
// runtime has no build step, so it injects its endpoints and a WebRTC
// implementation here at boot (src/headless/env.ts) before any room manager
// runs. Browser builds never call the setter.

interface RuntimeNetworkOverrides {
  /** Explicit signaling endpoints, taking precedence over Vite env resolution. */
  signalingUrls?: string[];
  /** WebRTC implementation handed to simple-peer (`wrtc` option) — Node only. */
  wrtc?: object;
  /** ICE servers taking precedence over Vite env resolution. */
  iceServers?: IceServerEntry[];
}

let runtimeOverrides: RuntimeNetworkOverrides = {};

export function setRuntimeNetworkOverrides(overrides: RuntimeNetworkOverrides): void {
  runtimeOverrides = { ...runtimeOverrides, ...overrides };
  if (overrides.signalingUrls) notifyEndpointChange();
}

export function resolveSignalingUrls(env: { VITE_SIGNALING_URL?: string | undefined } = {}): string[] {
  const configured = (env.VITE_SIGNALING_URL ?? '').trim();
  if (!configured) return [sameOriginSignalingUrl()];
  const urls = [...new Set(configured.split(/[\s,]+/).map((url) => url.trim()).filter(Boolean))];
  if (urls.length === 0) return [sameOriginSignalingUrl()];
  return urls;
}

/** What this build ships with — the fallback whenever this device configured nothing. */
export function defaultSignalingUrls(): string[] {
  return resolveSignalingUrls(import.meta.env as unknown as { VITE_SIGNALING_URL?: string | undefined });
}

// ───── Device-local signaling setting (Settings → Signaling) ─────
//
// Someone who opened the app from somebody else's site can point THIS DEVICE at
// their own signaling server without rebuilding the app. The setting is
// device-local by design: it is never synced, it travels in no document and in
// no invite, and it survives a reload in localStorage. A broker list that
// belongs to a DAPP (invite links, owner-signed in the dapp, moving a dapp
// between brokers) is a later step of the broker feature — see TODO.md.
//
// Consequence to keep in mind wherever this is shown: two devices only find
// each other if they share at least one signaling server.

const DEVICE_SIGNALING_KEY = 'signaling-endpoints';
/** Long enough for a hostname plus a path, short enough to keep junk out of storage. */
export const MAX_SIGNALING_URL_LENGTH = 200;
export const MAX_SIGNALING_URLS = 8;

/** Why an entry was dropped; the settings UI turns these into translated sentences. */
export type SignalingUrlRejection = 'malformed' | 'protocol' | 'tooLong' | 'tooMany';

export interface NormalizedSignalingUrls {
  urls: string[];
  rejected: Array<{ value: string; reason: SignalingUrlRejection }>;
}

/**
 * Validate a user-supplied list: `ws://` or `wss://` only, length-capped,
 * duplicates silently removed (they would open two sockets to one broker).
 */
export function normalizeSignalingUrls(input: readonly string[]): NormalizedSignalingUrls {
  const urls: string[] = [];
  const rejected: NormalizedSignalingUrls['rejected'] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const value = raw.trim();
    if (!value) continue;
    if (value.length > MAX_SIGNALING_URL_LENGTH) {
      rejected.push({ value, reason: 'tooLong' });
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      rejected.push({ value, reason: 'malformed' });
      continue;
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      rejected.push({ value, reason: 'protocol' });
      continue;
    }
    // Credentials in the URL would end up in storage in the clear, and no broker uses them.
    if (!parsed.hostname || parsed.username || parsed.password) {
      rejected.push({ value, reason: 'malformed' });
      continue;
    }
    const key = parsed.href.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    if (urls.length >= MAX_SIGNALING_URLS) {
      rejected.push({ value, reason: 'tooMany' });
      continue;
    }
    seen.add(key);
    urls.push(value);
  }
  return { urls, rejected };
}

// Read once and kept: `signalingEndpoints()` runs on every provider creation and
// on every status poll. Invalidated by the setter and by another tab's write.
let deviceUrlsCache: string[] | null = null;

function readDeviceSignalingUrls(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const stored = localStorage.getItem(DEVICE_SIGNALING_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return normalizeSignalingUrls(parsed.filter((entry): entry is string => typeof entry === 'string')).urls;
  } catch {
    return [];
  }
}

/** The endpoints this device chose; empty means "use the build-time default". */
export function getDeviceSignalingUrls(): string[] {
  deviceUrlsCache ??= readDeviceSignalingUrls();
  return deviceUrlsCache;
}

/**
 * Store this device's endpoints (validated, de-duplicated) and tell everyone
 * listening. An empty list clears the setting — back to the build default.
 * Returns what was actually stored.
 */
export function setDeviceSignalingUrls(input: readonly string[]): string[] {
  const { urls } = normalizeSignalingUrls(input);
  deviceUrlsCache = urls;
  try {
    if (urls.length === 0) localStorage.removeItem(DEVICE_SIGNALING_KEY);
    else localStorage.setItem(DEVICE_SIGNALING_KEY, JSON.stringify(urls));
  } catch {
    // Storage refused (private mode): the choice then holds for this session only.
  }
  notifyEndpointChange();
  return urls;
}

const endpointListeners = new Set<() => void>();

function notifyEndpointChange(): void {
  endpointListeners.forEach((listener) => listener());
}

/**
 * Called whenever the effective endpoint list may have changed, so the member
 * mesh can pick up a new broker without a reload (blobRoomManager). y-webrtc
 * providers read the list when they are created, so rooms that are already
 * open keep their old server until they are reopened.
 */
export function subscribeSignalingEndpoints(listener: () => void): () => void {
  endpointListeners.add(listener);
  return () => {
    endpointListeners.delete(listener);
  };
}

if (typeof window !== 'undefined') {
  // Another tab of this device changed the setting (or storage was cleared).
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== DEVICE_SIGNALING_KEY) return;
    deviceUrlsCache = null;
    notifyEndpointChange();
  });
}

/** Convenience for room managers: runtime overrides, then the device setting, then build-time env. */
export function signalingEndpoints(): string[] {
  if (runtimeOverrides.signalingUrls && runtimeOverrides.signalingUrls.length > 0) {
    return runtimeOverrides.signalingUrls;
  }
  const device = getDeviceSignalingUrls();
  if (device.length > 0) return device;
  return defaultSignalingUrls();
}

// ───── ICE / TURN configuration ─────
//
// Without a TURN relay, peers behind symmetric NAT cannot connect at all.
// Deployments may provide either:
//   - a static JSON RTCIceServer array:
//       VITE_ICE_SERVERS='[{"urls":"stun:stun.example.com:3478"},…]'
//   - or a dynamic ephemeral-credential endpoint (e.g. Cloudflare Worker `/ice`
//     backed by Cloudflare Realtime TURN, see docs/CLOUDFLARE.md):
//       VITE_ICE_SERVERS_URL='https://dapp-signaling.example.workers.dev/ice'
// When neither is set, WebRTC runs with browser defaults (host + srflx only).

export interface IceServerEntry {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// ───── Device-local custom ICE / TURN servers (Settings → Signaling) ─────
//
// Lets a user plug in their own STUN/TURN server (e.g. a free personal
// Cloudflare Realtime TURN key or self-hosted coturn) on THIS device only.
// Never synced, never included in invites. When non-empty, beats both the
// built-in `/ice` relay (so the user's shared free quota is untouched) and
// static build-time `VITE_ICE_SERVERS`.

const DEVICE_ICE_KEY = 'device-ice-servers';
export const MAX_ICE_SERVERS = 8;
export const MAX_ICE_URL_LENGTH = 200;
export const MAX_ICE_CREDENTIAL_LENGTH = 256;

export type IceServerRejection = 'malformed' | 'protocol' | 'tooLong' | 'tooMany';

export interface NormalizedDeviceIceServers {
  servers: IceServerEntry[];
  rejected: Array<{ value: string; reason: IceServerRejection }>;
}

const VALID_ICE_SCHEME = /^(stuns?|turns?):/i;

function validateIceUrl(raw: string): { ok: true; value: string } | { ok: false; reason: IceServerRejection } {
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'malformed' };
  if (value.length > MAX_ICE_URL_LENGTH) return { ok: false, reason: 'tooLong' };
  if (!VALID_ICE_SCHEME.test(value)) {
    return { ok: false, reason: /^[a-z][a-z0-9+.-]*:/i.test(value) ? 'protocol' : 'malformed' };
  }
  const rest = value.replace(VALID_ICE_SCHEME, '');
  // Must have a host (no whitespace, no embedded userinfo).
  if (!rest || /\s/.test(rest) || rest.includes('@') || rest.startsWith('//')) {
    return { ok: false, reason: 'malformed' };
  }
  const hostPart = rest.split('?')[0];
  if (!hostPart || !/^[a-z0-9.[\]-]+(:\d{1,5})?$/i.test(hostPart)) {
    return { ok: false, reason: 'malformed' };
  }
  return { ok: true, value };
}

export function normalizeDeviceIceServers(input: readonly IceServerEntry[]): NormalizedDeviceIceServers {
  const servers: IceServerEntry[] = [];
  const rejected: NormalizedDeviceIceServers['rejected'] = [];
  const seen = new Set<string>();

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const rawUrls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    const validUrls: string[] = [];
    let failed: { value: string; reason: IceServerRejection } | null = null;

    for (const rawUrl of rawUrls) {
      if (typeof rawUrl !== 'string') continue;
      const checked = validateIceUrl(rawUrl);
      if (!checked.ok) {
        failed ??= { value: rawUrl.trim(), reason: checked.reason };
      } else if (!validUrls.includes(checked.value)) {
        validUrls.push(checked.value);
      }
    }

    if (validUrls.length === 0) {
      if (failed) rejected.push(failed);
      continue;
    }

    const username = typeof entry.username === 'string' ? entry.username.trim() : '';
    const credential = typeof entry.credential === 'string' ? entry.credential.trim() : '';
    if (username.length > MAX_ICE_CREDENTIAL_LENGTH || credential.length > MAX_ICE_CREDENTIAL_LENGTH) {
      rejected.push({ value: validUrls[0], reason: 'tooLong' });
      continue;
    }

    const key = `${validUrls.join(',').toLowerCase()}|${username}`;
    if (seen.has(key)) continue;
    if (servers.length >= MAX_ICE_SERVERS) {
      rejected.push({ value: validUrls[0], reason: 'tooMany' });
      continue;
    }
    seen.add(key);

    const normalized: IceServerEntry = { urls: validUrls.length === 1 ? validUrls[0] : validUrls };
    if (username) normalized.username = username;
    if (credential) normalized.credential = credential;
    servers.push(normalized);
  }

  return { servers, rejected };
}

let deviceIceCache: IceServerEntry[] | null = null;

function readDeviceIceServers(): IceServerEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const stored = localStorage.getItem(DEVICE_ICE_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return normalizeDeviceIceServers(parsed as IceServerEntry[]).servers;
  } catch {
    return [];
  }
}

/** Custom ICE/TURN servers configured on this device; empty means "use built-in relay". */
export function getDeviceIceServers(): IceServerEntry[] {
  deviceIceCache ??= readDeviceIceServers();
  return deviceIceCache;
}

const iceConfigListeners = new Set<() => void>();

function notifyIceConfigChange(): void {
  iceConfigListeners.forEach((listener) => listener());
}

/** Subscribe to changes in device-local custom TURN servers or built-in TURN quota status. */
export function subscribeIceConfig(listener: () => void): () => void {
  iceConfigListeners.add(listener);
  return () => {
    iceConfigListeners.delete(listener);
  };
}

/** Persist this device's custom ICE/TURN servers (empty restores the built-in relay). */
export function setDeviceIceServers(input: readonly IceServerEntry[]): IceServerEntry[] {
  const { servers } = normalizeDeviceIceServers(input);
  deviceIceCache = servers;
  try {
    if (servers.length === 0) localStorage.removeItem(DEVICE_ICE_KEY);
    else localStorage.setItem(DEVICE_ICE_KEY, JSON.stringify(servers));
  } catch {
    // Storage refused (private mode): holds for this session only.
  }
  notifyIceConfigChange();
  return servers;
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== DEVICE_ICE_KEY) return;
    deviceIceCache = null;
    notifyIceConfigChange();
  });
}

export function parseIceServersList(raw: unknown): IceServerEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const servers: IceServerEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as { urls?: unknown; username?: unknown; credential?: unknown };
    const urlsValid = typeof candidate.urls === 'string'
      || (Array.isArray(candidate.urls) && candidate.urls.length > 0 && candidate.urls.every((url) => typeof url === 'string'));
    if (!urlsValid) continue;
    const normalized: IceServerEntry = { urls: candidate.urls as string | string[] };
    if (typeof candidate.username === 'string') normalized.username = candidate.username;
    if (typeof candidate.credential === 'string') normalized.credential = candidate.credential;
    servers.push(normalized);
  }
  return servers.length > 0 ? servers : null;
}

export function resolveIceServers(env: { VITE_ICE_SERVERS?: string | undefined } = {}): IceServerEntry[] | null {
  const configured = (env.VITE_ICE_SERVERS ?? '').trim();
  if (!configured) return null;
  try {
    const parsed: unknown = JSON.parse(configured);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parseIceServersList(parsed);
  } catch (error) {
    console.error('signaling config: VITE_ICE_SERVERS is not a valid RTCIceServer JSON array — ignoring', error);
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
}

/**
 * Validate a dynamic ICE-server endpoint URL: `https://` everywhere, or
 * `http://` on loopback only (local testing). Credentials in the URL are refused.
 */
export function resolveIceServersUrl(env: { VITE_ICE_SERVERS_URL?: string | undefined } = {}): string | null {
  const raw = (env.VITE_ICE_SERVERS_URL ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password || !parsed.hostname) return null;
    if (parsed.protocol === 'https:') return parsed.href;
    if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) return parsed.href;
    return null;
  } catch {
    return null;
  }
}

export function defaultIceServersUrl(): string | null {
  return resolveIceServersUrl(import.meta.env as unknown as { VITE_ICE_SERVERS_URL?: string | undefined });
}

const MIN_ICE_REFRESH_MS = 5 * 60 * 1000;
const MAX_ICE_REFRESH_MS = 12 * 60 * 60 * 1000;
const DEFAULT_ICE_TTL_SECONDS = 3600;
const INITIAL_ICE_RETRY_MS = 30_000;
const MAX_ICE_RETRY_MS = 5 * 60 * 1000;

export type DynamicTurnReason =
  | 'ok'
  | 'user_quota_exceeded'
  | 'ip_quota_exceeded'
  | 'account_cap_reached'
  | 'unconfigured'
  | 'upstream_error'
  | 'unknown';

export interface DynamicTurnStatus {
  active: boolean;
  reason: DynamicTurnReason;
  usedBytes: number;
  limitBytes: number;
  month: string;
  analyticsSynced: boolean;
  fetchedAt: number;
}

export type IceRequestSigner = (
  url: string,
  timestamp: string,
) => Promise<{ publicKey: string; signature: string } | null>;

let dynamicIceServers: IceServerEntry[] | null = null;
let dynamicTurnStatus: DynamicTurnStatus | null = null;

export function getDynamicIceStatus(): DynamicTurnStatus | null {
  return dynamicTurnStatus;
}

const KNOWN_TURN_REASONS = new Set<DynamicTurnReason>([
  'ok',
  'user_quota_exceeded',
  'ip_quota_exceeded',
  'account_cap_reached',
  'unconfigured',
  'upstream_error',
]);

function parseDynamicTurnStatus(raw: unknown): DynamicTurnStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.active !== 'boolean') return null;
  const rawReason = typeof obj.reason === 'string' ? obj.reason : 'unknown';
  const reason: DynamicTurnReason = KNOWN_TURN_REASONS.has(rawReason as DynamicTurnReason)
    ? (rawReason as DynamicTurnReason)
    : 'unknown';
  return {
    active: obj.active,
    reason,
    usedBytes: typeof obj.usedBytes === 'number' && Number.isFinite(obj.usedBytes) ? Math.max(0, obj.usedBytes) : 0,
    limitBytes: typeof obj.limitBytes === 'number' && Number.isFinite(obj.limitBytes) ? Math.max(0, obj.limitBytes) : 0,
    month: typeof obj.month === 'string' ? obj.month : '',
    analyticsSynced: Boolean(obj.analyticsSynced),
    fetchedAt: Date.now(),
  };
}

export interface DynamicIceFetchResult {
  iceServers: IceServerEntry[];
  ttlSeconds: number;
  turn?: DynamicTurnStatus;
}

/**
 * Fetch ephemeral ICE/TURN servers once from `url` (e.g. the Cloudflare Worker `/ice`
 * endpoint). Optionally attaches an Ed25519 device proof for monthly per-user quota
 * attribution. Returns null on network/HTTP/validation errors — callers keep working
 * with STUN/browser defaults rather than failing startup.
 */
export async function fetchDynamicIceServers(
  url: string,
  options: { token?: string; signRequest?: IceRequestSigner; fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<DynamicIceFetchResult | null> {
  const fetchFn = options.fetchFn ?? (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) return null;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutMs = options.timeoutMs ?? 8000;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.token?.trim()) headers.Authorization = `Bearer ${options.token.trim()}`;
    if (options.signRequest) {
      const timestamp = String(Date.now());
      const proof = await options.signRequest(url, timestamp);
      if (proof) {
        headers['X-Dapp-PubKey'] = proof.publicKey;
        headers['X-Dapp-Timestamp'] = timestamp;
        headers['X-Dapp-Signature'] = proof.signature;
      }
    }
    const response = await fetchFn(url, {
      method: 'GET',
      headers,
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    let iceServers: IceServerEntry[] | null = null;
    let ttlSeconds = DEFAULT_ICE_TTL_SECONDS;
    let turn: DynamicTurnStatus | null = null;
    if (Array.isArray(payload)) {
      iceServers = parseIceServersList(payload);
    } else if (payload && typeof payload === 'object') {
      const obj = payload as { iceServers?: unknown; ttl?: unknown; turn?: unknown };
      iceServers = parseIceServersList(obj.iceServers);
      if (typeof obj.ttl === 'number' && Number.isFinite(obj.ttl) && obj.ttl > 0) {
        ttlSeconds = obj.ttl;
      }
      turn = parseDynamicTurnStatus(obj.turn);
    }
    if (!iceServers) return null;
    dynamicIceServers = iceServers;
    if (turn) {
      dynamicTurnStatus = turn;
      notifyIceConfigChange();
    }
    return { iceServers, ttlSeconds, ...(turn ? { turn } : {}) };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Start background fetching + periodic renewal of ephemeral TURN credentials.
 * No-op when neither `options.url` nor `VITE_ICE_SERVERS_URL` is configured.
 * Pauses shared `/ice` fetches whenever custom device TURN servers are configured
 * so the user's free monthly quota stays untouched; resumes immediately if cleared.
 */
export function startDynamicIceServers(
  options: { url?: string | null; token?: string; signRequest?: IceRequestSigner; fetchFn?: typeof fetch } = {},
): () => void {
  const resolved = options.url !== undefined
    ? (options.url ? resolveIceServersUrl({ VITE_ICE_SERVERS_URL: options.url }) : null)
    : resolveIceServersUrl(import.meta.env as unknown as { VITE_ICE_SERVERS_URL?: string | undefined });
  if (!resolved) return () => undefined;

  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryDelayMs = INITIAL_ICE_RETRY_MS;
  let hadCustomServers = getDeviceIceServers().length > 0;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const schedule = (delayMs: number) => {
    if (disposed) return;
    clearTimer();
    timer = setTimeout(() => { void tick(); }, delayMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  };

  const tick = async () => {
    if (disposed) return;
    if (getDeviceIceServers().length > 0) return;
    const result = await fetchDynamicIceServers(resolved, {
      ...(options.token ? { token: options.token } : {}),
      ...(options.signRequest ? { signRequest: options.signRequest } : {}),
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    });
    if (disposed) return;
    if (result) {
      retryDelayMs = INITIAL_ICE_RETRY_MS;
      const refreshMs = Math.min(MAX_ICE_REFRESH_MS, Math.max(MIN_ICE_REFRESH_MS, Math.floor(result.ttlSeconds * 750)));
      schedule(refreshMs);
    } else {
      schedule(retryDelayMs);
      retryDelayMs = Math.min(MAX_ICE_RETRY_MS, retryDelayMs * 2);
    }
  };

  const unsubscribe = subscribeIceConfig(() => {
    if (disposed) return;
    const hasCustom = getDeviceIceServers().length > 0;
    if (hasCustom) {
      clearTimer();
    } else if (hadCustomServers) {
      void tick();
    }
    hadCustomServers = hasCustom;
  });

  if (!hadCustomServers) {
    void tick();
  }

  return () => {
    disposed = true;
    clearTimer();
    unsubscribe();
  };
}

/** Test-only reset for cached dynamic ICE servers and TURN status. */
export function resetDynamicIceServersForTests(): void {
  dynamicIceServers = null;
  dynamicTurnStatus = null;
}

/**
 * simple-peer options for every WebrtcProvider: custom ICE servers when
 * configured (runtime override > device custom TURN > dynamic ephemeral
 * credentials > build-time static), an injected `wrtc` implementation under
 * the headless runtime, `undefined` otherwise.
 */
export function webrtcPeerOpts(): { config?: { iceServers: IceServerEntry[] }; wrtc?: object } | undefined {
  const deviceIce = getDeviceIceServers();
  const iceServers = runtimeOverrides.iceServers
    ?? (deviceIce.length > 0 ? deviceIce : null)
    ?? dynamicIceServers
    ?? resolveIceServers(import.meta.env as unknown as { VITE_ICE_SERVERS?: string | undefined });
  const opts: { config?: { iceServers: IceServerEntry[] }; wrtc?: object } = {};
  if (iceServers) opts.config = { iceServers };
  if (runtimeOverrides.wrtc) opts.wrtc = runtimeOverrides.wrtc;
  return Object.keys(opts).length > 0 ? opts : undefined;
}
