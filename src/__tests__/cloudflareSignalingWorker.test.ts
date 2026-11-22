import { describe, expect, it, vi } from 'vitest';
import {
  SignalingHubCore,
  createIceHandler,
  createWorkerFetch,
  normalizeClientIp,
  normalizeIpPrefix,
  verifyIceIdentity,
  type DurableObjectStateLike,
  type HibernatableWebSocket,
  type SignalingWorkerEnv,
} from '../../cloudflare/signaling-worker/src/core.mjs';

/** Minimal pure-JS SQLite harness covering subscriptions + TURN quota tables. */
function createMockDurableObjectState() {
  const rows = new Map<string, Set<string>>(); // conn_id -> Set<topic>
  const turnUsageUsers = new Map<string, { month: string; user_id: string; egress_bytes: number; updated_at: number }>();
  const turnUserIps = new Set<string>(); // `${month}|${ip_prefix}|${user_id}`
  const turnActiveCreds = new Map<string, { username: string; month: string; user_id: string; ip_prefix: string; expires_at: number }>();
  const turnMeta = new Map<string, string>();
  const liveSockets = new Set<FakeServerSocket>();

  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const normalized = query.replace(/\s+/g, ' ').trim().toUpperCase();
      if (normalized.startsWith('CREATE TABLE') || normalized.startsWith('CREATE INDEX')) {
        return [][Symbol.iterator]();
      }
      // ── subscriptions ──
      if (normalized.startsWith('SELECT CONN_ID, TOPIC FROM SUBSCRIPTIONS')) {
        const result: Array<{ conn_id: string; topic: string }> = [];
        for (const [connId, topics] of rows) {
          for (const topic of topics) result.push({ conn_id: connId, topic });
        }
        return result[Symbol.iterator]();
      }
      if (normalized.startsWith('INSERT OR IGNORE INTO SUBSCRIPTIONS')) {
        const [connId, topic] = bindings as [string, string];
        let set = rows.get(connId);
        if (!set) {
          set = new Set();
          rows.set(connId, set);
        }
        set.add(topic);
        return [][Symbol.iterator]();
      }
      if (normalized.startsWith('DELETE FROM SUBSCRIPTIONS WHERE CONN_ID = ? AND TOPIC = ?')) {
        const [connId, topic] = bindings as [string, string];
        rows.get(connId)?.delete(topic);
        if (rows.get(connId)?.size === 0) rows.delete(connId);
        return [][Symbol.iterator]();
      }
      if (normalized.startsWith('DELETE FROM SUBSCRIPTIONS WHERE CONN_ID = ?')) {
        const [connId] = bindings as [string];
        rows.delete(connId);
        return [][Symbol.iterator]();
      }
      // ── turn_meta ──
      if (normalized.startsWith('SELECT VALUE FROM TURN_META WHERE KEY = ?')) {
        const [key] = bindings as [string];
        const value = turnMeta.get(key);
        return (value !== undefined ? [{ value }] : [])[Symbol.iterator]();
      }
      if (normalized.startsWith('INSERT OR REPLACE INTO TURN_META')) {
        const [key, value] = bindings as [string, string];
        turnMeta.set(key, value);
        return [][Symbol.iterator]();
      }
      // ── turn_usage_users ──
      if (normalized.startsWith('SELECT EGRESS_BYTES FROM TURN_USAGE_USERS WHERE MONTH = ? AND USER_ID = ?')) {
        const [month, userId] = bindings as [string, string];
        const row = turnUsageUsers.get(`${month}|${userId}`);
        return (row ? [{ egress_bytes: row.egress_bytes }] : [])[Symbol.iterator]();
      }
      if (normalized.startsWith('INSERT OR REPLACE INTO TURN_USAGE_USERS')) {
        const [month, userId, egressBytes, updatedAt] = bindings as [string, string, number, number];
        turnUsageUsers.set(`${month}|${userId}`, { month, user_id: userId, egress_bytes: egressBytes, updated_at: updatedAt });
        return [][Symbol.iterator]();
      }
      if (normalized.startsWith('DELETE FROM TURN_USAGE_USERS WHERE MONTH != ?')) {
        const [month] = bindings as [string];
        for (const [k, v] of turnUsageUsers) {
          if (v.month !== month) turnUsageUsers.delete(k);
        }
        return [][Symbol.iterator]();
      }
      // ── turn_user_ips ──
      if (normalized.startsWith('SELECT USER_ID FROM TURN_USER_IPS WHERE MONTH = ? AND IP_PREFIX = ?')) {
        const [month, ipPrefix] = bindings as [string, string];
        const prefix = `${month}|${ipPrefix}|`;
        const out: Array<{ user_id: string }> = [];
        for (const entry of turnUserIps) {
          if (entry.startsWith(prefix)) out.push({ user_id: entry.slice(prefix.length) });
        }
        return out[Symbol.iterator]();
      }
      if (normalized.startsWith('INSERT OR IGNORE INTO TURN_USER_IPS')) {
        const [month, ipPrefix, userId] = bindings as [string, string, string];
        turnUserIps.add(`${month}|${ipPrefix}|${userId}`);
        return [][Symbol.iterator]();
      }
      if (normalized.startsWith('DELETE FROM TURN_USER_IPS WHERE MONTH != ?')) {
        const [month] = bindings as [string];
        for (const entry of [...turnUserIps]) {
          if (!entry.startsWith(`${month}|`)) turnUserIps.delete(entry);
        }
        return [][Symbol.iterator]();
      }
      // ── turn_active_creds ──
      if (normalized.startsWith('INSERT OR REPLACE INTO TURN_ACTIVE_CREDS')) {
        const [username, month, userId, ipPrefix, expiresAt] = bindings as [string, string, string, string, number];
        turnActiveCreds.set(username, { username, month, user_id: userId, ip_prefix: ipPrefix, expires_at: expiresAt });
        return [][Symbol.iterator]();
      }
      if (normalized.startsWith('SELECT USERNAME, USER_ID, IP_PREFIX, EXPIRES_AT FROM TURN_ACTIVE_CREDS WHERE EXPIRES_AT > ?')) {
        const [cutoff] = bindings as [number];
        const out = [...turnActiveCreds.values()].filter((c) => c.expires_at > cutoff);
        return out[Symbol.iterator]();
      }
      if (normalized.startsWith('DELETE FROM TURN_ACTIVE_CREDS WHERE MONTH != ?')) {
        const [month] = bindings as [string];
        for (const [k, v] of turnActiveCreds) {
          if (v.month !== month) turnActiveCreds.delete(k);
        }
        return [][Symbol.iterator]();
      }
      if (normalized.startsWith('DELETE FROM TURN_ACTIVE_CREDS WHERE EXPIRES_AT <= ?')) {
        const [cutoff] = bindings as [number];
        for (const [k, v] of turnActiveCreds) {
          if (v.expires_at <= cutoff) turnActiveCreds.delete(k);
        }
        return [][Symbol.iterator]();
      }
      if (normalized.startsWith('DELETE FROM TURN_ACTIVE_CREDS WHERE USERNAME = ?')) {
        const [username] = bindings as [string];
        turnActiveCreds.delete(username);
        return [][Symbol.iterator]();
      }
      throw new Error(`Unexpected SQL in test harness: ${query}`);
    },
  };

  class FakeServerSocket implements HibernatableWebSocket {
    sent: string[] = [];
    closed: { code?: number; reason?: string } | null = null;
    private attachment: unknown = null;

    send(message: string): void {
      if (this.closed) throw new Error('socket closed');
      this.sent.push(message);
    }

    close(code?: number, reason?: string): void {
      this.closed = { code, reason };
      liveSockets.delete(this);
    }

    serializeAttachment(value: unknown): void {
      this.attachment = structuredClone(value);
    }

    deserializeAttachment(): unknown {
      return this.attachment;
    }

    messages(): Array<Record<string, unknown>> {
      return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
    }
  }

  const ctx: DurableObjectStateLike = {
    storage: { sql },
    acceptWebSocket(ws: HibernatableWebSocket) {
      liveSockets.add(ws as FakeServerSocket);
    },
    getWebSockets() {
      return [...liveSockets];
    },
  };

  const createPair = (): [FakeServerSocket, FakeServerSocket] => {
    const client = new FakeServerSocket();
    const server = new FakeServerSocket();
    return [client, server];
  };

  // Standard Node undici Response forbids status 101 (Cloudflare Workers extends Response for WS upgrades).
  const createUpgradeResponse = (client: HibernatableWebSocket) => ({ status: 101, webSocket: client }) as unknown as Response;

  return {
    ctx, rows, turnUsageUsers, turnUserIps, turnActiveCreds, turnMeta,
    liveSockets, createPair, createUpgradeResponse, FakeServerSocket,
  };
}

