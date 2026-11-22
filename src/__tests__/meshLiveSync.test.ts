import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bufferToHex } from '../lib/hex.ts';

/**
 * End-to-end test of the member mesh as the dapp's live-sync transport.
 *
 * Two "devices" run inside one module instance: two dapp ids that share room
 * credentials derive the same broker topic, so their channels find each other
 * through the fake broker (over the one socket a device keeps for all its
 * dapps) and connect over the fake peer connection below.
 * Each side has its own documents and its own whitelist decision, which is
 * everything the transport cares about; the real handshake (Ed25519 proofs)
 * and the real frame protocol run unchanged.
 */

const ALICE = 'device-alice';
const BOB = 'device-bob';
const CAROL = 'device-carol';

const state = vi.hoisted(() => ({
  docs: new Map<string, unknown>(),
  /** dappId → whether that device's whitelist contains the (shared) test key. */
  trusts: new Map<string, boolean>(),
  identity: { publicKey: '', privateKey: '' },
  sockets: [] as Array<{ topics: Set<string>; deliver: (raw: string) => void; open: boolean }>,
  peers: new Map<string, unknown>(),
  /** Frames that went over the fake peer connections — the signal `meshQuiet` waits on. */
  frames: 0,
  /** dappId → the mesh's "verified members changed" listener (auth.ts is not running here). */
  verifiedMemberListeners: new Map<string, () => void>(),
}));

function docOf(dappId: string, kind: 'main' | 'source'): Y.Doc {
  const key = `${dappId}:${kind}`;
  let doc = state.docs.get(key) as Y.Doc | undefined;
  if (!doc) {
    doc = new Y.Doc();
    state.docs.set(key, doc);
  }
  return doc;
}

vi.mock('../services/store/docs.ts', () => ({
  getDappCredentials: () => ({ roomId: 'room-live-sync', roomPassword: 'pw'.repeat(16), epoch: 0 }),
  getDappBlobReplication: () => 'onDemand',
  getDappDoc: (dappId: string) => docOf(dappId, 'main'),
  getDappSourceDoc: (dappId: string) => docOf(dappId, 'source'),
  getDappPersistence: () => null,
  getDappSourcePersistence: () => null,
  isTrustedBlobPeer: (dappId: string) => state.trusts.get(dappId) ?? true,
  registerProviderReconnectListener: () => () => undefined,
}));
vi.mock('../services/store/auth.ts', () => ({
  onVerifiedMembersChange: (dappId: string, listener: () => void) => {
    state.verifiedMemberListeners.set(dappId, listener);
    return () => { state.verifiedMemberListeners.delete(dappId); };
  },
}));
vi.mock('../services/store/files.ts', () => ({ listFileRecords: () => [] }));
vi.mock('../services/blobStore.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/blobStore.ts')>();
  return { ...actual, getBlobStore: () => ({}) };
});
vi.mock('../services/identity.ts', () => ({ getSigningIdentity: () => Promise.resolve(state.identity) }));
vi.mock('../services/signalingConfig.ts', () => ({
  signalingEndpoints: () => ['ws://broker.test'],
  subscribeSignalingEndpoints: () => () => undefined,
  webrtcPeerOpts: () => undefined,
}));

// ───── Fake peer connection: signals pair two instances, then frames flow in order ─────

vi.mock('simple-peer/simplepeer.min.js', () => {
  let nextId = 0;
  class FakePeer {
    readonly id = `peer-${++nextId}`;
    destroyed = false;
    partner: FakePeer | null = null;
    _channel = { bufferedAmount: 0 };
    private readonly handlers = new Map<string, Array<(payload?: unknown) => void>>();

    constructor(options: { initiator: boolean }) {
      state.peers.set(this.id, this);
      if (options.initiator) queueMicrotask(() => this.emit('signal', { type: 'offer', id: this.id }));
    }

    on(event: string, handler: (payload?: unknown) => void): void {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    }

    private emit(event: string, payload?: unknown): void {
      (this.handlers.get(event) ?? []).forEach((handler) => handler(payload));
    }

    signal(data: { type: string; id: string }): void {
      const remote = state.peers.get(data.id) as FakePeer | undefined;
      if (!remote || this.destroyed) return;
      if (data.type === 'offer') {
        this.partner = remote;
        remote.partner = this;
        this.emit('signal', { type: 'answer', id: this.id });
      } else if (data.type === 'answer') {
        queueMicrotask(() => {
          this.emit('connect');
          remote.emit('connect');
        });
      }
    }

    send(frame: Uint8Array): void {
      const target = this.partner;
      if (this.destroyed || !target) throw new Error('peer closed');
      state.frames += 1;
      const copy = frame.slice();
      queueMicrotask(() => { if (!target.destroyed) target.emit('data', copy); });
    }

    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('close');
      this.partner?.destroy();
    }
  }
  return { default: FakePeer };
});

