// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultSignalingUrls, fetchDynamicIceServers, getDeviceIceServers, getDeviceSignalingUrls,
  getDynamicIceStatus, normalizeDeviceIceServers, normalizeSignalingUrls,
  resetDynamicIceServersForTests, resolveIceServers, resolveIceServersUrl, resolveSignalingUrls,
  sameOriginSignalingUrl, setDeviceIceServers, setDeviceSignalingUrls, setRuntimeNetworkOverrides,
  signalingEndpoints, startDynamicIceServers, subscribeIceConfig, subscribeSignalingEndpoints,
  webrtcPeerOpts, MAX_ICE_SERVERS, MAX_SIGNALING_URLS, MAX_SIGNALING_URL_LENGTH,
} from '../services/signalingConfig.ts';

describe('signaling endpoint resolution', () => {
  it('falls back to same-origin /signaling when nothing is configured', () => {
    expect(resolveSignalingUrls({})).toEqual([sameOriginSignalingUrl()]);
    expect(resolveSignalingUrls({ VITE_SIGNALING_URL: '   ' })).toEqual([sameOriginSignalingUrl()]);
    const url = sameOriginSignalingUrl();
    expect(url.startsWith('wss://') || url.startsWith('ws://')).toBe(true);
    expect(url.endsWith('/signaling')).toBe(true);
  });

  it('uses the configured build-time endpoint verbatim', () => {
    expect(resolveSignalingUrls({ VITE_SIGNALING_URL: 'wss://signal.example.com' }))
      .toEqual(['wss://signal.example.com']);
  });

  it('splits comma and whitespace separated endpoint lists and de-duplicates', () => {
    expect(resolveSignalingUrls({ VITE_SIGNALING_URL: 'wss://a.example,wss://b.example  wss://a.example' }))
      .toEqual(['wss://a.example', 'wss://b.example']);
  });
});

describe('ICE server resolution', () => {
  it('returns null when nothing is configured', () => {
    expect(resolveIceServers({})).toBeNull();
    expect(resolveIceServers({ VITE_ICE_SERVERS: '  ' })).toBeNull();
  });

  it('parses a valid RTCIceServer JSON array', () => {
    const configured = '[{"urls":"stun:stun.example.com:3478"},{"urls":["turn:turn.example.com:3478"],"username":"u","credential":"c"}]';
    expect(resolveIceServers({ VITE_ICE_SERVERS: configured })).toEqual([
      { urls: 'stun:stun.example.com:3478' },
      { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'c' },
    ]);
  });

  it('rejects malformed JSON and entries without urls', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(resolveIceServers({ VITE_ICE_SERVERS: 'not json' })).toBeNull();
      expect(resolveIceServers({ VITE_ICE_SERVERS: '{"urls":"stun:x"}' })).toBeNull();
      expect(resolveIceServers({ VITE_ICE_SERVERS: '[{"username":"u"}]' })).toBeNull();
    } finally {
      error.mockRestore();
    }
  });
});

/**
 * The device-local signaling setting (Settings → Signaling): someone who opened
 * the app from somebody else's site points THIS device at their own broker.
 * Precedence: runtime overrides (the keeper) > device setting > build default.
 */
