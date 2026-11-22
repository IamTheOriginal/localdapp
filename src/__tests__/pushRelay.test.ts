import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The relay is plain-node ESM without type declarations; import it dynamically
// through a variable so tsc does not try to resolve the module literally.
const relayModulePath = '../../server/push-relay.mjs';

interface RelayHandle {
  vapidPublicKey: string;
  inboxCount: () => number;
  sweepStale: (now?: number) => number;
  flush: () => Promise<void>;
  listen: (port: number, host: string) => Promise<{ port: number }>;
  close: () => Promise<void>;
}
interface RelayModule {
  createPushRelay: (options?: {
    dataDir?: string;
    sendPush?: (subscription: unknown) => Promise<void>;
    ipLimitPerMinute?: number;
    inboxLimitPerMinute?: number;
    maxInboxes?: number;
    maxNewInboxesPerIp?: number;
    extraPushHosts?: string[];
    trustProxy?: boolean;
    staleTtlMs?: number;
  }) => RelayHandle;
  canonicalizeJson: (value: unknown) => string;
  verifyTickleSignature: (payload: unknown, signatureHex: string, publicKeyHex: string) => boolean;
  isAllowedPushEndpoint: (endpoint: unknown, pushHosts?: readonly string[]) => boolean;
  isNonPublicAddress: (address: string) => boolean;
  clientKey: (address: string) => string;
}

async function loadRelayModule(): Promise<RelayModule> {
  return await import(/* @vite-ignore */ relayModulePath) as RelayModule;
}

const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
};

/** Test sender identity: raw-hex Ed25519 keys, signing canonical JSON like the client does. */
function createSender() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    publicKeyHex: Buffer.from(spki.subarray(spki.length - 32)).toString('hex'),
    signCanonical(canonical: string): string {
      return nodeSign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('hex');
    },
  };
}

