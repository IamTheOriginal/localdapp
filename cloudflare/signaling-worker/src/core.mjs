/**
 * Runtime-agnostic core for the Cloudflare Workers signaling + quota-guarded
 * ephemeral TURN worker.
 *
 * Separated from `index.mjs` (which imports `DurableObject` from `cloudflare:workers`)
 * so every protocol rule, hibernation recovery path, rate limit, Ed25519 `/ice`
 * proof, monthly quota check, GraphQL sync, and revocation path can be
 * unit-tested directly under Vitest.
 */

const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_MESSAGE_TOO_BIG = 1009;
const MAX_TOPIC_NAME_LENGTH = 512;
const ICE_CACHE_WINDOW_MS = 10 * 60 * 1000;
const ICE_RATE_WINDOW_MS = 60 * 60 * 1000;
const ICE_AUTH_MAX_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_STUN_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const CLOUDFLARE_TURN_API_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const CLOUDFLARE_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

const DEFAULT_TURN_TTL_SECONDS = 1800; // 30 minutes
const DEFAULT_USER_MONTHLY_LIMIT_BYTES = 10 * 1024 * 1024; // 10 MiB / user / month
const DEFAULT_IP_MONTHLY_LIMIT_BYTES = 25 * 1024 * 1024; // 25 MiB / IP-prefix / month
const DEFAULT_ACCOUNT_WARN_BYTES = 800_000_000_000; // 800 GB (80% of 1,000 GB free tier)
const DEFAULT_ACCOUNT_HARD_CAP_BYTES = 950_000_000_000; // 950 GB (95% hard kill-switch)

const textEncoder = new TextEncoder();