describe('device-local signaling setting', () => {
  beforeEach(() => {
    setRuntimeNetworkOverrides({ signalingUrls: [] });
    setDeviceSignalingUrls([]);
  });

  afterEach(() => {
    setRuntimeNetworkOverrides({ signalingUrls: [] });
    setDeviceSignalingUrls([]);
  });

  it('accepts ws:// and wss:// only', () => {
    const { urls, rejected } = normalizeSignalingUrls([
      'wss://signal.example.com', 'ws://192.168.1.5:4444', 'https://signal.example.com', 'signal.example.com', 'javascript:alert(1)',
    ]);
    expect(urls).toEqual(['wss://signal.example.com', 'ws://192.168.1.5:4444']);
    expect(rejected.map((entry) => entry.reason)).toEqual(['protocol', 'malformed', 'protocol']);
  });

  it('trims, drops blanks and removes duplicates', () => {
    expect(normalizeSignalingUrls(['  wss://a.example  ', '', '   ', 'wss://a.example/', 'wss://b.example']).urls)
      .toEqual(['wss://a.example', 'wss://b.example']);
  });

  it('caps the length of one entry and the size of the list', () => {
    const long = `wss://${'x'.repeat(MAX_SIGNALING_URL_LENGTH)}.example`;
    expect(normalizeSignalingUrls([long]).rejected).toEqual([{ value: long, reason: 'tooLong' }]);

    const many = Array.from({ length: MAX_SIGNALING_URLS + 2 }, (_, index) => `wss://b${index}.example`);
    const { urls, rejected } = normalizeSignalingUrls(many);
    expect(urls).toHaveLength(MAX_SIGNALING_URLS);
    expect(rejected.map((entry) => entry.reason)).toEqual(['tooMany', 'tooMany']);
  });

  it('refuses credentials in the address — they would sit in storage in the clear', () => {
    expect(normalizeSignalingUrls(['wss://user:secret@signal.example.com']).rejected)
      .toEqual([{ value: 'wss://user:secret@signal.example.com', reason: 'malformed' }]);
  });

  it('overrides the build default, and an empty list restores it', () => {
    expect(signalingEndpoints()).toEqual(defaultSignalingUrls());

    setDeviceSignalingUrls(['wss://mine.example', 'not a url']);
    expect(getDeviceSignalingUrls()).toEqual(['wss://mine.example']);
    expect(signalingEndpoints()).toEqual(['wss://mine.example']);

    setDeviceSignalingUrls([]);
    expect(signalingEndpoints()).toEqual(defaultSignalingUrls());
  });

  it('survives a reload: only validated entries are stored, and stored entries are re-read', () => {
    setDeviceSignalingUrls(['wss://mine.example']);
    expect(JSON.parse(localStorage.getItem('signaling-endpoints') ?? 'null')).toEqual(['wss://mine.example']);

    // What a reload does: the in-memory cache is dropped, the stored list stands.
    localStorage.setItem('signaling-endpoints', JSON.stringify(['wss://stored.example', 'http://nope.example']));
    window.dispatchEvent(new StorageEvent('storage', { key: 'signaling-endpoints' }));
    expect(signalingEndpoints()).toEqual(['wss://stored.example']);

    localStorage.setItem('signaling-endpoints', 'not json');
    window.dispatchEvent(new StorageEvent('storage', { key: 'signaling-endpoints' }));
    expect(signalingEndpoints()).toEqual(defaultSignalingUrls());
  });

  it('keeps the keeper working: runtime overrides beat the device setting', () => {
    setDeviceSignalingUrls(['wss://mine.example']);
    setRuntimeNetworkOverrides({ signalingUrls: ['wss://keeper.example'] });
    expect(signalingEndpoints()).toEqual(['wss://keeper.example']);
  });

  it('tells listeners so the mesh can follow without a reload', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSignalingEndpoints(listener);
    setDeviceSignalingUrls(['wss://mine.example']);
    expect(listener).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new StorageEvent('storage', { key: 'signaling-endpoints' }));
    expect(listener).toHaveBeenCalledTimes(2); // another tab of this device changed it

    unsubscribe();
    setDeviceSignalingUrls([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('dynamic ephemeral ICE server resolution', () => {
  afterEach(() => {
    resetDynamicIceServersForTests();
    setRuntimeNetworkOverrides({ iceServers: undefined });
  });

  it('validates VITE_ICE_SERVERS_URL (https everywhere, http only on loopback, no embedded credentials)', () => {
    expect(resolveIceServersUrl({})).toBeNull();
    expect(resolveIceServersUrl({ VITE_ICE_SERVERS_URL: 'https://signal.example.workers.dev/ice' }))
      .toBe('https://signal.example.workers.dev/ice');
    expect(resolveIceServersUrl({ VITE_ICE_SERVERS_URL: 'http://127.0.0.1:8787/ice' }))
      .toBe('http://127.0.0.1:8787/ice');
    expect(resolveIceServersUrl({ VITE_ICE_SERVERS_URL: 'http://signal.example.com/ice' })).toBeNull();
    expect(resolveIceServersUrl({ VITE_ICE_SERVERS_URL: 'https://u:p@signal.example.com/ice' })).toBeNull();
  });

  it('fetches ephemeral credentials, wires them into webrtcPeerOpts, and respects runtime override precedence', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        iceServers: [
          { urls: 'stun:stun.cloudflare.com:3478' },
          { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u1', credential: 'c1' },
        ],
        ttl: 21600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const fetched = await fetchDynamicIceServers('https://signal.example.workers.dev/ice', { token: 'keeper-secret', fetchFn });
    expect(fetched?.ttlSeconds).toBe(21600);
    const [calledUrl, calledInit] = fetchFn.mock.calls[0];
    expect(calledUrl).toBe('https://signal.example.workers.dev/ice');
    expect(calledInit?.method).toBe('GET');
    expect((calledInit?.headers as Record<string, string>)?.Authorization).toBe('Bearer keeper-secret');
    expect(webrtcPeerOpts()?.config?.iceServers).toEqual([
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u1', credential: 'c1' },
    ]);

    // Runtime overrides (explicit static ICE_SERVERS on keeper) still win over dynamic fetches.
    setRuntimeNetworkOverrides({ iceServers: [{ urls: 'stun:override.example:3478' }] });
    expect(webrtcPeerOpts()?.config?.iceServers).toEqual([{ urls: 'stun:override.example:3478' }]);
  });

  it('starts background fetches cleanly and ignores invalid URLs or non-OK replies', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('bad', { status: 502 }));
    const stop = startDynamicIceServers({ url: 'https://signal.example.workers.dev/ice', fetchFn });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(webrtcPeerOpts()).toBeUndefined();
    stop();

    const noop = startDynamicIceServers({ url: 'http://insecure.example/ice', fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    noop();
  });

  it('attaches Ed25519 proof headers and stores TURN quota status from /ice', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
        ttl: 1800,
        turn: {
          active: false,
          reason: 'user_quota_exceeded',
          usedBytes: 10_500_000,
          limitBytes: 10_485_760,
          month: '2026-11',
          analyticsSynced: true,
        },
      }), { status: 200 }),
    );
    const signRequest = vi.fn(() => Promise.resolve({ publicKey: 'ab'.repeat(32), signature: 'cd'.repeat(64) }));
    const listener = vi.fn();
    const unsub = subscribeIceConfig(listener);

    const res = await fetchDynamicIceServers('https://app.localdapp.workers.dev/ice', { signRequest, fetchFn });
    expect(res?.turn?.reason).toBe('user_quota_exceeded');
    expect(getDynamicIceStatus()?.usedBytes).toBe(10_500_000);
    expect(listener).toHaveBeenCalledTimes(1);

    const [, init] = fetchFn.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Dapp-PubKey']).toBe('ab'.repeat(32));
    expect(headers['X-Dapp-Signature']).toBe('cd'.repeat(64));
    expect(headers['X-Dapp-Timestamp']).toMatch(/^\d+$/);
    unsub();
  });
});