describe('push relay', () => {
  let dataDir: string;
  let relay: RelayHandle | null = null;
  let base = '';
  let relayModule: RelayModule;
  const sendPush = vi.fn<(subscription: unknown) => Promise<void>>().mockResolvedValue(undefined);
  const sender = createSender();
  const stranger = createSender();

  async function start(options: Parameters<RelayModule['createPushRelay']>[0] = {}): Promise<RelayHandle> {
    relayModule = await loadRelayModule();
    const handle = relayModule.createPushRelay({ dataDir, sendPush, ...options });
    relay = handle;
    const address = await handle.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${address.port}`;
    return handle;
  }

  async function registerRaw(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return await fetch(`${base}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  async function register(allow: string[] = [sender.publicKeyHex]): Promise<{ inboxId: string; secret: string }> {
    const response = await registerRaw({ subscription, allow });
    expect(response.status).toBe(201);
    return await response.json() as { inboxId: string; secret: string };
  }

  function tickleBody(inboxId: string, overrides: Partial<Record<string, unknown>> = {}, by = sender) {
    const payload = {
      inboxId,
      nonce: Math.random().toString(16).slice(2).padEnd(16, '0'),
      protocol: 'push-tickle',
      schemaVersion: 1,
      sentAt: new Date().toISOString(),
      ...overrides,
    };
    return {
      payload,
      senderPublicKey: by.publicKeyHex,
      signature: by.signCanonical(relayModule.canonicalizeJson(payload)),
    };
  }

  async function notifyRaw(inboxId: string, body: unknown): Promise<{ status: number; text: string }> {
    const response = await fetch(`${base}/notify/${inboxId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  }

  async function notify(inboxId: string, body: unknown): Promise<number> {
    return (await notifyRaw(inboxId, body)).status;
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'push-relay-test-'));
    sendPush.mockClear();
    sendPush.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await relay?.close();
    relay = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('registers an inbox and forwards a signed tickle from an allowlisted sender', async () => {
    await start();
    const { inboxId } = await register();
    expect(inboxId).toMatch(/^[0-9a-f]{32}$/);

    expect(await notify(inboxId, tickleBody(inboxId))).toBe(204);
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(sendPush).toHaveBeenCalledWith(expect.objectContaining({ endpoint: subscription.endpoint }));

    const health = await (await fetch(`${base}/health`)).json() as { inboxes: number };
    expect(health.inboxes).toBe(1);
  });

  it('rejects unauthenticated, forged, stale, and replayed tickles', async () => {
    await start();
    const { inboxId } = await register();

    // Sender not on the allowlist.
    expect(await notify(inboxId, tickleBody(inboxId, {}, stranger))).toBe(403);
    // Allowlisted key but a signature that does not verify.
    const forged = tickleBody(inboxId);
    forged.signature = 'ab'.repeat(64);
    expect(await notify(inboxId, forged)).toBe(403);
    // Payload tampered after signing.
    const tampered = tickleBody(inboxId);
    tampered.payload.sentAt = new Date(Date.now() + 1000).toISOString();
    expect(await notify(inboxId, tampered)).toBe(403);
    // Outside the freshness window.
    expect(await notify(inboxId, tickleBody(inboxId, { sentAt: new Date(Date.now() - 10 * 60_000).toISOString() }))).toBe(400);
    // Malformed shapes.
    expect(await notify(inboxId, { payload: { inboxId }, senderPublicKey: sender.publicKeyHex, signature: 'ab'.repeat(64) })).toBe(400);
    expect(await notify(inboxId, null)).toBe(400);
    // Replay of an accepted nonce.
    const good = tickleBody(inboxId);
    expect(await notify(inboxId, good)).toBe(204);
    expect(await notify(inboxId, good)).toBe(409);

    expect(sendPush).toHaveBeenCalledTimes(1);
    // An unknown inbox looks exactly like a refused sender.
    expect(await notify('0'.repeat(32), tickleBody('0'.repeat(32)))).toBe(403);
  });

  it('answers an unknown inbox and a bad signature identically', async () => {
    await start();
    const { inboxId } = await register();
    const unknownId = 'f'.repeat(32);
    const forged = tickleBody(inboxId);
    forged.signature = 'ab'.repeat(64);
    const responses = [
      await notifyRaw(unknownId, tickleBody(unknownId)),
      await notifyRaw(inboxId, forged),
      await notifyRaw(inboxId, tickleBody(inboxId, {}, stranger)),
    ];
    expect(new Set(responses.map((response) => `${String(response.status)} ${response.text}`)).size).toBe(1);
    expect(responses[0].status).toBe(403);
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('does not let unauthenticated tickles spend the inbox budget', async () => {
    await start({ inboxLimitPerMinute: 2 });
    const { inboxId } = await register();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const forged = tickleBody(inboxId);
      forged.signature = 'cd'.repeat(64);
      expect(await notify(inboxId, forged)).toBe(403);
      expect(await notify(inboxId, tickleBody(inboxId, {}, stranger))).toBe(403);
    }
    expect(await notify(inboxId, tickleBody(inboxId))).toBe(204);
    expect(await notify(inboxId, tickleBody(inboxId))).toBe(204);
    expect(await notify(inboxId, tickleBody(inboxId))).toBe(429);
    expect(sendPush).toHaveBeenCalledTimes(2);
  });

  it('accepts only push-service endpoints and never private or local hosts', async () => {
    await start({ extraPushHosts: ['push.example.org', '*.selfhosted.example'], maxNewInboxesPerIp: 100 });
    const refused = [
      'https://evil.example.com/hook',
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://user:pw@fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilfcm.googleapis.com/x',
      'https://push.apple.com/x',
      'https://127.0.0.1/x',
      'https://10.0.0.8/x',
      'https://169.254.169.254/latest/meta-data',
      'https://192.168.1.1/x',
      'https://[::1]/x',
      'https://[fe80::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://localhost/x',
      'https://2130706433/x',
      'https://selfhosted.example/x',
    ];
    for (const endpoint of refused) {
      const response = await registerRaw({ subscription: { ...subscription, endpoint }, allow: [] });
      expect(response.status, endpoint).toBe(400);
    }
    const accepted = [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://web.push.apple.com/QGx',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://push.example.org/sub/abc',
      'https://a.selfhosted.example/sub',
    ];
    for (const endpoint of accepted) {
      const response = await registerRaw({ subscription: { ...subscription, endpoint }, allow: [] });
      expect(response.status, endpoint).toBe(201);
    }
  });

  it('classifies addresses and keys clients', async () => {
    relayModule = await loadRelayModule();
    const { isNonPublicAddress, clientKey, isAllowedPushEndpoint } = relayModule;
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:a00:1']) {
      expect(isNonPublicAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '172.32.0.1', '2001:4860:4860::8888', '::ffff:8.8.8.8', 'fcm.googleapis.com']) {
      expect(isNonPublicAddress(address), address).toBe(false);
    }
    expect(clientKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('2001:db8:1:2:aaaa::1')).toBe(clientKey('2001:db8:1:2:bbbb::9'));
    expect(clientKey('2001:db8:1:2::1')).not.toBe(clientKey('2001:db8:1:3::1'));
    expect(isAllowedPushEndpoint('https://FCM.googleapis.com/fcm/send/x')).toBe(true);
    expect(isAllowedPushEndpoint(42)).toBe(false);
  });

  it('caps new inboxes per client address, but not refreshes', async () => {
    await start({ maxNewInboxesPerIp: 2 });
    const first = await register();
    await register();
    expect((await registerRaw({ subscription, allow: [] })).status).toBe(429);
    const refresh = await registerRaw({ subscription, allow: [], inboxId: first.inboxId, secret: first.secret });
    expect(refresh.status).toBe(200);
    expect(relay?.inboxCount()).toBe(2);
  });

  it('caps the total number of inboxes', async () => {
    await start({ maxInboxes: 1 });
    await register();
    expect((await registerRaw({ subscription, allow: [] })).status).toBe(503);
  });

  it('honors X-Forwarded-For only when told a proxy is in front', async () => {
    await start({ maxNewInboxesPerIp: 1 });
    await register();
    expect((await registerRaw({ subscription, allow: [] }, { 'X-Forwarded-For': '198.51.100.7' })).status).toBe(429);
    await relay?.close();
    relay = null;

    await start({ maxNewInboxesPerIp: 1, trustProxy: true });
    expect((await registerRaw({ subscription, allow: [] }, { 'X-Forwarded-For': '198.51.100.7' })).status).toBe(201);
    // The right-most entry is the one the proxy appended; a client-supplied prefix does not help.
    expect((await registerRaw({ subscription, allow: [] }, { 'X-Forwarded-For': '203.0.113.1, 198.51.100.7' })).status).toBe(429);
    expect((await registerRaw({ subscription, allow: [] }, { 'X-Forwarded-For': '198.51.100.8' })).status).toBe(201);
  });

  it('writes registrations asynchronously and atomically', async () => {
    const handle = await start();
    const { inboxId } = await register();
    await handle.flush();
    const stored = JSON.parse(readFileSync(join(dataDir, 'inboxes.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual([inboxId]);
  });

  it('refreshes subscription and allowlist only with the ownership secret', async () => {
    await start();
    const { inboxId, secret } = await register([]);
    // Empty allowlist: nobody can wake this inbox yet.
    expect(await notify(inboxId, tickleBody(inboxId))).toBe(403);

    const replaced = { ...subscription, endpoint: 'https://fcm.googleapis.com/fcm/send/rotated' };
    expect((await fetch(`${base}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: replaced, allow: [sender.publicKeyHex], inboxId, secret: 'wrong' }),
    })).status).toBe(403);

    expect((await fetch(`${base}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: replaced, allow: [sender.publicKeyHex], inboxId, secret }),
    })).status).toBe(200);

    expect(await notify(inboxId, tickleBody(inboxId))).toBe(204);
    expect(sendPush).toHaveBeenCalledWith(expect.objectContaining({ endpoint: replaced.endpoint }));
  });

  it('rate-limits notifies per inbox', async () => {
    await start({ inboxLimitPerMinute: 2 });
    const { inboxId } = await register();
    expect(await notify(inboxId, tickleBody(inboxId))).toBe(204);
    expect(await notify(inboxId, tickleBody(inboxId))).toBe(204);
    expect(await notify(inboxId, tickleBody(inboxId))).toBe(429);
    expect(sendPush).toHaveBeenCalledTimes(2);
  });

  it('garbage-collects an inbox when the push service reports it gone', async () => {
    await start();
    const { inboxId } = await register();
    sendPush.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));
    expect(await notify(inboxId, tickleBody(inboxId))).toBe(502);
    // Send-time GC: the inbox is deleted, later notifies are refused like any unknown inbox.
    expect(await notify(inboxId, tickleBody(inboxId))).toBe(403);
  });

  it('sweeps registrations whose owner stopped refreshing them', async () => {
    const handle = await start({ staleTtlMs: 60_000 });
    const { inboxId } = await register();
    expect(handle.sweepStale(Date.now())).toBe(0);
    expect(handle.sweepStale(Date.now() + 120_000)).toBe(1);
    expect(await notify(inboxId, tickleBody(inboxId))).toBe(403);
  });

  it('persists registrations across restarts', async () => {
    await start();
    const { inboxId } = await register();
    const firstVapid = relay?.vapidPublicKey;
    await relay?.close();
    relay = null;

    const restarted = await start();
    expect(restarted.vapidPublicKey).toBe(firstVapid);
    expect(await notify(inboxId, tickleBody(inboxId))).toBe(204);
  });
});