// ───── Fake broker: like server/signaling.mjs, a publish goes to EVERY subscriber of the topic, the sender's
// socket included — which is how the "devices" below reach each other over the one socket they share ─────

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly entry = { topics: new Set<string>(), deliver: (raw: string) => this.onmessage?.({ data: raw }), open: true };

  constructor() {
    state.sockets.push(this.entry);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as { type: string; topics?: string[]; topic?: string };
    if (message.type === 'subscribe') {
      (message.topics ?? []).forEach((topic) => this.entry.topics.add(topic));
      return;
    }
    if (message.type === 'unsubscribe') {
      (message.topics ?? []).forEach((topic) => this.entry.topics.delete(topic));
      return;
    }
    if (message.type !== 'publish' || !message.topic) return;
    for (const socket of state.sockets) {
      if (socket.open && socket.topics.has(message.topic)) queueMicrotask(() => socket.deliver(raw));
    }
  }

  close(): void {
    this.readyState = 3;
    this.entry.open = false;
  }
}

const { ensureBlobChannel, destroyBlobChannel, getBlobChannelStatus, MeshOrigin } = await import('../services/blobRoomManager.ts');
const { getMeshPeerKeys, subscribeMeshPeers } = await import('../services/meshPresence.ts');
const { BlobPeerSession, MAX_DOC_UPDATE_BYTES } = await import('../services/blobProtocol.ts');

const realWebSocket = globalThis.WebSocket;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  state.identity = {
    publicKey: bufferToHex(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: bufferToHex(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  };
});

