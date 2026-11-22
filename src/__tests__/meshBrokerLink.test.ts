import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex, hexToBuffer } from '../lib/hex.ts';

/**
 * The device's signaling links: ONE socket per configured endpoint, shared by
 * every dapp channel (a socket per dapp multiplied into dapps × tabs × devices
 * behind one public IP and hit the broker's per-IP connection limit, which
 * silently left the newest channel without peers).
 *
 * All endpoints are held at the SAME TIME. A broker only relays between its own
 * subscribers, so the old "dial endpoints[retries % length]" behaviour moved a
 * device to broker #2 after any drop while everyone else stayed on #1 — and the
 * two never met again (review item 2.2).
 */

const docs = vi.hoisted(() => new Map<string, unknown>());
const state = vi.hoisted(() => ({
  endpoints: ['ws://broker-a.test', 'ws://broker-b.test'],
  /** Listeners the mesh registered for "the device changed its signaling servers". */
  endpointListeners: new Set<() => void>(),
}));

function docOf(key: string): Y.Doc {
  let doc = docs.get(key) as Y.Doc | undefined;
  if (!doc) {
    doc = new Y.Doc();
    docs.set(key, doc);
  }
  return doc;
}

vi.mock('../services/store/docs.ts', () => ({
  // Distinct credentials per dapp → distinct broker topics.
  getDappCredentials: (dappId: string) => ({ roomId: `room-${dappId}`, roomPassword: 'pw'.repeat(16), epoch: 0 }),
  getDappBlobReplication: () => 'onDemand',
  isTrustedBlobPeer: () => true,
  registerProviderReconnectListener: () => () => undefined,
  getDappDoc: (dappId: string) => docOf(`${dappId}:main`),
  getDappSourceDoc: (dappId: string) => docOf(`${dappId}:source`),
  getDappPersistence: () => null,
  getDappSourcePersistence: () => null,
}));
vi.mock('../services/store/files.ts', () => ({ listFileRecords: () => [] }));
vi.mock('../services/blobStore.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/blobStore.ts')>();
  return { ...actual, getBlobStore: () => ({}) };
});
vi.mock('../services/identity.ts', () => ({ getSigningIdentity: vi.fn() }));
vi.mock('../services/signalingConfig.ts', () => ({
  signalingEndpoints: () => [...state.endpoints],
  subscribeSignalingEndpoints: (listener: () => void) => {
    state.endpointListeners.add(listener);
    return () => state.endpointListeners.delete(listener);
  },
  webrtcPeerOpts: () => undefined,
}));

/** Minimal peer: every construction is a dial, which is what the broker tests observe. */
vi.mock('simple-peer/simplepeer.min.js', () => {
  class FakePeer {
    static created: FakePeer[] = [];
    destroyed = false;
    _channel = { bufferedAmount: 0 };
    private readonly handlers = new Map<string, Array<(payload?: unknown) => void>>();

    constructor(options: { initiator: boolean }) {
      FakePeer.created.push(this);
      if (options.initiator) queueMicrotask(() => this.emit('signal', { type: 'offer' }));
    }

    on(event: string, handler: (payload?: unknown) => void): void {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    }

    private emit(event: string, payload?: unknown): void {
      (this.handlers.get(event) ?? []).forEach((handler) => handler(payload));
    }

    /** Signals handed to this peer — the mesh must not feed it the same one twice. */
    readonly received: unknown[] = [];
    signal(data: unknown): void { this.received.push(data); }
    send(): void { /* no frames here */ }
    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('close');
    }
  }
  return { default: FakePeer };
});

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static sockets: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Array<{ type: string; topics?: string[]; topic?: string; envelope?: { iv: string; data: string } }> = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.sockets.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** The network dropped the socket (no local close() call). */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  /** The broker relays a publish of another device to this subscriber. */
  deliver(topic: string, envelope: { iv: string; data: string }): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'publish', topic, envelope }) });
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as { type: string; topics?: string[]; topic?: string; envelope?: { iv: string; data: string } };
    this.sent.push(message);
    if (message.type === 'ping' && this.answersPings) this.onmessage?.({ data: JSON.stringify({ type: 'pong' }) });
  }

  /** False = a half-open socket: still OPEN for the browser, but nothing comes back any more. */
  answersPings = true;
  close(): void { this.readyState = 3; }

  topics(type: 'subscribe' | 'unsubscribe'): string[] {
    return this.sent.filter((message) => message.type === type).flatMap((message) => message.topics ?? []);
  }

  publishes(topic: string): number {
    return this.published(topic).length;
  }

  published(topic: string): Array<{ iv: string; data: string }> {
    return this.sent
      .filter((message) => message.type === 'publish' && message.topic === topic && message.envelope)
      .map((message) => message.envelope as { iv: string; data: string });
  }
}