function wsUpgradeRequest(ip = '203.0.113.10', path = '/signaling'): Request {
  return new Request(`https://signal.example.workers.dev${path}`, {
    headers: { Upgrade: 'websocket', 'CF-Connecting-IP': ip },
  });
}

async function createSignedIceRequest(
  url: string,
  nowMs: number,
  extraHeaders: Record<string, string> = {},
): Promise<{ request: Request; pubKeyHex: string; pair: CryptoKeyPair }> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pubKeyHex = Array.from(pubRaw, (b) => b.toString(16).padStart(2, '0')).join('');
  const timestamp = String(nowMs);
  const origin = new URL(url).origin;
  const sigBuf = await crypto.subtle.sign(
    { name: 'Ed25519' },
    pair.privateKey,
    new TextEncoder().encode(`ice:${origin}:${timestamp}`),
  );
  const sigHex = Array.from(new Uint8Array(sigBuf), (b) => b.toString(16).padStart(2, '0')).join('');
  const request = new Request(url, {
    headers: {
      'X-Dapp-PubKey': pubKeyHex,
      'X-Dapp-Timestamp': timestamp,
      'X-Dapp-Signature': sigHex,
      ...extraHeaders,
    },
  });
  return { request, pubKeyHex, pair };
}

describe('Cloudflare SignalingHubCore (DO + WebSocket Hibernation)', () => {
  it('handles subscribe, publish (with clients count including sender), unsubscribe, and ping', () => {
    const harness = createMockDurableObjectState();
    const hub = new SignalingHubCore(harness.ctx, {}, { createWebSocketPair: harness.createPair, createUpgradeResponse: harness.createUpgradeResponse });

    const r1 = hub.handleFetch(wsUpgradeRequest('203.0.113.1')) as Response;
    const r2 = hub.handleFetch(wsUpgradeRequest('203.0.113.2')) as Response;
    expect(r1.status).toBe(101);
    expect(r2.status).toBe(101);

    const [s1, s2] = harness.ctx.getWebSockets() as Array<InstanceType<typeof harness.FakeServerSocket>>;
    hub.handleWebSocketMessage(s1, JSON.stringify({ type: 'subscribe', topics: ['room-a'] }));
    hub.handleWebSocketMessage(s2, JSON.stringify({ type: 'subscribe', topics: ['room-a', 'room-b'] }));

    hub.handleWebSocketMessage(s1, JSON.stringify({ type: 'publish', topic: 'room-a', data: 'hello' }));
    expect(s1.messages()).toEqual([{ type: 'publish', topic: 'room-a', data: 'hello', clients: 2 }]);
    expect(s2.messages()).toEqual([{ type: 'publish', topic: 'room-a', data: 'hello', clients: 2 }]);

    hub.handleWebSocketMessage(s2, JSON.stringify({ type: 'unsubscribe', topics: ['room-a'] }));
    hub.handleWebSocketMessage(s1, JSON.stringify({ type: 'publish', topic: 'room-a', data: 'solo' }));
    expect(s1.messages()).toHaveLength(2);
    expect(s1.messages()[1]).toEqual({ type: 'publish', topic: 'room-a', data: 'solo', clients: 1 });
    expect(s2.messages()).toHaveLength(1);

    hub.handleWebSocketMessage(s1, JSON.stringify({ type: 'ping' }));
    expect(s1.messages()[2]).toEqual({ type: 'pong' });
  });

  it('recovers all subscriptions after Durable Object hibernation and prunes closed sockets', () => {
    const harness = createMockDurableObjectState();
    const hub1 = new SignalingHubCore(harness.ctx, {}, { createWebSocketPair: harness.createPair, createUpgradeResponse: harness.createUpgradeResponse });

    void hub1.handleFetch(wsUpgradeRequest('203.0.113.1'));
    void hub1.handleFetch(wsUpgradeRequest('203.0.113.2'));
    const [s1, s2] = harness.ctx.getWebSockets() as Array<InstanceType<typeof harness.FakeServerSocket>>;
    hub1.handleWebSocketMessage(s1, JSON.stringify({ type: 'subscribe', topics: ['room-hibernated'] }));
    hub1.handleWebSocketMessage(s2, JSON.stringify({ type: 'subscribe', topics: ['room-hibernated'] }));

    // Simulate s2 vanishing while hibernated (no close callback ran before eviction).
    harness.liveSockets.delete(s2);

    // Wake a brand-new SignalingHubCore instance over the same storage + surviving sockets.
    const hub2 = new SignalingHubCore(harness.ctx, {}, { createWebSocketPair: harness.createPair });
    expect(harness.rows.size).toBe(1); // stale s2 row pruned on wake

    hub2.handleWebSocketMessage(s1, JSON.stringify({ type: 'publish', topic: 'room-hibernated', data: 'after-wake' }));
    expect(s1.messages()).toEqual([{ type: 'publish', topic: 'room-hibernated', data: 'after-wake', clients: 1 }]);
  });

  it('enforces topic cap without dropping the socket, and closes sockets on oversized payloads or floods', () => {
    const harness = createMockDurableObjectState();
    let now = 1_000_000;
    const hub = new SignalingHubCore(
      harness.ctx,
      { MAX_TOPICS_PER_CONNECTION: '2', MAX_MESSAGE_BYTES: '1024', MAX_MESSAGES_PER_SECOND: '1', MESSAGE_BURST: '3' },
      { now: () => now, createWebSocketPair: harness.createPair, createUpgradeResponse: harness.createUpgradeResponse },
    );

    void hub.handleFetch(wsUpgradeRequest('203.0.113.1'));
    const [s1] = harness.ctx.getWebSockets() as Array<InstanceType<typeof harness.FakeServerSocket>>;

    // Extra topic beyond cap is ignored without closing the connection.
    hub.handleWebSocketMessage(s1, JSON.stringify({ type: 'subscribe', topics: ['t1', 't2', 't3'] }));
    expect(s1.closed).toBeNull();
    expect(hub.topics.has('t1')).toBe(true);
    expect(hub.topics.has('t2')).toBe(true);
    expect(hub.topics.has('t3')).toBe(false);

    // Burst of 3 exhausted → 4th message drops with 1008.
    hub.handleWebSocketMessage(s1, JSON.stringify({ type: 'ping' }));
    hub.handleWebSocketMessage(s1, JSON.stringify({ type: 'ping' }));
    hub.handleWebSocketMessage(s1, JSON.stringify({ type: 'ping' }));
    expect(s1.closed).toEqual({ code: 1008, reason: 'rate limit' });

    // Oversized payload drops with 1009.
    now += 10_000;
    void hub.handleFetch(wsUpgradeRequest('203.0.113.2'));
    const [s2] = harness.ctx.getWebSockets() as Array<InstanceType<typeof harness.FakeServerSocket>>;
    hub.handleWebSocketMessage(s2, 'x'.repeat(2048));
    expect(s2.closed).toEqual({ code: 1009, reason: 'message too big' });
  });

  it('caps connections per IPv4 and per IPv6 /64 prefix and reports live /health counts', async () => {
    expect(normalizeClientIp('2001:0db8:0001:0002::1234')).toBe('2001:db8:1:2::/64');
    expect(normalizeClientIp('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(normalizeIpPrefix('198.51.100.7')).toBe('198.51.100.0/24');
    expect(normalizeIpPrefix('2001:db8:1:2::/64')).toBe('2001:db8:1:2::/64');

    const harness = createMockDurableObjectState();
    const hub = new SignalingHubCore(
      harness.ctx,
      { MAX_CONNECTIONS_PER_IP: '2' },
      { now: () => Date.UTC(2026, 10, 21), createWebSocketPair: harness.createPair, createUpgradeResponse: harness.createUpgradeResponse },
    );

    expect((hub.handleFetch(wsUpgradeRequest('2001:db8:1:2::1')) as Response).status).toBe(101);
    expect((hub.handleFetch(wsUpgradeRequest('2001:db8:1:2::9999')) as Response).status).toBe(101);
    expect((hub.handleFetch(wsUpgradeRequest('2001:db8:1:2::abcd')) as Response).status).toBe(429);

    const health = await hub.handleFetch(new Request('https://signal.example.workers.dev/health'));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      status: 'ok',
      connections: 2,
      topics: 0,
      runtime: 'cloudflare-do',
      turn: { configured: false, killSwitch: false, month: '2026-11', analyticsSynced: false },
    });
  });
});