beforeEach(() => {
  state.docs.clear();
  state.trusts.clear();
  state.sockets.length = 0;
  state.peers.clear();
  state.frames = 0;
  (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
});

afterEach(() => {
  [ALICE, BOB, CAROL].forEach((dappId) => destroyBlobChannel(dappId));
  (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
});

/**
 * Waits until no frame has gone over the fake peer connections for a few turns in a row.
 * Every "nothing was exchanged" assertion needs this instead of a fixed sleep: a sleep that
 * is shorter than the handshake (which happens under load) lets the test pass while the
 * mechanism it guards never ran.
 */
async function meshQuiet(quietTurns = 4, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  let seen = state.frames;
  let quiet = 0;
  while (quiet < quietTurns) {
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    if (state.frames === seen) quiet += 1;
    else {
      seen = state.frames;
      quiet = 0;
    }
    if (Date.now() - started > timeoutMs) throw new Error('the mesh kept sending frames and never went quiet');
  }
}

/** Fake peer connections that were opened and then torn down again (a refused handshake). */
function droppedPeers(): number {
  return [...state.peers.values()].filter((peer) => (peer as { destroyed: boolean }).destroyed).length;
}

async function connectDevices(...dappIds: string[]): Promise<void> {
  for (const dappId of dappIds) await ensureBlobChannel(dappId);
  await vi.waitFor(() => {
    for (const dappId of dappIds) {
      const ready = getBlobChannelStatus(dappId).peers.filter((peer) => peer.ready).length;
      expect(ready).toBe(dappIds.length - 1);
    }
  }, { timeout: 5000 });
}

describe('member mesh live sync', () => {
  it('pulls on connect what the other device wrote while apart — in both directions', async () => {
    docOf(ALICE, 'main').getMap('data').set('from-alice', 'a');
    docOf(BOB, 'main').getMap('data').set('from-bob', 'b');
    docOf(BOB, 'source').getMap('files').set('index.html', '<h1>hi</h1>');

    await connectDevices(ALICE, BOB);

    await vi.waitFor(() => {
      expect(docOf(BOB, 'main').getMap('data').get('from-alice')).toBe('a');
      expect(docOf(ALICE, 'main').getMap('data').get('from-bob')).toBe('b');
      expect(docOf(ALICE, 'source').getMap('files').get('index.html')).toBe('<h1>hi</h1>');
    }, { timeout: 5000 });
  }, 15000);

  it('pushes live changes of both documents and counts the traffic', async () => {
    await connectDevices(ALICE, BOB);

    docOf(ALICE, 'main').getMap('data').set('live', 1);
    docOf(ALICE, 'source').getMap('files').set('app.js', 'console.log(1)');

    await vi.waitFor(() => {
      expect(docOf(BOB, 'main').getMap('data').get('live')).toBe(1);
      expect(docOf(BOB, 'source').getMap('files').get('app.js')).toBe('console.log(1)');
    }, { timeout: 5000 });
    expect(getBlobChannelStatus(ALICE).docs?.main.sent).toBe(1);
    expect(getBlobChannelStatus(BOB).docs?.main.received).toBe(1);
    expect(getBlobChannelStatus(BOB).docs?.main.sent).toBe(0); // applying a remote update is not a local change
  }, 15000);

  it('tags remote updates with the verified sender and relays them without echoing back', async () => {
    await connectDevices(ALICE, BOB, CAROL);
    const origins: unknown[] = [];
    docOf(CAROL, 'main').on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));

    docOf(ALICE, 'main').getMap('data').set('shared', 'x');

    await vi.waitFor(() => expect(docOf(CAROL, 'main').getMap('data').get('shared')).toBe('x'), { timeout: 5000 });
    // Carol hears it from Alice and again relayed by Bob; the duplicate is a no-op and fires no second update.
    await meshQuiet();
    expect(origins).toHaveLength(1);
    expect(origins[0]).toBeInstanceOf(MeshOrigin);
    expect(getBlobChannelStatus(ALICE).docs?.main.received).toBe(0); // nothing bounced back to the author
  }, 15000);

  it('exchanges nothing with a device that is not on the whitelist, even though it knows the room password', async () => {
    state.trusts.set(BOB, false); // Bob's whitelist does not contain the other device's key
    docOf(ALICE, 'main').getMap('data').set('secret', 's');
    docOf(BOB, 'main').getMap('data').set('bob-only', 'b');

    await ensureBlobChannel(ALICE);
    await ensureBlobChannel(BOB);
    // The connection was made and refused — without waiting for that, the assertions below
    // would also hold while the two devices had simply not found each other yet.
    await vi.waitFor(() => { expect(droppedPeers()).toBeGreaterThan(0); }, { timeout: 5000 });
    docOf(ALICE, 'main').getMap('data').set('later', 'l');
    await meshQuiet();

    expect(docOf(BOB, 'main').getMap('data').has('secret')).toBe(false);
    expect(docOf(BOB, 'main').getMap('data').has('later')).toBe(false);
    expect(docOf(ALICE, 'main').getMap('data').has('bob-only')).toBe(false);
    expect(getMeshPeerKeys(ALICE)).toEqual([]);
    expect(getMeshPeerKeys(BOB)).toEqual([]);
  }, 15000);

  it('connects a device that dialed before its approval was verified — the refusal does not stand for the cooldown', async () => {
    // What a fresh joiner does: it has the credentials the instant it is approved and dials
    // right away, while the owner's auth scan has not accepted its member entry yet.
    state.trusts.set(ALICE, false);
    await ensureBlobChannel(ALICE);
    await ensureBlobChannel(BOB);
    await vi.waitFor(() => { expect(droppedPeers()).toBeGreaterThan(0); }, { timeout: 5000 });
    expect(getMeshPeerKeys(ALICE)).toEqual([]); // refused

    // The scan finishes: the entry is verified — without any further change to the members map.
    state.trusts.set(ALICE, true);
    state.verifiedMemberListeners.get(ALICE)?.();

    await vi.waitFor(() => {
      expect(getMeshPeerKeys(ALICE)).toEqual([state.identity.publicKey]);
      expect(getMeshPeerKeys(BOB)).toEqual([state.identity.publicKey]);
    }, { timeout: 5000 });
  }, 15000);

  it('drops an open session the moment the member list no longer trusts that device', async () => {
    await connectDevices(ALICE, BOB);
    expect(getMeshPeerKeys(ALICE)).toEqual([state.identity.publicKey]);

    // Alice syncs a removal: her whitelist stops trusting the other device.
    state.trusts.set(ALICE, false);
    docOf(ALICE, 'main').getMap('members').set('trigger', 'changed');

    await vi.waitFor(() => expect(getMeshPeerKeys(ALICE)).toEqual([]), { timeout: 5000 });
    docOf(ALICE, 'main').getMap('data').set('after-removal', 'hidden');
    await meshQuiet();
    expect(docOf(BOB, 'main').getMap('data').has('after-removal')).toBe(false);
  }, 15000);

  it('publishes verified presence and clears it when the channel closes', async () => {
    const changes: string[][] = [];
    const unsubscribe = subscribeMeshPeers(ALICE, () => changes.push(getMeshPeerKeys(ALICE)));
    await connectDevices(ALICE, BOB);
    expect(getMeshPeerKeys(ALICE)).toEqual([state.identity.publicKey]);

    destroyBlobChannel(BOB);
    await vi.waitFor(() => expect(getMeshPeerKeys(ALICE)).toEqual([]), { timeout: 5000 });
    unsubscribe();
    expect(changes).toEqual([[state.identity.publicKey], []]);
  }, 15000);

  it('stops pushing once the channel is destroyed', async () => {
    await connectDevices(ALICE, BOB);
    destroyBlobChannel(ALICE);
    docOf(ALICE, 'main').getMap('data').set('offline-edit', 1);
    await meshQuiet();
    expect(docOf(BOB, 'main').getMap('data').has('offline-edit')).toBe(false);
    expect(getBlobChannelStatus(ALICE).active).toBe(false);
  }, 15000);

  it('merges pokes that arrive during a pull into exactly one follow-up pull', async () => {
    await connectDevices(ALICE, BOB);
    await meshQuiet(); // let the pulls on connect finish

    // Hold the first pull open so further pokes arrive while it is in flight.
    const requestDocSync = BlobPeerSession.prototype.requestDocSync;
    let releaseFirstPull!: () => void;
    const firstPullHeld = new Promise<void>((resolve) => { releaseFirstPull = resolve; });
    const pulls = vi.spyOn(BlobPeerSession.prototype, 'requestDocSync').mockImplementation(function (this: InstanceType<typeof BlobPeerSession>, ...args) {
      const run = () => requestDocSync.apply(this, args);
      return pulls.mock.calls.length === 1 ? firstPullHeld.then(run) : run();
    });
    try {
      // Too large for one frame: Alice pokes, Bob has to pull.
      const large = (label: string) => label.repeat(MAX_DOC_UPDATE_BYTES + 1);
      docOf(ALICE, 'main').getMap('data').set('large-1', large('a'));
      await vi.waitFor(() => expect(pulls).toHaveBeenCalledTimes(1), { timeout: 5000 });

      docOf(ALICE, 'main').getMap('data').set('large-2', large('b'));
      docOf(ALICE, 'main').getMap('data').set('large-3', large('c'));
      await meshQuiet();
      expect(pulls).toHaveBeenCalledTimes(1); // both pokes were only noted

      releaseFirstPull();
      await vi.waitFor(() => {
        const data = docOf(BOB, 'main').getMap('data');
        expect(['large-1', 'large-2', 'large-3'].every((key) => data.has(key))).toBe(true);
      }, { timeout: 5000 });
      await meshQuiet();
      expect(pulls).toHaveBeenCalledTimes(2); // the held pull plus ONE follow-up for both pokes
      expect(pulls.mock.calls.every(([kind]) => kind === 'main')).toBe(true);

      // Merging is over once nothing is in flight: the next poke pulls right away.
      docOf(ALICE, 'main').getMap('data').set('large-4', large('d'));
      await vi.waitFor(() => expect(docOf(BOB, 'main').getMap('data').has('large-4')).toBe(true), { timeout: 5000 });
      expect(pulls).toHaveBeenCalledTimes(3);
    } finally {
      pulls.mockRestore();
    }
  }, 15000);
});

