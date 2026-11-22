#!/usr/bin/env node
/**
 * Blind-mailbox Web Push relay (docs/plans/2026-08-31-push-notifications.md).
 *
 * The relay stores opaque inboxes — {inboxId → push subscription + sender
 * allowlist} — and forwards content-free wake-ups. It never sees who a mailbox
 * belongs to or what a wake-up is about; the only authenticated fact is that a
 * sender on the inbox's allowlist asked to wake it. Endpoints:
 *
 *   GET  /health           → {"status":"ok",...}
 *   GET  /vapid            → {"publicKey":"<VAPID public key>"}
 *   POST /register         → create or refresh an inbox
 *        {subscription, allow: [ed25519 hex...], inboxId?, secret?}
 *        → {inboxId, secret, vapidPublicKey}   (secret only on create)
 *   POST /notify/<inboxId> → forward one signed, content-free tickle
 *        {payload: {inboxId, nonce, protocol, schemaVersion, sentAt},
 *         senderPublicKey, signature}
 *        → 204
 *
 * The forwarded Web Push message is payload-less — the service worker shows a
 * constant string — so the signature authenticates the sender to the relay;
 * no content exists to protect in transit.
 *
 * Hardening:
 *  - per-client-address request limit (IPv6 counted by /64); X-Forwarded-For
 *    is honored only when PUSH_RELAY_TRUST_PROXY says a proxy is in front;
 *  - small body cap, tickle freshness window + nonce replay guard;
 *  - every unauthenticated tickle outcome — unknown inbox, sender not on the
 *    allowlist, bad signature — is the same 403, so /notify is no existence
 *    oracle, and the per-inbox limit is charged only AFTER a tickle
 *    authenticated, so strangers who know an inbox id cannot starve it;
 *  - relay-issued ownership secret for refreshes;
 *  - inbox creation capped per client address (per 24 h) and in total;
 *  - subscription endpoints must be https on a known push-service host
 *    (never an IP literal in a private, loopback or link-local range), so the
 *    relay cannot be made to POST to arbitrary or internal hosts;
 *  - dead-subscription GC at send time (404/410 deletes the inbox) and a
 *    periodic sweep of registrations not refreshed within the staleness TTL
 *    (clients re-register at every boot).
 * Bodies are never logged. Storage is a small JSON file, written
 * asynchronously and debounced — losing it only means devices re-register.
 *
 * Env: PUSH_RELAY_PORT (default 4446), HOST (default 0.0.0.0),
 *      PUSH_RELAY_DATA (default ./push-relay-data),
 *      PUSH_RELAY_SUBJECT (VAPID subject, default mailto:admin@localhost),
 *      PUSH_RELAY_STALE_DAYS (default 60),
 *      PUSH_RELAY_MAX_INBOXES (default 50000),
 *      PUSH_RELAY_MAX_NEW_INBOXES_PER_IP (per 24 h, default 20),
 *      PUSH_RELAY_EXTRA_PUSH_HOSTS (comma-separated; `*.host` = any subdomain),
 *      PUSH_RELAY_TRUST_PROXY (1/true: client address from X-Forwarded-For).
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_ALLOWLIST = 128;
const TICKLE_MAX_AGE_MS = 5 * 60 * 1000;
const NONCE_WINDOW = 64;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;
const INBOX_ID = /^[0-9a-f]{32}$/;

/** Push services of the browsers that can run the app; PUSH_RELAY_EXTRA_PUSH_HOSTS extends it. */
export const DEFAULT_PUSH_HOSTS = Object.freeze([
  'fcm.googleapis.com',
  '*.push.apple.com',
  '*.notify.windows.com',
  'updates.push.services.mozilla.com',
  '*.push.services.mozilla.com',
]);

/** Mirrors the client's canonicalizeJson (relationshipStream.ts): sorted-key JSON. */
export function canonicalizeJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error('invalid number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new Error('not canonical JSON');
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`).join(',')}}`;
}

/** Raw 32-byte Ed25519 public key (hex) → Node KeyObject via SPKI DER framing. */
function ed25519PublicKey(hex) {
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(hex, 'hex'),
  ]);
  return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