describe('Cloudflare TURN quota, Ed25519 identity proof, 950 GB kill-switch, and revocation', () => {
  it('verifies valid Ed25519 /ice proofs and rejects expired or forged ones', async () => {
    const now = Date.UTC(2026, 10, 21, 12, 0, 0);
    const { request } = await createSignedIceRequest('https://app.localdapp.workers.dev/ice', now);
    const ok = await verifyIceIdentity(request, now);
    expect(ok.verified).toBe(true);
    if (ok.verified) expect(ok.userId).toMatch(/^u_[0-9a-f]{24}$/);

    // Expired timestamp (>5 min skew) is rejected.
    const stale = await verifyIceIdentity(request, now + 10 * 60 * 1000);
    expect(stale).toEqual({ verified: false, reason: 'skew' });

    // Forged signature is rejected.
    const forged = new Request('https://app.localdapp.workers.dev/ice', {
      headers: {
        'X-Dapp-PubKey': request.headers.get('X-Dapp-PubKey') ?? '',
        'X-Dapp-Timestamp': String(now),
        'X-Dapp-Signature': '00'.repeat(64),
      },
    });
    expect(await verifyIceIdentity(forged, now)).toEqual({ verified: false, reason: 'invalid' });
  });

  it('enforces 10 MB/user quota, 25 MB anti-Sybil IP cap, 800 GB alert, 950 GB kill-switch, revocation, and month reset', async () => {
    let now = Date.UTC(2026, 10, 21, 12, 0, 0); // 2026-11
    let credSeq = 0;
    const revokedUsernames: string[] = [];
    const webhookCalls: Array<{ title: string | null; body: Record<string, unknown> }> = [];
    let gqlAccountTotal = 0;
    let gqlByUser: Array<{ dimensions: { customIdentifier: string }; sum: { egressBytes: number } }> = [];

    const fetchFn = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/credentials/generate-ice-servers')) {
        credSeq += 1;
        return Promise.resolve(new Response(JSON.stringify({
          iceServers: [
            { urls: ['stun:stun.cloudflare.com:3478'] },
            {
              urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp'],
              username: `turn-user-${credSeq}`,
              credential: `turn-pass-${credSeq}`,
            },
          ],
        }), { status: 201 }));
      }
      if (url.includes('/revoke')) {
        const match = /\/credentials\/([^/]+)\/revoke$/.exec(url);
        if (match) revokedUsernames.push(decodeURIComponent(match[1]));
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url.includes('/graphql')) {
        return Promise.resolve(new Response(JSON.stringify({
          data: {
            viewer: {
              accounts: [{
                accountTotal: [{ sum: { egressBytes: gqlAccountTotal } }],
                byUser: gqlByUser,
              }],
            },
          },
          errors: null,
        }), { status: 200 }));
      }
      if (url === 'https://hooks.example/alert') {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const rawBody = typeof init?.body === 'string' ? init.body : '{}';
        webhookCalls.push({
          title: headers.Title ?? null,
          body: JSON.parse(rawBody) as Record<string, unknown>,
        });
        return Promise.resolve(new Response('ok', { status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected fetch URL in test: ${url}`));
    });

    const harness = createMockDurableObjectState();
    const env: SignalingWorkerEnv = {
      ALLOWED_ORIGINS: 'https://app.localdapp.workers.dev',
      TURN_KEY_ID: 'key-prod',
      TURN_KEY_API_TOKEN: 'turn-secret',
      TURN_TTL_SECONDS: '1800',
      TURN_USER_MONTHLY_LIMIT_BYTES: String(10 * 1024 * 1024), // 10 MiB
      TURN_IP_MONTHLY_LIMIT_BYTES: String(25 * 1024 * 1024), // 25 MiB
      TURN_ACCOUNT_WARN_BYTES: String(800_000_000_000),
      TURN_ACCOUNT_HARD_CAP_BYTES: String(950_000_000_000),
      TURN_ALERT_WEBHOOK_URL: 'https://hooks.example/alert',
      CF_ACCOUNT_ID: 'acct-123',
      CF_ANALYTICS_TOKEN: 'analytics-read-tok',
      ICE_RATE_LIMIT_PER_HOUR: '100',
    };

    const hub = new SignalingHubCore(harness.ctx, env, {
      now: () => now,
      fetchFn,
      createWebSocketPair: harness.createPair,
      createUpgradeResponse: harness.createUpgradeResponse,
    });

    // 1. User A signs /ice -> gets TURN (with port :53 stripped) tagged with customIdentifier.
    const userA = await createSignedIceRequest('https://app.localdapp.workers.dev/ice', now, {
      'Sec-Fetch-Site': 'same-origin',
      'CF-Connecting-IP': '198.51.100.10',
    });
    const resA1 = await hub.handleIceRequest(userA.request);
    expect(resA1.status).toBe(200);
    const bodyA1 = await resA1.json() as { iceServers: Array<{ urls: string | string[]; username?: string }>; turn: { active: boolean; reason: string; usedBytes: number } };
    expect(bodyA1.turn.active).toBe(true);
    expect(bodyA1.turn.reason).toBe('ok');
    expect(bodyA1.iceServers[1].urls).toEqual('turn:turn.cloudflare.com:3478?transport=udp'); // :53 stripped
    const userAId = [...harness.turnActiveCreds.values()][0].user_id;
    expect(userAId).toMatch(/^u_[0-9a-f]{24}$/);

    // 2. Cron sync reports User A consumed 12 MB (> 10 MB limit) -> active cred revoked + future /ice falls back to STUN!
    gqlAccountTotal = 12 * 1024 * 1024;
    gqlByUser = [{ dimensions: { customIdentifier: userAId }, sum: { egressBytes: 12 * 1024 * 1024 } }];
    const sync1 = await hub.syncTurnUsage();
    expect(sync1.synced).toBe(true);
    expect(sync1.revokedCount).toBe(1);
    expect(revokedUsernames).toEqual(['turn-user-1']);

    const userARetry = await createSignedIceRequest('https://app.localdapp.workers.dev/ice', now, {
      'Sec-Fetch-Site': 'same-origin',
      'CF-Connecting-IP': '198.51.100.10',
    });
    const resA2 = await hub.handleIceRequest(userARetry.request);
    // Different key? Let's re-sign with userA's SAME keypair so userId matches userAId.
    const sameKeySig = await crypto.subtle.sign(
      { name: 'Ed25519' },
      userA.pair.privateKey,
      new TextEncoder().encode(`ice:https://app.localdapp.workers.dev:${now}`),
    );
    const resASame = await hub.handleIceRequest(new Request('https://app.localdapp.workers.dev/ice', {
      headers: {
        'Sec-Fetch-Site': 'same-origin',
        'CF-Connecting-IP': '198.51.100.10',
        'X-Dapp-PubKey': userA.pubKeyHex,
        'X-Dapp-Timestamp': String(now),
        'X-Dapp-Signature': Array.from(new Uint8Array(sameKeySig), (b) => b.toString(16).padStart(2, '0')).join(''),
      },
    }));
    const bodyASame = await resASame.json() as { iceServers: unknown[]; turn: { active: boolean; reason: string; usedBytes: number } };
    expect(bodyASame.turn.active).toBe(false);
    expect(bodyASame.turn.reason).toBe('user_quota_exceeded');
    expect(bodyASame.turn.usedBytes).toBe(12 * 1024 * 1024);
    expect(bodyASame.iceServers).toEqual([{ urls: 'stun:stun.cloudflare.com:3478' }]);

    // User B (fresh key on same /24 IP) still succeeded above (resA2) while IP sum was 12 MB < 25 MB.
    expect((await resA2.json() as { turn: { active: boolean } }).turn.active).toBe(true);
    const userBId = [...harness.turnActiveCreds.values()][0].user_id;

    // 3. Anti-Sybil IP cap: User A (12 MB) + User B (14 MB) = 26 MB on 198.51.100.0/24 (> 25 MB) -> brand-new User C on same /24 is blocked!
    gqlAccountTotal = 26 * 1024 * 1024;
    gqlByUser = [
      { dimensions: { customIdentifier: userAId }, sum: { egressBytes: 12 * 1024 * 1024 } },
      { dimensions: { customIdentifier: userBId }, sum: { egressBytes: 14 * 1024 * 1024 } },
    ];
    await hub.syncTurnUsage();
    const userC = await createSignedIceRequest('https://app.localdapp.workers.dev/ice', now, {
      'Sec-Fetch-Site': 'same-origin',
      'CF-Connecting-IP': '198.51.100.99', // different host, same /24!
    });
    const bodyC = await (await hub.handleIceRequest(userC.request)).json() as { turn: { active: boolean; reason: string } };
    expect(bodyC.turn.active).toBe(false);
    expect(bodyC.turn.reason).toBe('ip_quota_exceeded');

    // 4. User D on a different IP gets TURN, then account hits 820 GB -> warning webhook fires ONCE.
    const userD = await createSignedIceRequest('https://app.localdapp.workers.dev/ice', now, {
      'Sec-Fetch-Site': 'same-origin',
      'CF-Connecting-IP': '203.0.113.42',
    });
    expect((await (await hub.handleIceRequest(userD.request)).json() as { turn: { active: boolean } }).turn.active).toBe(true);

    gqlAccountTotal = 820_000_000_000;
    const syncWarn1 = await hub.syncTurnUsage();
    const syncWarn2 = await hub.syncTurnUsage();
    expect(syncWarn1.warnSent).toBe(true);
    expect(syncWarn2.warnSent).toBe(false); // de-duplicated per month
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0].body.event).toBe('turn_warning');

    // 5. Account hits 960 GB -> hard kill-switch trips, webhook fires, User D's active credential is revoked, and all /ice calls return STUN-only!
    gqlAccountTotal = 960_000_000_000;
    const syncCap = await hub.syncTurnUsage();
    expect(syncCap.killSwitchTripped).toBe(true);
    expect(syncCap.revokedCount).toBe(1);
    expect(webhookCalls).toHaveLength(2);
    expect(webhookCalls[1].body.event).toBe('turn_cap');

    const userE = await createSignedIceRequest('https://app.localdapp.workers.dev/ice', now, {
      'Sec-Fetch-Site': 'same-origin',
      'CF-Connecting-IP': '192.0.2.5',
    });
    const bodyE = await (await hub.handleIceRequest(userE.request)).json() as { iceServers: unknown[]; turn: { active: boolean; reason: string } };
    expect(bodyE.turn.active).toBe(false);
    expect(bodyE.turn.reason).toBe('account_cap_reached');
    expect(bodyE.iceServers).toEqual([{ urls: 'stun:stun.cloudflare.com:3478' }]);

    // 6. Month rolls over to 2026-12 -> kill-switch resets and TURN works again!
    now = Date.UTC(2026, 11, 1, 0, 5, 0);
    const userNextMonth = await createSignedIceRequest('https://app.localdapp.workers.dev/ice', now, {
      'Sec-Fetch-Site': 'same-origin',
      'CF-Connecting-IP': '192.0.2.5',
    });
    const bodyNextMonth = await (await hub.handleIceRequest(userNextMonth.request)).json() as { turn: { active: boolean; month: string } };
    expect(bodyNextMonth.turn.active).toBe(true);
    expect(bodyNextMonth.turn.month).toBe('2026-12');
  });
});