function socketsFor(url: string): FakeWebSocket[] {
  return FakeWebSocket.sockets.filter((socket) => socket.url === url);
}

/** Open every socket the mesh dialled but has not been opened yet. */
function openAll(): void {
  FakeWebSocket.sockets.filter((socket) => socket.readyState === 0).forEach((socket) => socket.open());
}

/** The same envelope another device's mesh would publish — encrypted under the channel's derived key. */
async function envelopeFor(topic: string, payload: Record<string, unknown>): Promise<{ iv: string; data: string }> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(`blob-v1:${'pw'.repeat(16)}`), 'PBKDF2', false, ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode(topic), iterations: 100_000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return { iv: bufferToHex(iv.buffer), data: bufferToHex(data) };
}

async function decryptEnvelope(topic: string, envelope: { iv: string; data: string }): Promise<Record<string, unknown>> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(`blob-v1:${'pw'.repeat(16)}`), 'PBKDF2', false, ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode(topic), iterations: 100_000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(hexToBuffer(envelope.iv)) }, key, hexToBuffer(envelope.data),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
}

/** This device's broker client id, read out of its own announce. */
async function clientIdOf(socket: FakeWebSocket, topic: string): Promise<string> {
  const [announce] = socket.published(topic);
  if (!announce) throw new Error('expected an announce to have been published');
  return (await decryptEnvelope(topic, announce)).from as string;
}

const SimplePeerMock = (await import('simple-peer/simplepeer.min.js')).default as unknown as { created: Array<{ received: unknown[] }> };
const { ensureBlobChannel, destroyBlobChannel, getBlobChannelStatus, getBrokerLinkStatus, reconnectBlobChannel } =
  await import('../services/blobRoomManager.ts');

const DAPPS = ['dapp-one', 'dapp-two', 'dapp-three'];
const BROKER_A = 'ws://broker-a.test';
const BROKER_B = 'ws://broker-b.test';
const topicOf = (dappId: string) => `blob-v1-room-${dappId}`;
const realWebSocket = globalThis.WebSocket;