export function envInt(env, name, fallback) {
  const parsed = Number.parseInt(String(env?.[name] ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Normalize a client IP into a rate-limit bucket: IPv4 verbatim, IPv4-mapped
 * IPv6 unwrapped, IPv6 grouped by its /64 prefix (one subscriber's prefix).
 */
export function normalizeClientIp(rawAddress) {
  const bare = String(rawAddress ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!bare) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (mapped) return mapped[1];
  const zoneStripped = bare.split('%')[0];
  if (!zoneStripped.includes(':')) return zoneStripped || 'unknown';
  const halves = zoneStripped.split('::');
  if (halves.length > 2) return zoneStripped;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = Math.max(8 - head.length - tail.length, 0);
  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  if (groups.length < 4 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return zoneStripped;
  return `${groups.slice(0, 4).map((g) => Number.parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/** Coarse subscriber prefix for monthly anti-Sybil TURN quotas (/24 IPv4, /64 IPv6). */
export function normalizeIpPrefix(normalizedIp) {
  const v4 = /^(\d+\.\d+\.\d+)\.\d+$/.exec(normalizedIp);
  if (v4) return `${v4[1]}.0/24`;
  return normalizedIp || 'unknown';
}

export function clientIpFromRequest(request) {
  const header = request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-forwarded-for')?.split(',').pop()
    ?? '';
  return normalizeClientIp(header);
}

export function parseAllowedOrigins(env) {
  const raw = String(env?.ALLOWED_ORIGINS ?? '').trim();
  if (!raw) return [];
  return [...new Set(raw.split(/[\s,]+/).map((entry) => entry.trim().replace(/\/+$/, '')).filter(Boolean))];
}

function utcMonth(epochMs) {
  const date = new Date(epochMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function monthDateRange(monthStr) {
  const [yStr, mStr] = monthStr.split('-');
  const year = Number.parseInt(yStr, 10);
  const month = Number.parseInt(mStr, 10);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    dateFrom: `${monthStr}-01`,
    dateTo: `${monthStr}-${String(lastDay).padStart(2, '0')}`,
  };
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBytes = textEncoder.encode(a);
  const bBytes = textEncoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

function bearerToken(request) {
  const auth = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return match ? match[1].trim() : null;
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256ShortHex(input, length = 24) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return bytesToHex(digest).slice(0, length);
}

/**
 * Verify optional Ed25519 device proof headers on `/ice`:
 *   X-Dapp-PubKey:     64-hex raw Ed25519 public key
 *   X-Dapp-Timestamp:  epoch ms (within ±5 min of current time)
 *   X-Dapp-Signature:  128-hex Ed25519 signature over `ice:<origin>:<timestamp>`
 */
export async function verifyIceIdentity(request, nowMs = Date.now()) {
  const pubKeyHex = (request.headers.get('x-dapp-pubkey') ?? '').trim().toLowerCase();
  const timestamp = (request.headers.get('x-dapp-timestamp') ?? '').trim();
  const sigHex = (request.headers.get('x-dapp-signature') ?? '').trim().toLowerCase();
  if (!pubKeyHex || !timestamp || !sigHex) return { verified: false, reason: 'missing' };

  const pubBytes = hexToBytes(pubKeyHex);
  const sigBytes = hexToBytes(sigHex);
  if (!pubBytes || pubBytes.length !== 32 || !sigBytes || sigBytes.length !== 64) {
    return { verified: false, reason: 'malformed' };
  }

  const tsNum = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(tsNum) || Math.abs(nowMs - tsNum) > ICE_AUTH_MAX_SKEW_MS) {
    return { verified: false, reason: 'skew' };
  }

  let origin;
  try {
    origin = new URL(request.url).origin;
  } catch {
    return { verified: false, reason: 'malformed' };
  }

  try {
    const key = await crypto.subtle.importKey('raw', pubBytes, { name: 'Ed25519' }, false, ['verify']);
    const message = textEncoder.encode(`ice:${origin}:${timestamp}`);
    const valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, sigBytes, message);
    if (!valid) return { verified: false, reason: 'invalid' };
    const userId = `u_${await sha256ShortHex(pubKeyHex, 24)}`;
    return { verified: true, userId };
  } catch {
    return { verified: false, reason: 'crypto_error' };
  }
}

function filterBlockedTurnPorts(urls) {
  const list = Array.isArray(urls) ? urls : [urls];
  // Port 53 is blocked by browsers (Cloudflare TURN docs recommendation).
  return list.filter((u) => typeof u === 'string' && !/:53(\?|$)/.test(u));
}

function normalizeCloudflareIcePayload(payload) {
  const rawList = Array.isArray(payload?.iceServers)
    ? payload.iceServers
    : (payload?.iceServers && typeof payload.iceServers === 'object' ? [payload.iceServers] : []);

  const normalized = [];
  const usernames = new Set();
  let hasStun = false;

  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue;
    const urls = filterBlockedTurnPorts(entry.urls);
    if (urls.length === 0) continue;
    if (urls.some((u) => u.startsWith('stun:'))) hasStun = true;
    const item = { urls: urls.length === 1 ? urls[0] : urls };
    if (typeof entry.username === 'string' && entry.username) {
      item.username = entry.username;
      usernames.add(entry.username);
    }
    if (typeof entry.credential === 'string' && entry.credential) {
      item.credential = entry.credential;
    }
    normalized.push(item);
  }

  if (!hasStun) {
    normalized.unshift(...DEFAULT_STUN_SERVERS);
  }

  return {
    iceServers: normalized.length > 0 ? normalized : DEFAULT_STUN_SERVERS,
    usernames: [...usernames],
  };
}

function corsHeaders(origin, allowedOrigins) {
  const headers = { 'Cache-Control': 'no-store' };
  if (allowedOrigins.length === 0) {
    headers['Access-Control-Allow-Origin'] = origin || '*';
  } else if (origin && allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, X-Dapp-PubKey, X-Dapp-Timestamp, X-Dapp-Signature';
  headers['Access-Control-Max-Age'] = '600';
  return headers;
}

function isIceOriginAuthorized(request, env, allowedOrigins) {
  const origin = (request.headers.get('origin') ?? '').trim().replace(/\/+$/, '');
  const accessToken = String(env?.ICE_ACCESS_TOKEN ?? '').trim();
  const providedToken = bearerToken(request);

  if (accessToken && providedToken && constantTimeEqual(providedToken, accessToken)) {
    return { ok: true, origin, isKeeper: true };
  }
  if (allowedOrigins.length === 0) {
    return { ok: true, origin, isKeeper: false };
  }
  if (origin && allowedOrigins.includes(origin)) {
    return { ok: true, origin, isKeeper: false };
  }
  // Browsers omit the `Origin` header on same-origin GET requests, but enforce
  // the forbidden `Sec-Fetch-Site: same-origin` header (cannot be spoofed cross-site).
  const fetchSite = (request.headers.get('sec-fetch-site') ?? '').trim().toLowerCase();
  if (fetchSite === 'same-origin') {
    try {
      const reqOrigin = new URL(request.url).origin;
      if (allowedOrigins.includes(reqOrigin)) {
        return { ok: true, origin: reqOrigin, isKeeper: false };
      }
    } catch {
      // Invalid URL falls through to forbidden.
    }
  }
  return { ok: false, origin, isKeeper: false };
}

function messageByteLength(raw) {
  if (typeof raw === 'string') return textEncoder.encode(raw).byteLength;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  return 0;
}

function decodeMessageText(raw) {
  if (typeof raw === 'string') return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  if (ArrayBuffer.isView(raw)) return new TextDecoder().decode(raw);
  return '';
}

/**
 * SignalingHubCore — y-webrtc topic pub/sub hub + TURN quota/kill-switch
 * authority backed by Durable Object WebSocket Hibernation + SQLite.
 *
 * - Subscriptions live in SQLite (`subscriptions`) so a socket can subscribe to
 *   up to 512 topics and survive DO hibernation intact.
 * - TURN usage quotas (`turn_usage_users`, `turn_user_ips`, `turn_active_creds`,
 *   `turn_meta`) live in the same SQLite database so `/ice` enforcement and the
 *   15-minute GraphQL analytics Cron share strongly consistent state.
 */
export class SignalingHubCore {
  constructor(ctx, env, options = {}) {
    this.ctx = ctx;
    this.env = env ?? {};
    this.now = options.now ?? (() => Date.now());
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.createWebSocketPair = options.createWebSocketPair ?? (() => new WebSocketPair());
    this.createUpgradeResponse = options.createUpgradeResponse ?? ((client) => new Response(null, { status: 101, webSocket: client }));
    this.maxTopicsPerConnection = envInt(this.env, 'MAX_TOPICS_PER_CONNECTION', 512);
    this.maxPayloadBytes = Math.max(envInt(this.env, 'MAX_MESSAGE_BYTES', 128 * 1024), 1024);
    this.messagesPerSecond = Math.max(envInt(this.env, 'MAX_MESSAGES_PER_SECOND', 100), 1);
    this.messageBurst = Math.max(envInt(this.env, 'MESSAGE_BURST', 1000), 1);
    this.maxConnectionsPerIp = envInt(this.env, 'MAX_CONNECTIONS_PER_IP', 64);

    /** topic -> Set<WebSocket> */
    this.topics = new Map();
    /** WebSocket -> Set<string> */
    this.socketTopics = new Map();
    /** WebSocket -> { tokens: number, refilledAt: number } */
    this.rateState = new Map();
    /** Per-user short-lived TURN credential cache (userId -> { keyId, iceServers, expiresAt, credentialExpiresAt }) */
    this.iceCache = new Map();
    /** Per-IP sliding hourly `/ice` request timestamps */
    this.iceRateBuckets = new Map();

    this.initSchema();
    this.hydrate();
  }

  initSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        conn_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        PRIMARY KEY (conn_id, topic)
      );
      CREATE INDEX IF NOT EXISTS idx_sub_topic ON subscriptions(topic);
      CREATE TABLE IF NOT EXISTS turn_usage_users (
        month TEXT NOT NULL,
        user_id TEXT NOT NULL,
        egress_bytes INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (month, user_id)
      );
      CREATE TABLE IF NOT EXISTS turn_user_ips (
        month TEXT NOT NULL,
        ip_prefix TEXT NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (month, ip_prefix, user_id)
      );
      CREATE TABLE IF NOT EXISTS turn_active_creds (
        username TEXT PRIMARY KEY,
        month TEXT NOT NULL,
        user_id TEXT NOT NULL,
        ip_prefix TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turn_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  hydrate() {
    const liveSockets = this.ctx.getWebSockets();
    const byId = new Map();
    for (const ws of liveSockets) {
      const meta = ws.deserializeAttachment?.();
      if (meta && typeof meta.id === 'string') {
        byId.set(meta.id, ws);
        this.socketTopics.set(ws, new Set());
      }
    }

    const staleIds = new Set();
    const cursor = this.ctx.storage.sql.exec('SELECT conn_id, topic FROM subscriptions');
    for (const row of cursor) {
      const connId = String(row.conn_id);
      const topic = String(row.topic);
      const ws = byId.get(connId);
      if (!ws) {
        staleIds.add(connId);
        continue;
      }
      this.addTopicInMemory(ws, topic);
    }

    for (const staleId of staleIds) {
      this.ctx.storage.sql.exec('DELETE FROM subscriptions WHERE conn_id = ?', staleId);
    }
  }

  // ───── SQLite TURN quota helpers ─────

  getMeta(key) {
    const cursor = this.ctx.storage.sql.exec('SELECT value FROM turn_meta WHERE key = ?', key);
    for (const row of cursor) return String(row.value);
    return null;
  }

  setMeta(key, value) {
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO turn_meta (key, value) VALUES (?, ?)',
      key,
      String(value),
    );
  }

  ensureCurrentMonth(month) {
    const storedMonth = this.getMeta('month');
    if (storedMonth === month) return;
    this.setMeta('month', month);
    this.setMeta('account_egress_bytes', '0');
    this.setMeta('account_kill_switch', '0');
    this.iceCache.clear();
    this.ctx.storage.sql.exec('DELETE FROM turn_usage_users WHERE month != ?', month);
    this.ctx.storage.sql.exec('DELETE FROM turn_user_ips WHERE month != ?', month);
    this.ctx.storage.sql.exec('DELETE FROM turn_active_creds WHERE month != ?', month);
  }

  getUserUsageBytes(month, userId) {
    const cursor = this.ctx.storage.sql.exec(
      'SELECT egress_bytes FROM turn_usage_users WHERE month = ? AND user_id = ?',
      month,
      userId,
    );
    for (const row of cursor) return Number(row.egress_bytes) || 0;
    return 0;
  }

  getIpPrefixUsageBytes(month, ipPrefix) {
    const userIds = new Set();
    const ipCursor = this.ctx.storage.sql.exec(
      'SELECT user_id FROM turn_user_ips WHERE month = ? AND ip_prefix = ?',
      month,
      ipPrefix,
    );
    for (const row of ipCursor) userIds.add(String(row.user_id));

    let total = 0;
    for (const uid of userIds) {
      total += this.getUserUsageBytes(month, uid);
    }
    return total;
  }

  upsertUserUsage(month, userId, egressBytes, updatedAt) {
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO turn_usage_users (month, user_id, egress_bytes, updated_at) VALUES (?, ?, ?, ?)',
      month,
      userId,
      Math.max(0, Math.floor(egressBytes)),
      updatedAt,
    );
  }

  recordUserIp(month, ipPrefix, userId) {
    if (!ipPrefix || !userId) return;
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO turn_user_ips (month, ip_prefix, user_id) VALUES (?, ?, ?)',
      month,
      ipPrefix,
      userId,
    );
  }

  recordActiveCreds(month, userId, ipPrefix, usernames, expiresAt) {
    for (const username of usernames) {
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO turn_active_creds (username, month, user_id, ip_prefix, expires_at) VALUES (?, ?, ?, ?, ?)',
        username,
        month,
        userId,
        ipPrefix,
        expiresAt,
      );
    }
  }

  checkIceRateLimit(ip, limitPerHour) {
    if (limitPerHour <= 0) return true;
    const current = this.now();
    const cutoff = current - ICE_RATE_WINDOW_MS;
    const recent = (this.iceRateBuckets.get(ip) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= limitPerHour) {
      this.iceRateBuckets.set(ip, recent);
      return false;
    }
    recent.push(current);
    this.iceRateBuckets.set(ip, recent);
    if (this.iceRateBuckets.size > 4096) {
      for (const [key, entries] of this.iceRateBuckets) {
        if (entries.every((ts) => ts <= cutoff)) this.iceRateBuckets.delete(key);
      }
    }
    return true;
  }

  async mintCloudflareTurn(keyId, apiToken, ttl, customIdentifier) {
    const body = JSON.stringify(customIdentifier ? { ttl, customIdentifier } : { ttl });
    const reqInit = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body,
    };

    // Primary endpoint returns a browser-ready RTCIceServer array; if a
    // Cloudflare API version rejects `customIdentifier` on generate-ice-servers,
    // transparently fall back to `/credentials/generate` which documents it.
    let response = await this.fetchFn(
      `${CLOUDFLARE_TURN_API_BASE}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      reqInit,
    );
    if (response.status === 400 && customIdentifier) {
      response = await this.fetchFn(
        `${CLOUDFLARE_TURN_API_BASE}/${encodeURIComponent(keyId)}/credentials/generate`,
        reqInit,
      );
    }
    if (!response.ok) return null;
    const payload = await response.json();
    return normalizeCloudflareIcePayload(payload);
  }

  async revokeTurnUsername(keyId, apiToken, username) {
    if (!keyId || !apiToken || !username) return false;
    try {
      const response = await this.fetchFn(
        `${CLOUDFLARE_TURN_API_BASE}/${encodeURIComponent(keyId)}/credentials/${encodeURIComponent(username)}/revoke`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiToken}` },
        },
      );
      return response.ok || response.status === 404;
    } catch {
      return false;
    }
  }

  async sendAlertWebhook(level, payload) {
    const webhookUrl = String(this.env?.TURN_ALERT_WEBHOOK_URL ?? '').trim();
    if (!webhookUrl) return false;
    try {
      const res = await this.fetchFn(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Title': level === 'cap'
            ? 'Localdapp TURN hard cap reached (950 GB) — TURN disabled'
            : 'Localdapp TURN warning (800 GB / 1000 GB free tier)',
        },
        body: JSON.stringify({ event: `turn_${level}`, ...payload }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async handleIceRequest(request) {
    const allowedOrigins = parseAllowedOrigins(this.env);
    const origin = (request.headers.get('origin') ?? '').trim().replace(/\/+$/, '');
    const headers = corsHeaders(origin, allowedOrigins);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      return new Response('method not allowed', { status: 405, headers });
    }

    const auth = isIceOriginAuthorized(request, this.env, allowedOrigins);
    if (!auth.ok) {
      return Response.json({ error: 'forbidden' }, { status: 403, headers });
    }

    const limitPerHour = envInt(this.env, 'ICE_RATE_LIMIT_PER_HOUR', 30);
    const ip = clientIpFromRequest(request);
    if (!this.checkIceRateLimit(ip, limitPerHour)) {
      return Response.json({ error: 'rate limited' }, { status: 429, headers: { ...headers, 'Retry-After': '300' } });
    }

    const current = this.now();
    const month = utcMonth(current);
    this.ensureCurrentMonth(month);

    const userLimitBytes = envInt(this.env, 'TURN_USER_MONTHLY_LIMIT_BYTES', DEFAULT_USER_MONTHLY_LIMIT_BYTES);
    const ipLimitBytes = envInt(this.env, 'TURN_IP_MONTHLY_LIMIT_BYTES', DEFAULT_IP_MONTHLY_LIMIT_BYTES);
    const accountHardCapBytes = envInt(this.env, 'TURN_ACCOUNT_HARD_CAP_BYTES', DEFAULT_ACCOUNT_HARD_CAP_BYTES);
    const analyticsSynced = Boolean(this.getMeta('last_sync_at'));

    const keyId = String(this.env?.TURN_KEY_ID ?? '').trim();
    const apiToken = String(this.env?.TURN_KEY_API_TOKEN ?? '').trim();
    if (!keyId || !apiToken) {
      return Response.json({
        iceServers: DEFAULT_STUN_SERVERS,
        ttl: 3600,
        turn: { active: false, reason: 'unconfigured', usedBytes: 0, limitBytes: 0, month, analyticsSynced },
      }, { status: 200, headers });
    }

    const ipPrefix = normalizeIpPrefix(ip);
    let userId;
    if (auth.isKeeper) {
      userId = 'keeper';
    } else {
      const proof = await verifyIceIdentity(request, current);
      userId = proof.verified ? proof.userId : `ip_${await sha256ShortHex(ipPrefix, 24)}`;
    }

    const accountEgress = Number.parseInt(this.getMeta('account_egress_bytes') ?? '0', 10) || 0;
    const killSwitch = this.getMeta('account_kill_switch') === '1'
      || (accountHardCapBytes > 0 && accountEgress >= accountHardCapBytes);

    const userUsedBytes = this.getUserUsageBytes(month, userId);

    if (killSwitch) {
      return Response.json({
        iceServers: DEFAULT_STUN_SERVERS,
        ttl: 3600,
        turn: {
          active: false,
          reason: 'account_cap_reached',
          usedBytes: userUsedBytes,
          limitBytes: userLimitBytes,
          month,
          analyticsSynced,
        },
      }, { status: 200, headers });
    }

    if (!auth.isKeeper && userLimitBytes > 0 && userUsedBytes >= userLimitBytes) {
      return Response.json({
        iceServers: DEFAULT_STUN_SERVERS,
        ttl: 3600,
        turn: {
          active: false,
          reason: 'user_quota_exceeded',
          usedBytes: userUsedBytes,
          limitBytes: userLimitBytes,
          month,
          analyticsSynced,
        },
      }, { status: 200, headers });
    }

    if (!auth.isKeeper && ipLimitBytes > 0) {
      const ipUsedBytes = this.getIpPrefixUsageBytes(month, ipPrefix);
      if (ipUsedBytes >= ipLimitBytes) {
        return Response.json({
          iceServers: DEFAULT_STUN_SERVERS,
          ttl: 3600,
          turn: {
            active: false,
            reason: 'ip_quota_exceeded',
            usedBytes: Math.max(userUsedBytes, userLimitBytes),
            limitBytes: userLimitBytes,
            month,
            analyticsSynced,
          },
        }, { status: 200, headers });
      }
    }

    const ttl = Math.min(Math.max(envInt(this.env, 'TURN_TTL_SECONDS', DEFAULT_TURN_TTL_SECONDS), 300), 86400);
    const cached = this.iceCache.get(userId);
    if (cached && cached.keyId === keyId && cached.month === month && cached.expiresAt > current) {
      const remainingTtl = Math.max(60, Math.floor((cached.credentialExpiresAt - current) / 1000));
      return Response.json({
        iceServers: cached.iceServers,
        ttl: remainingTtl,
        turn: {
          active: true,
          reason: 'ok',
          usedBytes: userUsedBytes,
          limitBytes: userLimitBytes,
          month,
          analyticsSynced,
        },
      }, { status: 200, headers });
    }

    const minted = await this.mintCloudflareTurn(keyId, apiToken, ttl, userId);
    if (!minted) {
      return Response.json({
        error: 'upstream turn error',
        iceServers: DEFAULT_STUN_SERVERS,
        ttl: 300,
        turn: {
          active: false,
          reason: 'upstream_error',
          usedBytes: userUsedBytes,
          limitBytes: userLimitBytes,
          month,
          analyticsSynced,
        },
      }, { status: 502, headers });
    }

    if (!auth.isKeeper) {
      this.recordUserIp(month, ipPrefix, userId);
    }
    const credentialExpiresAt = current + ttl * 1000;
    this.recordActiveCreds(month, userId, ipPrefix, minted.usernames, credentialExpiresAt);

    const cacheDurationMs = Math.min(ICE_CACHE_WINDOW_MS, Math.floor((ttl * 1000) / 4));
    this.iceCache.set(userId, {
      keyId,
      month,
      iceServers: minted.iceServers,
      expiresAt: current + cacheDurationMs,
      credentialExpiresAt,
    });
    if (this.iceCache.size > 4096) {
      for (const [k, v] of this.iceCache) {
        if (v.expiresAt <= current) this.iceCache.delete(k);
      }
    }

    return Response.json({
      iceServers: minted.iceServers,
      ttl,
      turn: {
        active: true,
        reason: 'ok',
        usedBytes: userUsedBytes,
        limitBytes: userLimitBytes,
        month,
        analyticsSynced,
      },
    }, { status: 200, headers });
  }

  /**
   * Cron sync (every 15 minutes): pulls monthly TURN egress from Cloudflare's
   * GraphQL Analytics API, updates SQLite quotas, sends 800 GB / 950 GB alerts,
   * trips the 950 GB hard kill-switch, and revokes any active credentials that
   * exceeded either the per-user (10 MB), per-IP (25 MB), or account (950 GB) cap.
   */
  async syncTurnUsage() {
    const current = this.now();
    const month = utcMonth(current);
    this.ensureCurrentMonth(month);

    // Prune already-expired active credentials.
    this.ctx.storage.sql.exec('DELETE FROM turn_active_creds WHERE expires_at <= ?', current);

    const analyticsToken = String(this.env?.CF_ANALYTICS_TOKEN ?? '').trim();
    const accountId = String(this.env?.CF_ACCOUNT_ID ?? '').trim();
    if (!analyticsToken || !accountId) {
      return { synced: false, reason: 'missing_analytics_config', month };
    }

    const { dateFrom, dateTo } = monthDateRange(month);
    const query = `query TurnQuotaSync($accountId: string!, $dateFrom: Date!, $dateTo: Date!) {
      viewer {
        accounts(filter: { accountTag: $accountId }) {
          accountTotal: callsTurnUsageAdaptiveGroups(
            filter: { date_geq: $dateFrom, date_leq: $dateTo }
            limit: 100
          ) {
            sum { egressBytes }
          }
          byUser: callsTurnUsageAdaptiveGroups(
            filter: { date_geq: $dateFrom, date_leq: $dateTo }
            limit: 10000
            orderBy: [sum_egressBytes_DESC]
          ) {
            dimensions { customIdentifier }
            sum { egressBytes }
          }
        }
      }
    }`;

    const gqlRes = await this.fetchFn(CLOUDFLARE_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${analyticsToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables: { accountId, dateFrom, dateTo } }),
    });

    if (!gqlRes.ok) {
      this.setMeta('last_sync_error', `HTTP ${gqlRes.status}`);
      return { synced: false, reason: `graphql_http_${gqlRes.status}`, month };
    }

    const gqlJson = await gqlRes.json();
    if (Array.isArray(gqlJson?.errors) && gqlJson.errors.length > 0) {
      const msg = String(gqlJson.errors[0]?.message ?? 'graphql error');
      this.setMeta('last_sync_error', msg);
      return { synced: false, reason: 'graphql_error', error: msg, month };
    }

    const accountNode = gqlJson?.data?.viewer?.accounts?.[0];
    const totalRows = Array.isArray(accountNode?.accountTotal) ? accountNode.accountTotal : [];
    const userRows = Array.isArray(accountNode?.byUser) ? accountNode.byUser : [];

    let accountEgressBytes = 0;
    for (const row of totalRows) {
      accountEgressBytes += Number(row?.sum?.egressBytes) || 0;
    }

    for (const row of userRows) {
      const cid = String(row?.dimensions?.customIdentifier ?? '').trim();
      const bytes = Number(row?.sum?.egressBytes) || 0;
      if (cid) {
        this.upsertUserUsage(month, cid, bytes, current);
      }
    }

    this.setMeta('account_egress_bytes', String(Math.floor(accountEgressBytes)));
    this.setMeta('last_sync_at', String(current));
    this.setMeta('last_sync_error', '');

    const warnBytes = envInt(this.env, 'TURN_ACCOUNT_WARN_BYTES', DEFAULT_ACCOUNT_WARN_BYTES);
    const hardCapBytes = envInt(this.env, 'TURN_ACCOUNT_HARD_CAP_BYTES', DEFAULT_ACCOUNT_HARD_CAP_BYTES);
    const userLimitBytes = envInt(this.env, 'TURN_USER_MONTHLY_LIMIT_BYTES', DEFAULT_USER_MONTHLY_LIMIT_BYTES);
    const ipLimitBytes = envInt(this.env, 'TURN_IP_MONTHLY_LIMIT_BYTES', DEFAULT_IP_MONTHLY_LIMIT_BYTES);

    let warnSent = false;
    if (warnBytes > 0 && accountEgressBytes >= warnBytes && this.getMeta('warn_notified_month') !== month) {
      await this.sendAlertWebhook('warning', {
        month,
        accountEgressBytes,
        warnBytes,
        hardCapBytes,
      });
      this.setMeta('warn_notified_month', month);
      warnSent = true;
    }

    let killSwitchTripped = false;
    if (hardCapBytes > 0 && accountEgressBytes >= hardCapBytes) {
      this.setMeta('account_kill_switch', '1');
      this.iceCache.clear();
      killSwitchTripped = true;
      if (this.getMeta('cap_notified_month') !== month) {
        await this.sendAlertWebhook('cap', {
          month,
          accountEgressBytes,
          hardCapBytes,
        });
        this.setMeta('cap_notified_month', month);
      }
    }

    // Revoke active TURN credentials that exceeded account, user, or IP quotas.
    const keyId = String(this.env?.TURN_KEY_ID ?? '').trim();
    const apiToken = String(this.env?.TURN_KEY_API_TOKEN ?? '').trim();
    const activeRows = [];
    const cursor = this.ctx.storage.sql.exec(
      'SELECT username, user_id, ip_prefix, expires_at FROM turn_active_creds WHERE expires_at > ?',
      current,
    );
    for (const row of cursor) {
      activeRows.push({
        username: String(row.username),
        userId: String(row.user_id),
        ipPrefix: String(row.ip_prefix),
      });
    }

    let revokedCount = 0;
    for (const cred of activeRows) {
      const overUser = cred.userId !== 'keeper'
        && userLimitBytes > 0
        && this.getUserUsageBytes(month, cred.userId) >= userLimitBytes;
      const overIp = cred.userId !== 'keeper'
        && ipLimitBytes > 0
        && this.getIpPrefixUsageBytes(month, cred.ipPrefix) >= ipLimitBytes;

      if (killSwitchTripped || overUser || overIp) {
        this.iceCache.delete(cred.userId);
        await this.revokeTurnUsername(keyId, apiToken, cred.username);
        this.ctx.storage.sql.exec('DELETE FROM turn_active_creds WHERE username = ?', cred.username);
        revokedCount += 1;
      }
    }

    return {
      synced: true,
      month,
      accountEgressBytes,
      trackedUsers: userRows.length,
      warnSent,
      killSwitchTripped,
      revokedCount,
    };
  }

  // ───── Signaling pub/sub helpers ─────

  addTopicInMemory(ws, topic) {
    let subs = this.topics.get(topic);
    if (!subs) {
      subs = new Set();
      this.topics.set(topic, subs);
    }
    subs.add(ws);
    let owned = this.socketTopics.get(ws);
    if (!owned) {
      owned = new Set();
      this.socketTopics.set(ws, owned);
    }
    owned.add(topic);
  }

  removeTopicInMemory(ws, topic) {
    const subs = this.topics.get(topic);
    if (subs) {
      subs.delete(ws);
      if (subs.size === 0) this.topics.delete(topic);
    }
    this.socketTopics.get(ws)?.delete(topic);
  }

  countConnectionsForIp(ip) {
    let count = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment?.();
      if (meta?.ip === ip) count += 1;
    }
    return count;
  }

  sendJson(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      this.cleanupSocket(ws);
      try { ws.close(1011, 'send failed'); } catch { /* already closed */ }
    }
  }

  cleanupSocket(ws) {
    const owned = this.socketTopics.get(ws);
    if (owned) {
      for (const topic of owned) {
        const subs = this.topics.get(topic);
        if (subs) {
          subs.delete(ws);
          if (subs.size === 0) this.topics.delete(topic);
        }
      }
      this.socketTopics.delete(ws);
    }
    this.rateState.delete(ws);
    const meta = ws.deserializeAttachment?.();
    if (meta && typeof meta.id === 'string') {
      this.ctx.storage.sql.exec('DELETE FROM subscriptions WHERE conn_id = ?', meta.id);
    }
  }

  handleFetch(request) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('bad request', { status: 400 });
    }

    if (url.pathname === '/ice') {
      return this.handleIceRequest(request);
    }

    if (url.pathname === '/_internal/cron/sync-turn-usage' && request.method === 'POST') {
      return this.syncTurnUsage().then((result) => Response.json(result));
    }

    if (url.pathname === '/health' || url.pathname === '/healthz') {
      const month = utcMonth(this.now());
      this.ensureCurrentMonth(month);
      const turnConfigured = Boolean(String(this.env?.TURN_KEY_ID ?? '').trim() && String(this.env?.TURN_KEY_API_TOKEN ?? '').trim());
      return Response.json({
        status: 'ok',
        connections: this.ctx.getWebSockets().length,
        topics: this.topics.size,
        runtime: 'cloudflare-do',
        turn: {
          configured: turnConfigured,
          killSwitch: this.getMeta('account_kill_switch') === '1',
          month,
          analyticsSynced: Boolean(this.getMeta('last_sync_at')),
        },
      });
    }

    const upgrade = request.headers.get('upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return new Response('y-webrtc signaling server (Cloudflare Durable Object)', { status: 200 });
    }

    const ip = clientIpFromRequest(request);
    if (this.maxConnectionsPerIp > 0 && this.countConnectionsForIp(ip) >= this.maxConnectionsPerIp) {
      return new Response('too many connections', { status: 429 });
    }

    const pair = this.createWebSocketPair();
    const [client, server] = Array.isArray(pair) ? pair : [pair[0], pair[1]];
    const id = crypto.randomUUID();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, ip });
    this.socketTopics.set(server, new Set());
    this.rateState.set(server, { tokens: this.messageBurst, refilledAt: this.now() });

    return this.createUpgradeResponse(client);
  }

  handleWebSocketMessage(ws, raw) {
    if (messageByteLength(raw) > this.maxPayloadBytes) {
      this.cleanupSocket(ws);
      try { ws.close(CLOSE_MESSAGE_TOO_BIG, 'message too big'); } catch { /* already closed */ }
      return;
    }

    const now = this.now();
    let bucket = this.rateState.get(ws);
    if (!bucket) {
      bucket = { tokens: this.messageBurst, refilledAt: now };
      this.rateState.set(ws, bucket);
    }
    bucket.tokens = Math.min(this.messageBurst, bucket.tokens + ((now - bucket.refilledAt) / 1000) * this.messagesPerSecond);
    bucket.refilledAt = now;
    if (bucket.tokens < 1) {
      this.cleanupSocket(ws);
      try { ws.close(CLOSE_POLICY_VIOLATION, 'rate limit'); } catch { /* already closed */ }
      return;
    }
    bucket.tokens -= 1;

    let message;
    try {
      message = JSON.parse(decodeMessageText(raw));
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    const meta = ws.deserializeAttachment?.();
    const connId = typeof meta?.id === 'string' ? meta.id : null;

    switch (message.type) {
      case 'subscribe': {
        const list = Array.isArray(message.topics) ? message.topics : [];
        let owned = this.socketTopics.get(ws);
        if (!owned) {
          owned = new Set();
          this.socketTopics.set(ws, owned);
        }
        for (const topicName of list) {
          if (typeof topicName !== 'string' || topicName.length === 0 || topicName.length > MAX_TOPIC_NAME_LENGTH) continue;
          if (owned.has(topicName)) continue;
          if (owned.size >= this.maxTopicsPerConnection) continue;
          this.addTopicInMemory(ws, topicName);
          if (connId) {
            this.ctx.storage.sql.exec('INSERT OR IGNORE INTO subscriptions (conn_id, topic) VALUES (?, ?)', connId, topicName);
          }
        }
        break;
      }
      case 'unsubscribe': {
        const list = Array.isArray(message.topics) ? message.topics : [];
        for (const topicName of list) {
          if (typeof topicName !== 'string') continue;
          this.removeTopicInMemory(ws, topicName);
          if (connId) {
            this.ctx.storage.sql.exec('DELETE FROM subscriptions WHERE conn_id = ? AND topic = ?', connId, topicName);
          }
        }
        break;
      }
      case 'publish': {
        if (typeof message.topic !== 'string') break;
        const receivers = this.topics.get(message.topic);
        if (!receivers || receivers.size === 0) break;
        const outgoing = { ...message, clients: receivers.size };
        for (const receiver of [...receivers]) {
          this.sendJson(receiver, outgoing);
        }
        break;
      }
      case 'ping': {
        this.sendJson(ws, { type: 'pong' });
        break;
      }
      default:
        break;
    }
  }

  handleWebSocketClose(ws) {
    this.cleanupSocket(ws);
  }

  handleWebSocketError(ws) {
    this.cleanupSocket(ws);
    try { ws.close(1011, 'error'); } catch { /* already closed */ }
  }
}

/**
 * Standalone stateless `/ice` handler retained for backward-compatible testing
 * and stateless deployments without Durable Object quota state.
 */
export function createIceHandler(options = {}) {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => Date.now());
  let cached = null;
  const rateBuckets = new Map();

  function checkRateLimit(ip, limitPerHour) {
    if (limitPerHour <= 0) return true;
    const current = now();
    const cutoff = current - ICE_RATE_WINDOW_MS;
    const recent = (rateBuckets.get(ip) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= limitPerHour) {
      rateBuckets.set(ip, recent);
      return false;
    }
    recent.push(current);
    rateBuckets.set(ip, recent);
    if (rateBuckets.size > 4096) {
      for (const [key, entries] of rateBuckets) {
        if (entries.every((ts) => ts <= cutoff)) rateBuckets.delete(key);
      }
    }
    return true;
  }

  return async function handleIceRequest(request, env) {
    const allowedOrigins = parseAllowedOrigins(env);
    const origin = (request.headers.get('origin') ?? '').trim().replace(/\/+$/, '');
    const headers = corsHeaders(origin, allowedOrigins);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET' && request.method !== 'POST') return new Response('method not allowed', { status: 405, headers });

    const auth = isIceOriginAuthorized(request, env, allowedOrigins);
    if (!auth.ok) return Response.json({ error: 'forbidden' }, { status: 403, headers });

    const limitPerHour = envInt(env, 'ICE_RATE_LIMIT_PER_HOUR', 30);
    const ip = clientIpFromRequest(request);
    if (!checkRateLimit(ip, limitPerHour)) {
      return Response.json({ error: 'rate limited' }, { status: 429, headers: { ...headers, 'Retry-After': '300' } });
    }

    const keyId = String(env?.TURN_KEY_ID ?? '').trim();
    const apiToken = String(env?.TURN_KEY_API_TOKEN ?? '').trim();
    if (!keyId || !apiToken) {
      return Response.json({ iceServers: DEFAULT_STUN_SERVERS, ttl: 3600 }, { status: 200, headers });
    }

    const ttl = Math.min(Math.max(envInt(env, 'TURN_TTL_SECONDS', DEFAULT_TURN_TTL_SECONDS), 300), 86400);
    const current = now();
    if (cached && cached.keyId === keyId && cached.expiresAt > current) {
      const remainingTtl = Math.max(60, Math.floor((cached.credentialExpiresAt - current) / 1000));
      return Response.json({ iceServers: cached.iceServers, ttl: remainingTtl }, { status: 200, headers });
    }

    const response = await fetchFn(`${CLOUDFLARE_TURN_API_BASE}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl }),
    });
    if (!response.ok) {
      return Response.json({ error: 'upstream turn error', iceServers: DEFAULT_STUN_SERVERS, ttl: 300 }, { status: 502, headers });
    }

    const payload = await response.json();
    const { iceServers } = normalizeCloudflareIcePayload(payload);
    const cacheDurationMs = Math.min(ICE_CACHE_WINDOW_MS, Math.floor((ttl * 1000) / 4));
    cached = { keyId, iceServers, expiresAt: current + cacheDurationMs, credentialExpiresAt: current + ttl * 1000 };
    return Response.json({ iceServers, ttl }, { status: 200, headers });
  };
}

export function createWorkerFetch() {
  return async function handleWorkerFetch(request, env) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('bad request', { status: 400 });
    }

    const isWebSocketUpgrade = (request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket';
    const isHubPath = url.pathname === '/signaling'
      || url.pathname === '/ice'
      || url.pathname === '/health'
      || url.pathname === '/healthz'
      || (url.pathname === '/' && (isWebSocketUpgrade || !env.ASSETS));

    if (isHubPath) {
      const stub = env.SIGNALING_HUB.get(env.SIGNALING_HUB.idFromName('global'));
      return stub.fetch(request);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('not found', { status: 404 });
  };
}