describe('Cloudflare Worker stateless /ice & createWorkerFetch routing', () => {
  it('falls back to Cloudflare STUN when TURN secrets are not set', async () => {
    const handleIce = createIceHandler();
    const response = await handleIce(new Request('https://signal.example.workers.dev/ice'), {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
      ttl: 3600,
    });
  });

  it('mints and caches TURN credentials and enforces ALLOWED_ORIGINS + Sec-Fetch-Site + ICE_ACCESS_TOKEN', async () => {
    let now = 10_000_000;
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        iceServers: [
          { urls: ['stun:stun.cloudflare.com:3478'] },
          { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u-turn', credential: 'c-turn' },
        ],
      }), { status: 201 }),
    );
    const handleIce = createIceHandler({ fetchFn, now: () => now });
    const env: SignalingWorkerEnv = {
      ALLOWED_ORIGINS: 'https://myapp.pages.dev',
      ICE_ACCESS_TOKEN: 'keeper-tok',
      TURN_KEY_ID: 'key-123',
      TURN_KEY_API_TOKEN: 'secret-tok',
      TURN_TTL_SECONDS: '21600',
      ICE_RATE_LIMIT_PER_HOUR: '2',
    };

    expect((await handleIce(new Request('https://signal.example.workers.dev/ice', { headers: { Origin: 'https://evil.example', 'CF-Connecting-IP': '1.2.3.4' } }), env)).status).toBe(403);
    expect((await handleIce(new Request('https://signal.example.workers.dev/ice', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), env)).status).toBe(403);

    const okBrowser = await handleIce(
      new Request('https://signal.example.workers.dev/ice', { headers: { Origin: 'https://myapp.pages.dev', 'CF-Connecting-IP': '1.2.3.4' } }),
      env,
    );
    expect(okBrowser.status).toBe(200);
    expect(okBrowser.headers.get('Access-Control-Allow-Origin')).toBe('https://myapp.pages.dev');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    now += 60_000;
    const okKeeper = await handleIce(
      new Request('https://signal.example.workers.dev/ice', { headers: { Authorization: 'Bearer keeper-tok', 'CF-Connecting-IP': '1.2.3.4' } }),
      env,
    );
    expect(okKeeper.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const sameOriginEnv: SignalingWorkerEnv = { ...env, ALLOWED_ORIGINS: 'https://app.example.workers.dev', ICE_RATE_LIMIT_PER_HOUR: '10' };
    expect((await handleIce(new Request('https://app.example.workers.dev/ice', { headers: { 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': '1.2.3.5' } }), sameOriginEnv)).status).toBe(200);
    expect((await handleIce(new Request('https://app.example.workers.dev/ice', { headers: { 'Sec-Fetch-Site': 'cross-site', 'CF-Connecting-IP': '1.2.3.5' } }), sameOriginEnv)).status).toBe(403);

    expect((await handleIce(new Request('https://signal.example.workers.dev/ice', { headers: { Origin: 'https://myapp.pages.dev', 'CF-Connecting-IP': '1.2.3.4' } }), env)).status).toBe(429);
  });

  it('routes /signaling, /health, /ice, and static ASSETS cleanly in createWorkerFetch', async () => {
    const harness = createMockDurableObjectState();
    const hub = new SignalingHubCore(harness.ctx, {}, { createWebSocketPair: harness.createPair, createUpgradeResponse: harness.createUpgradeResponse });
    const workerFetch = createWorkerFetch();
    const env: SignalingWorkerEnv = {
      SIGNALING_HUB: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: (req: Request) => hub.handleFetch(req) }),
      },
    };

    expect((await workerFetch(new Request('https://signal.example.workers.dev/health'), env)).status).toBe(200);
    expect((await workerFetch(new Request('https://signal.example.workers.dev/ice'), env)).status).toBe(200);
    expect((await workerFetch(new Request('https://signal.example.workers.dev/nope'), env)).status).toBe(404);

    const assetFetch = vi.fn(() => new Response('<html>spa</html>', { status: 200 }));
    const singleWorkerEnv: SignalingWorkerEnv = { ...env, ASSETS: { fetch: assetFetch } };
    const rootRes = await workerFetch(new Request('https://app.example.workers.dev/'), singleWorkerEnv);
    expect(rootRes.status).toBe(200);
    expect(await rootRes.text()).toBe('<html>spa</html>');
    expect(assetFetch).toHaveBeenCalledTimes(1);

    const wsRootRes = await workerFetch(
      new Request('https://app.example.workers.dev/', { headers: { Upgrade: 'websocket', 'CF-Connecting-IP': '203.0.113.9' } }),
      singleWorkerEnv,
    );
    expect(wsRootRes.status).toBe(101);
    expect(assetFetch).toHaveBeenCalledTimes(1);
  });
});