export function verifyTickleSignature(payload, signatureHex, publicKeyHex) {
  try {
    return crypto.verify(
      null,
      Buffer.from(canonicalizeJson(payload), 'utf8'),
      ed25519PublicKey(publicKeyHex),
      Buffer.from(signatureHex, 'hex'),
    );
  } catch {
    return false;
  }
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Fixed-window counter keyed by an arbitrary string (default window: one minute). */
function createRateLimiter(limitPerWindow, windowMs = 60_000) {
  const windows = new Map();
  return {
    allow(key, now = Date.now()) {
      const window = Math.floor(now / windowMs);
      const entry = windows.get(key);
      if (!entry || entry.window !== window) {
        windows.set(key, { window, count: 1 });
        if (windows.size > 10_000) {
          for (const [candidate, value] of windows) {
            if (value.window !== window) windows.delete(candidate);
          }
        }
        return limitPerWindow >= 1;
      }
      entry.count += 1;
      return entry.count <= limitPerWindow;
    },
  };
}

/** '2001:db8::1' → eight 16-bit numbers; null when it does not parse. */
function expandIpv6(address) {
  let text = address.split('%')[0];
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, -dotted[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(Math.max(missing, 0)).fill('0'), ...tail]
    .map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}

/** True for IP literals the relay must never talk to: private, loopback, link-local, CGNAT, unspecified, multicast. */
export function isNonPublicAddress(address) {
  const bare = String(address).replace(/^\[|\]$/g, '').toLowerCase();
  const family = net.isIP(bare.split('%')[0]);
  if (family === 4) {
    const [a, b] = bare.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (family === 6) {
    const groups = expandIpv6(bare);
    if (!groups) return true;
    const leadingZero = (count) => groups.slice(0, count).every((group) => group === 0);
    if (leadingZero(5) && groups[5] === 0xffff) {
      // IPv4-mapped: judge the embedded IPv4 address.
      return isNonPublicAddress(`${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`);
    }
    const first = groups[0];
    return (leadingZero(7) && (groups[7] === 0 || groups[7] === 1)) // :: and ::1
      || (first & 0xfe00) === 0xfc00 // fc00::/7 unique local
      || (first & 0xffc0) === 0xfe80 // fe80::/10 link-local
      || (first & 0xff00) === 0xff00; // multicast
  }
  return false;
}

/** Rate-limit key for a client address: IPv4 as is, IPv6 by its /64 (one subscriber's whole prefix). */
export function clientKey(address) {
  const bare = String(address ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (mapped) return mapped[1];
  if (net.isIP(bare.split('%')[0]) !== 6) return bare || 'unknown';
  const groups = expandIpv6(bare);
  return groups ? `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64` : bare;
}

/**
 * The address a request is charged to. Behind a reverse proxy every socket
 * comes from the proxy, so the right-most X-Forwarded-For entry (the one the
 * trusted proxy appended) is used — but only when the operator said a proxy
 * is in front; otherwise any client could pick its own bucket.
 */
export function requestAddress(request, trustProxy) {
  if (trustProxy) {
    const header = request.headers['x-forwarded-for'];
    const value = Array.isArray(header) ? header.join(',') : header;
    const last = value?.split(',').map((entry) => entry.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return request.socket.remoteAddress ?? 'unknown';
}

/** `fcm.googleapis.com` matches itself only; `*.push.apple.com` matches any subdomain of push.apple.com. */
function hostMatches(host, pattern) {
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return host === pattern;
}

/** A push endpoint the relay may POST to: https, default port, no credentials, allowlisted public host. */
export function isAllowedPushEndpoint(endpoint, pushHosts = DEFAULT_PUSH_HOSTS) {
  if (typeof endpoint !== 'string' || endpoint.length >= 1024) return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || isNonPublicAddress(host)) return false;
  return pushHosts.some((pattern) => hostMatches(host, pattern));
}

function parseHostList(value) {
  return (value ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function isValidSubscription(value, pushHosts) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && isAllowedPushEndpoint(value.endpoint, pushHosts)
    && value.keys && typeof value.keys === 'object'
    && typeof value.keys.p256dh === 'string' && value.keys.p256dh.length < 256
    && typeof value.keys.auth === 'string' && value.keys.auth.length < 256);
}

function isValidAllowlist(value) {
  return Array.isArray(value) && value.length <= MAX_ALLOWLIST
    && value.every((key) => typeof key === 'string' && HEX_32.test(key));
}

async function readJsonBody(request) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(undefined);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
    request.on('error', () => resolve(undefined));
  });
}

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  response.end(JSON.stringify(body));
}

function envInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Creates the relay. Options (all optional, for embedding and tests):
 *  - dataDir: storage directory (default env PUSH_RELAY_DATA or ./push-relay-data)
 *  - sendPush(subscription): push-service delivery override; the default
 *    lazy-imports the `web-push` package configured with the VAPID keys.
 *  - ipLimitPerMinute / inboxLimitPerMinute: rate-limit caps.
 *  - maxInboxes / maxNewInboxesPerIp: registration caps (total / per client per 24 h).
 *  - extraPushHosts: host patterns allowed besides DEFAULT_PUSH_HOSTS.
 *  - trustProxy: take the client address from X-Forwarded-For.
 *  - staleTtlMs: registrations older than this (by updatedAt) are swept.
 *  - vapidSubject: VAPID contact subject.
 */
export function createPushRelay(options = {}) {
  const dataDir = options.dataDir ?? process.env.PUSH_RELAY_DATA ?? './push-relay-data';
  fs.mkdirSync(dataDir, { recursive: true });

  const vapidPath = path.join(dataDir, 'vapid.json');
  let vapid;
  if (fs.existsSync(vapidPath)) {
    vapid = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
  } else {
    // ECDSA P-256 keypair in the URL-safe base64 form web-push expects.
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const privateJwk = privateKey.export({ format: 'jwk' });
    const toBytes = (b64url) => Buffer.from(b64url, 'base64url');
    vapid = {
      publicKey: Buffer.concat([Buffer.from([0x04]), toBytes(publicJwk.x), toBytes(publicJwk.y)]).toString('base64url'),
      privateKey: toBytes(privateJwk.d).toString('base64url'),
    };
    fs.writeFileSync(vapidPath, JSON.stringify(vapid));
  }

  const inboxPath = path.join(dataDir, 'inboxes.json');
  /** inboxId → {subscription, allow, secretHash, createdAt, updatedAt, nonces?} */
  const inboxes = new Map(fs.existsSync(inboxPath)
    ? Object.entries(JSON.parse(fs.readFileSync(inboxPath, 'utf8')))
    : []);

  let saveTimer = null;
  let writing = null;
  let dirty = false;
  /**
   * Asynchronous, atomic (temp file + rename) and coalescing: a persist
   * requested while one runs marks the state dirty and the running loop
   * writes once more, so at most one write is ever in flight.
   */
  const persist = () => {
    if (writing) {
      dirty = true;
      return writing;
    }
    writing = (async () => {
      do {
        dirty = false;
        // Nonce replay windows are transient; don't persist them.
        const plain = Object.fromEntries([...inboxes].map(([id, inbox]) => [id, { ...inbox, nonces: undefined }]));
        const temporary = `${inboxPath}.tmp`;
        await fs.promises.writeFile(temporary, JSON.stringify(plain));
        await fs.promises.rename(temporary, inboxPath);
      } while (dirty);
    })().catch((error) => {
      console.error('push-relay: could not persist inboxes:', error.message);
    }).finally(() => {
      writing = null;
    });
    return writing;
  };
  const save = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persist();
    }, SAVE_DEBOUNCE_MS);
    saveTimer.unref?.();
  };

  const vapidSubject = options.vapidSubject ?? process.env.PUSH_RELAY_SUBJECT ?? 'mailto:admin@localhost';
  let webPushModule = null;
  const sendPush = options.sendPush ?? (async (subscription) => {
    if (!webPushModule) {
      webPushModule = (await import('web-push')).default;
      webPushModule.setVapidDetails(vapidSubject, vapid.publicKey, vapid.privateKey);
    }
    // Payload-less by design: the client renders a constant string on any
    // push, so the tickle's "fixed-size, zero-content blob" is simply no body.
    await webPushModule.sendNotification(subscription, null, { TTL: 3600, urgency: 'high' });
  });

  const ipLimiter = createRateLimiter(options.ipLimitPerMinute ?? 60);
  const inboxLimiter = createRateLimiter(options.inboxLimitPerMinute ?? 6);
  const maxInboxes = options.maxInboxes ?? envInt('PUSH_RELAY_MAX_INBOXES', 50_000);
  const newInboxLimiter = createRateLimiter(
    options.maxNewInboxesPerIp ?? envInt('PUSH_RELAY_MAX_NEW_INBOXES_PER_IP', 20),
    DAY_MS,
  );
  const pushHosts = [
    ...DEFAULT_PUSH_HOSTS,
    ...(options.extraPushHosts ?? parseHostList(process.env.PUSH_RELAY_EXTRA_PUSH_HOSTS)),
  ];
  const trustProxy = options.trustProxy ?? /^(1|true|yes)$/i.test(process.env.PUSH_RELAY_TRUST_PROXY ?? '');
  const staleTtlMs = options.staleTtlMs
    ?? Number.parseInt(process.env.PUSH_RELAY_STALE_DAYS || '60', 10) * 24 * 60 * 60 * 1000;
  const startedAt = Date.now();

  /** Drops registrations whose owner stopped refreshing them (clients refresh at every boot). */
  function sweepStale(now = Date.now()) {
    let swept = 0;
    for (const [inboxId, inbox] of inboxes) {
      const updatedAt = Date.parse(inbox.updatedAt ?? inbox.createdAt ?? '');
      if (!Number.isFinite(updatedAt) || now - updatedAt > staleTtlMs) {
        inboxes.delete(inboxId);
        swept += 1;
      }
    }
    if (swept > 0) save();
    return swept;
  }
  const sweepTimer = setInterval(() => sweepStale(), SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  function handleRegister(response, body, clientAddressKey) {
    if (!body || !isValidSubscription(body.subscription, pushHosts) || !isValidAllowlist(body.allow)) {
      json(response, 400, { error: 'invalid registration' });
      return;
    }
    if (body.inboxId !== undefined) {
      // Refresh: prove ownership with the secret issued at creation.
      const inbox = typeof body.inboxId === 'string' && INBOX_ID.test(body.inboxId) ? inboxes.get(body.inboxId) : undefined;
      if (!inbox || typeof body.secret !== 'string' || sha256Hex(body.secret) !== inbox.secretHash) {
        json(response, 403, { error: 'unknown inbox or wrong secret' });
        return;
      }
      inbox.subscription = body.subscription;
      inbox.allow = body.allow;
      inbox.updatedAt = new Date().toISOString();
      save();
      json(response, 200, { inboxId: body.inboxId, vapidPublicKey: vapid.publicKey });
      return;
    }
    // Only creation grows the store; refreshes are bounded by the inboxes that exist.
    if (inboxes.size >= maxInboxes) {
      json(response, 503, { error: 'relay full' });
      return;
    }
    if (!newInboxLimiter.allow(clientAddressKey)) {
      json(response, 429, { error: 'registration limit' });
      return;
    }
    const inboxId = crypto.randomBytes(16).toString('hex');
    const secret = crypto.randomBytes(24).toString('hex');
    inboxes.set(inboxId, {
      subscription: body.subscription,
      allow: body.allow,
      secretHash: sha256Hex(secret),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    save();
    json(response, 201, { inboxId, secret, vapidPublicKey: vapid.publicKey });
  }

  async function handleNotify(response, inboxId, body) {
    // Everything before the authentication verdict is independent of whether
    // the inbox exists, and every unauthenticated outcome is the same 403.
    const payload = body?.payload;
    const senderPublicKey = body?.senderPublicKey;
    const signature = body?.signature;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || payload.protocol !== 'push-tickle' || payload.schemaVersion !== 1
      || payload.inboxId !== inboxId
      || typeof payload.nonce !== 'string' || payload.nonce.length === 0 || payload.nonce.length > 64
      || typeof payload.sentAt !== 'string'
      || Object.keys(payload).length !== 5
      || typeof senderPublicKey !== 'string' || !HEX_32.test(senderPublicKey)
      || typeof signature !== 'string' || !HEX_64.test(signature)) {
      json(response, 400, { error: 'malformed tickle' });
      return;
    }
    const age = Math.abs(Date.now() - Date.parse(payload.sentAt));
    if (!Number.isFinite(age) || age > TICKLE_MAX_AGE_MS) {
      json(response, 400, { error: 'stale tickle' });
      return;
    }
    // Verified unconditionally, so an unknown inbox costs what a known one does.
    const signatureValid = verifyTickleSignature(payload, signature, senderPublicKey);
    const inbox = inboxes.get(inboxId);
    if (!signatureValid || !inbox || !inbox.allow.includes(senderPublicKey)) {
      json(response, 403, { error: 'not allowed' });
      return;
    }
    inbox.nonces = inbox.nonces ?? [];
    if (inbox.nonces.includes(payload.nonce)) {
      json(response, 409, { error: 'replayed tickle' });
      return;
    }
    // Charged only for authenticated tickles: strangers cannot drain an inbox's budget.
    if (!inboxLimiter.allow(inboxId)) {
      json(response, 429, { error: 'inbox rate limit' });
      return;
    }
    if (!isAllowedPushEndpoint(inbox.subscription?.endpoint, pushHosts)) {
      // Stored before the host allowlist existed, or the operator narrowed it: never contact it.
      json(response, 502, { error: 'push delivery failed' });
      return;
    }
    inbox.nonces.push(payload.nonce);
    if (inbox.nonces.length > NONCE_WINDOW) inbox.nonces.splice(0, inbox.nonces.length - NONCE_WINDOW);
    try {
      await sendPush(inbox.subscription);
      response.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      response.end();
    } catch (error) {
      const status = error?.statusCode;
      if (status === 404 || status === 410) {
        // Send-time GC: the push service says this subscription is gone.
        inboxes.delete(inboxId);
        save();
      }
      json(response, 502, { error: 'push delivery failed' });
    }
  }

  const server = http.createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url || '/', 'http://localhost');
    } catch {
      json(response, 400, { error: 'bad request' });
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      response.end();
      return;
    }
    if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      json(response, 200, {
        status: 'ok',
        inboxes: inboxes.size,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/vapid') {
      json(response, 200, { publicKey: vapid.publicKey });
      return;
    }
    if (request.method === 'POST') {
      const clientAddressKey = clientKey(requestAddress(request, trustProxy));
      if (!ipLimiter.allow(clientAddressKey)) {
        json(response, 429, { error: 'rate limit' });
        return;
      }
      void readJsonBody(request).then((body) => {
        if (body === undefined) {
          json(response, 400, { error: 'invalid body' });
          return undefined;
        }
        if (url.pathname === '/register') {
          handleRegister(response, body, clientAddressKey);
          return undefined;
        }
        const notifyMatch = /^\/notify\/([0-9a-f]{32})$/.exec(url.pathname);
        if (notifyMatch) return handleNotify(response, notifyMatch[1], body);
        json(response, 404, { error: 'not found' });
        return undefined;
      }).catch(() => json(response, 500, { error: 'internal' }));
      return;
    }
    json(response, 404, { error: 'not found' });
  });

  return {
    server,
    vapidPublicKey: vapid.publicKey,
    inboxCount: () => inboxes.size,
    sweepStale,
    /** Writes the registrations now instead of after the debounce (shutdown, tests). */
    flush: () => persist(),
    listen(port, host) {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    async close() {
      clearInterval(sweepTimer);
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      await persist();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;
if (invokedDirectly) {
  const relay = createPushRelay();
  const port = Number.parseInt(process.env.PUSH_RELAY_PORT || '4446', 10);
  const host = process.env.HOST || '0.0.0.0';
  void relay.listen(port, host).then(() => {
    console.log(`Push relay listening on ${host}:${port} (health: http://${host}:${port}/health)`);
  });
  // Pending registrations reach the disk before a container stop.
  const shutdown = () => {
    setTimeout(() => process.exit(0), 5000).unref();
    void relay.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