describe('device-local custom TURN / ICE servers', () => {
  beforeEach(() => {
    setDeviceIceServers([]);
    resetDynamicIceServersForTests();
    setRuntimeNetworkOverrides({ iceServers: undefined });
  });

  afterEach(() => {
    setDeviceIceServers([]);
    resetDynamicIceServersForTests();
    setRuntimeNetworkOverrides({ iceServers: undefined });
  });

  it('accepts stun:, stuns:, turn:, and turns: URLs only and enforces caps', () => {
    const { servers, rejected } = normalizeDeviceIceServers([
      { urls: 'turns:turn.example.com:5349?transport=tcp', username: 'alice', credential: 'sec' },
      { urls: 'stun:stun.example.com:3478' },
      { urls: 'https://not-turn.example.com' },
      { urls: 'turn:user:pass@turn.example.com:3478' },
    ]);
    expect(servers).toEqual([
      { urls: 'turns:turn.example.com:5349?transport=tcp', username: 'alice', credential: 'sec' },
      { urls: 'stun:stun.example.com:3478' },
    ]);
    expect(rejected.map((r) => r.reason)).toEqual(['protocol', 'malformed']);

    const many = Array.from({ length: MAX_ICE_SERVERS + 1 }, (_, i) => ({ urls: `turn:t${i}.example.com:3478` }));
    const capped = normalizeDeviceIceServers(many);
    expect(capped.servers).toHaveLength(MAX_ICE_SERVERS);
    expect(capped.rejected).toHaveLength(1);
    expect(capped.rejected[0].reason).toBe('tooMany');
  });

  it('beats dynamic /ice in webrtcPeerOpts and pauses shared /ice polling while custom TURN is active', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ iceServers: [{ urls: 'stun:shared.example:3478' }], ttl: 1800 }), { status: 200 }),
    );
    setDeviceIceServers([{ urls: 'turns:my-turn.example:5349', username: 'me', credential: 'pw' }]);
    expect(getDeviceIceServers()).toHaveLength(1);
    expect(webrtcPeerOpts()?.config?.iceServers).toEqual([
      { urls: 'turns:my-turn.example:5349', username: 'me', credential: 'pw' },
    ]);

    const stop = startDynamicIceServers({ url: 'https://app.localdapp.workers.dev/ice', fetchFn });
    await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledTimes(0); // shared quota not touched while custom TURN is set

    // Clearing custom TURN immediately resumes built-in /ice fetching.
    setDeviceIceServers([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    stop();
  });
});