describe('member mesh connection budget', () => {
  it('opens only a handful of unproven connections however many devices announce themselves', async () => {
    await ensureBlobChannel(ALICE);
    await vi.waitFor(() => expect(getBlobChannelStatus(ALICE).brokerConnected).toBe(true));

    // Someone who only holds the room password (a removed member) — a fresh client id per
    // announce, which also sidesteps the refusal cooldown. Same envelope key as real members.
    const topic = 'blob-v1-room-live-sync';
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(`blob-v1:${'pw'.repeat(16)}`), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: new TextEncoder().encode(topic), iterations: 100_000, hash: 'SHA-256' },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
    );
    for (let index = 0; index < 60; index += 1) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      // 'z…' sorts after every UUID, so Alice is the one who would dial out.
      const payload = new TextEncoder().encode(JSON.stringify({ kind: 'announce', from: `zz-flood-${index}` }));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload);
      const envelope = { iv: bufferToHex(iv.buffer), data: bufferToHex(data) };
      state.sockets.forEach((socket) => socket.deliver(JSON.stringify({ type: 'publish', topic, envelope })));
    }
    // Wait for the budget to fill, then for the flood to be worked through: without the cap
    // the count keeps climbing past 8 while a fixed sleep is still running.
    await vi.waitFor(() => { expect(state.peers.size).toBe(8); }, { timeout: 5000 });
    await meshQuiet();

    expect(state.peers.size).toBeGreaterThan(0);
    expect(state.peers.size).toBeLessThanOrEqual(8);
    expect(getBlobChannelStatus(ALICE).peers.length).toBeLessThanOrEqual(8);
  });
});