beforeEach(() => {
  FakeWebSocket.sockets = [];
  SimplePeerMock.created.length = 0;
  state.endpoints = [BROKER_A, BROKER_B];
  (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
});

afterEach(() => {
  vi.useRealTimers();
  DAPPS.forEach((dappId) => destroyBlobChannel(dappId));
  (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
});

describe('shared broker links', () => {
  it('opens one socket per endpoint — not per dapp — and subscribes every dapp topic on each', async () => {
    await ensureBlobChannel(DAPPS[0]);
    expect(FakeWebSocket.sockets).toHaveLength(2); // one per endpoint, both still dialing
    expect(getBlobChannelStatus(DAPPS[0]).brokerConnected).toBe(false);

    await ensureBlobChannel(DAPPS[1]); // joins while the sockets are still connecting
    openAll();
    await ensureBlobChannel(DAPPS[2]); // joins the open sockets

    expect(FakeWebSocket.sockets).toHaveLength(2);
    for (const url of [BROKER_A, BROKER_B]) {
      expect(new Set(socketsFor(url)[0].topics('subscribe'))).toEqual(new Set(DAPPS.map(topicOf)));
    }
    for (const dappId of DAPPS) {
      expect(getBlobChannelStatus(dappId)).toMatchObject({ active: true, brokerConnected: true, brokerUrl: BROKER_A });
      expect(getBlobChannelStatus(dappId).brokers).toEqual([
        { url: BROKER_A, connected: true },
        { url: BROKER_B, connected: true },
      ]);
    }
    expect(getBrokerLinkStatus()).toEqual([
      { url: BROKER_A, connected: true },
      { url: BROKER_B, connected: true },
    ]);
  });

  it('reaches a peer through EITHER broker, and dials it only once when both introduce it', async () => {
    await ensureBlobChannel(DAPPS[0]);
    openAll();
    const [a] = socketsFor(BROKER_A);
    const [b] = socketsFor(BROKER_B);

    // 'zz-…' sorts after every UUID, so this device is the one that dials out.
    const announce = await envelopeFor(topicOf(DAPPS[0]), { kind: 'announce', from: 'zz-remote-1', id: 'envelope-1' });
    b.deliver(topicOf(DAPPS[0]), announce); // only broker B knows this device
    await vi.waitFor(() => expect(SimplePeerMock.created).toHaveLength(1));

    // The copy that arrives over the other broker is the SAME envelope — not a second device.
    a.deliver(topicOf(DAPPS[0]), announce);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(SimplePeerMock.created).toHaveLength(1);

    // The offer goes out on every broker: which one the other side listens on is not known here.
    await vi.waitFor(() => {
      expect(a.publishes(topicOf(DAPPS[0]))).toBeGreaterThan(1);
      expect(b.publishes(topicOf(DAPPS[0]))).toBeGreaterThan(1);
    });
  });

  it('hands a signal that arrived over both brokers to the peer once', async () => {
    await ensureBlobChannel(DAPPS[0]);
    openAll();
    const [a] = socketsFor(BROKER_A);
    const [b] = socketsFor(BROKER_B);
    const topic = topicOf(DAPPS[0]);

    const announce = await envelopeFor(topic, { kind: 'announce', from: 'zz-remote-1', id: 'envelope-1' });
    b.deliver(topic, announce);
    await vi.waitFor(() => expect(SimplePeerMock.created).toHaveLength(1));

    // The answer of that device, relayed by both brokers. Feeding the same SDP to
    // simple-peer twice breaks the connection that is just being set up.
    const answer = await envelopeFor(topic, {
      kind: 'signal', from: 'zz-remote-1', to: await clientIdOf(a, topic), data: { type: 'answer' }, id: 'signal-1',
    });
    a.deliver(topic, answer);
    b.deliver(topic, answer);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(SimplePeerMock.created).toHaveLength(1);
    expect(SimplePeerMock.created[0].received).toEqual([{ type: 'answer' }]);
  });

  it('keeps working on the endpoints that are up when one is unreachable', async () => {
    await ensureBlobChannel(DAPPS[0]);
    const [a] = socketsFor(BROKER_A);
    const [b] = socketsFor(BROKER_B);

    vi.useFakeTimers();
    a.drop(); // broker A refuses the connection
    b.open();

    expect(getBlobChannelStatus(DAPPS[0])).toMatchObject({ brokerConnected: true, brokerUrl: BROKER_B });
    expect(getBlobChannelStatus(DAPPS[0]).brokers).toEqual([
      { url: BROKER_A, connected: false },
      { url: BROKER_B, connected: true },
    ]);
    expect(b.topics('subscribe')).toEqual([topicOf(DAPPS[0])]);

    // A keeps retrying on its own backoff; B is untouched by it.
    await vi.advanceTimersByTimeAsync(2100);
    expect(socketsFor(BROKER_A)).toHaveLength(2);
    expect(socketsFor(BROKER_B)).toHaveLength(1);
    expect(b.readyState).toBe(1);
  });

  it('redials the SAME endpoint after a drop — no device ends up alone on another broker', async () => {
    for (const dappId of DAPPS) await ensureBlobChannel(dappId);
    openAll();
    const [a] = socketsFor(BROKER_A);

    vi.useFakeTimers();
    a.drop();
    expect(getBlobChannelStatus(DAPPS[0]).brokerConnected).toBe(true); // B carries on
    await vi.advanceTimersByTimeAsync(2100);

    expect(socketsFor(BROKER_A)).toHaveLength(2);
    expect(socketsFor(BROKER_B)).toHaveLength(1);
    const redial = socketsFor(BROKER_A)[1];
    redial.open();
    expect(new Set(redial.topics('subscribe'))).toEqual(new Set(DAPPS.map(topicOf)));
    expect(getBlobChannelStatus(DAPPS[2]).brokers).toEqual([
      { url: BROKER_A, connected: true },
      { url: BROKER_B, connected: true },
    ]);
  });

  it('backs off a broker that accepts and drops at once, and forgets the backoff after a stable socket', async () => {
    await ensureBlobChannel(DAPPS[0]);
    vi.useFakeTimers();
    socketsFor(BROKER_B)[0].open();

    // Three accept-and-drop rounds: 2 s, 4 s, 8 s — the delay grows instead of spinning.
    for (const delay of [2000, 4000, 8000]) {
      const socket = socketsFor(BROKER_A).at(-1);
      if (!socket) throw new Error('expected a socket for broker A');
      socket.open();
      socket.drop();
      await vi.advanceTimersByTimeAsync(delay - 100);
      const before = socketsFor(BROKER_A).length;
      await vi.advanceTimersByTimeAsync(200);
      expect(socketsFor(BROKER_A).length).toBe(before + 1);
    }

    // One socket that stands long enough resets the endpoint's backoff.
    const stable = socketsFor(BROKER_A).at(-1);
    if (!stable) throw new Error('expected a socket for broker A');
    stable.open();
    await vi.advanceTimersByTimeAsync(61_000);
    stable.drop();
    const before = socketsFor(BROKER_A).length;
    await vi.advanceTimersByTimeAsync(2100);
    expect(socketsFor(BROKER_A).length).toBe(before + 1);
  });

  it('replaces a socket that went silent, per endpoint, and leaves the one that still answers alone', async () => {
    vi.useFakeTimers();
    await ensureBlobChannel(DAPPS[0]);
    await ensureBlobChannel(DAPPS[1]);
    openAll();
    const [a] = socketsFor(BROKER_A);
    const [b] = socketsFor(BROKER_B);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(FakeWebSocket.sockets).toHaveLength(2);
    expect(a.sent.filter((message) => message.type === 'ping').length).toBeGreaterThan(5);
    expect(b.sent.filter((message) => message.type === 'ping').length).toBeGreaterThan(5);

    // The path to A died in the device's sleep: still OPEN, never fires `close`.
    a.answersPings = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    warn.mockRestore();

    expect(a.readyState).toBe(3);
    expect(b.readyState).toBe(1);
    expect(socketsFor(BROKER_B)).toHaveLength(1);
    expect(socketsFor(BROKER_A)).toHaveLength(2);
    const replacement = socketsFor(BROKER_A)[1];
    replacement.open();
    expect(new Set(replacement.topics('subscribe'))).toEqual(new Set([DAPPS[0], DAPPS[1]].map(topicOf)));
  });

  it('unsubscribes a closed dapp on every broker but keeps the sockets, and hangs up after the last one', async () => {
    await ensureBlobChannel(DAPPS[0]);
    openAll();
    await ensureBlobChannel(DAPPS[1]);
    const [a] = socketsFor(BROKER_A);
    const [b] = socketsFor(BROKER_B);

    destroyBlobChannel(DAPPS[0]);
    expect(a.topics('unsubscribe')).toEqual([topicOf(DAPPS[0])]);
    expect(b.topics('unsubscribe')).toEqual([topicOf(DAPPS[0])]);
    expect(a.readyState).toBe(1);
    expect(getBlobChannelStatus(DAPPS[1]).brokerConnected).toBe(true);

    destroyBlobChannel(DAPPS[1]);
    expect(a.readyState).toBe(3);
    expect(b.readyState).toBe(3);
    expect(getBlobChannelStatus(DAPPS[1]).active).toBe(false);

    // A later dapp dials fresh sockets to every endpoint.
    await ensureBlobChannel(DAPPS[2]);
    expect(FakeWebSocket.sockets).toHaveLength(4);
  });

  it('"reconnect now" replaces every broker socket even when other dapps still use them', async () => {
    await ensureBlobChannel(DAPPS[0]);
    await ensureBlobChannel(DAPPS[1]);
    openAll();
    const [a] = socketsFor(BROKER_A);
    const [b] = socketsFor(BROKER_B);

    await reconnectBlobChannel(DAPPS[0]);

    expect(a.readyState).toBe(3);
    expect(b.readyState).toBe(3);
    expect(FakeWebSocket.sockets).toHaveLength(4);
    const replacement = socketsFor(BROKER_A)[1];
    replacement.open();
    expect(new Set(replacement.topics('subscribe'))).toEqual(new Set([DAPPS[0], DAPPS[1]].map(topicOf)));
  });

  it('follows a changed endpoint setting without a reload: new socket, old one dropped, the shared one kept', async () => {
    await ensureBlobChannel(DAPPS[0]);
    openAll();
    const [a] = socketsFor(BROKER_A);
    const [b] = socketsFor(BROKER_B);

    state.endpoints = [BROKER_B, 'ws://broker-c.test'];
    state.endpointListeners.forEach((listener) => listener());

    expect(a.readyState).toBe(3); // no longer configured
    expect(b.readyState).toBe(1); // still in the list — not torn down
    const [c] = socketsFor('ws://broker-c.test');
    expect(c).toBeDefined();
    c.open();
    expect(c.topics('subscribe')).toEqual([topicOf(DAPPS[0])]);
    expect(getBrokerLinkStatus()).toEqual([
      { url: BROKER_B, connected: true },
      { url: 'ws://broker-c.test', connected: true },
    ]);
  });

  it('does not redial when the last dapp closed while the sockets were down', async () => {
    await ensureBlobChannel(DAPPS[0]);
    openAll();

    vi.useFakeTimers();
    socketsFor(BROKER_A)[0].drop();
    socketsFor(BROKER_B)[0].drop();
    destroyBlobChannel(DAPPS[0]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeWebSocket.sockets).toHaveLength(2);
  });
});
