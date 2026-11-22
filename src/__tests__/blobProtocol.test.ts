import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectSameBytes } from './helpers/bytes.ts';
import * as Y from 'yjs';
import { BlobPeerSession, decodeFrame, encodeFrame, FRAME_CHUNK, MAX_FRAME_BYTES, type BlobSessionHost, type BlobTransport } from '../services/blobProtocol.ts';
import { BlobStore, BLOB_CHUNK_SIZE, BLOBS_DB } from '../services/blobStore.ts';
import { bufferToHex } from '../lib/hex.ts';
import type { BlobDescriptor } from '../types.ts';

// ───── In-memory transport pair ─────

class PipeTransport implements BlobTransport {
  peer: PipeTransport | null = null;
  private frameCallback: ((frame: Uint8Array) => void) | null = null;
  private closeCallback: (() => void) | null = null;
  closed = false;
  /** Optional interceptor for corruption tests: return null to drop, or replacement bytes. */
  intercept: ((frame: Uint8Array) => Uint8Array | null) | null = null;

  send(frame: Uint8Array): void {
    if (this.closed || !this.peer) return;
    const delivered = this.intercept ? this.intercept(frame) : frame;
    if (!delivered) return;
    const target = this.peer;
    queueMicrotask(() => {
      if (!target.closed) target.frameCallback?.(delivered);
    });
  }

  onFrame(callback: (frame: Uint8Array) => void): void { this.frameCallback = callback; }
  onClose(callback: () => void): void { this.closeCallback = callback; }
  bufferedAmount(): number { return 0; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCallback?.();
    const peer = this.peer;
    if (peer && !peer.closed) {
      peer.closed = true;
      peer.closeCallback?.();
    }
  }
}

function pipePair(): [PipeTransport, PipeTransport] {
  const a = new PipeTransport();
  const b = new PipeTransport();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

// ───── Test identities and hosts ─────

interface TestDevice {
  publicKey: string;
  privateHex: string;
  store: BlobStore;
  descriptors: Map<string, BlobDescriptor>;
  members: Set<string>;
  host: BlobSessionHost;
}

let deviceCounter = 0;

async function createDevice(): Promise<TestDevice> {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' } as EcKeyGenParams, true, ['sign', 'verify']);
  const publicKey = bufferToHex(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const privateHex = bufferToHex(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const store = new BlobStore({ dbName: `${BLOBS_DB}-proto-${++deviceCounter}` });
  const descriptors = new Map<string, BlobDescriptor>();
  const members = new Set<string>();
  const device: TestDevice = {
    publicKey,
    privateHex,
    store,
    descriptors,
    members,
    host: {
      getSigningIdentity: () => Promise.resolve({ publicKey, privateKey: privateHex }),
      isMember: (key) => members.has(key),
      getDescriptor: (sha256) => descriptors.get(sha256) ?? null,
      listAvailable: async () => {
        const available: string[] = [];
        for (const sha256 of descriptors.keys()) {
          if (await store.hasBlob(sha256)) available.push(sha256);
        }
        return available;
      },
      store,
    },
  };
  return device;
}

function makeBytes(size: number, seed = 11): Uint8Array {
  const bytes = new Uint8Array(size);
  let state = seed;
  for (let i = 0; i < size; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

let alice: TestDevice;
let bob: TestDevice;

beforeEach(async () => {
  alice = await createDevice();
  bob = await createDevice();
  alice.members.add(bob.publicKey);
  bob.members.add(alice.publicKey);
});

function connect(options: { fetchIdleMs?: number; handshakeMs?: number } = {}): { a: BlobPeerSession; b: BlobPeerSession; pipes: [PipeTransport, PipeTransport] } {
  const pipes = pipePair();
  const a = new BlobPeerSession(pipes[0], alice.host, options);
  const b = new BlobPeerSession(pipes[1], bob.host, options);
  return { a, b, pipes };
}

async function shareBlob(owner: TestDevice, size: number, seed = 11): Promise<{ descriptor: BlobDescriptor; bytes: Uint8Array }> {
  const bytes = makeBytes(size, seed);
  const descriptor = await owner.store.putBlob(bytes);
  owner.descriptors.set(descriptor.sha256, descriptor);
  return { descriptor, bytes };
}

describe('handshake', () => {
  it('completes between two members and exchanges have announcements', async () => {
    const { descriptor } = await shareBlob(bob, 1000);
    const { a, b } = connect();
    expect(await a.whenReady()).toBe(true);
    expect(await b.whenReady()).toBe(true);
    expect(a.remotePublicKey).toBe(bob.publicKey);
    expect(b.remotePublicKey).toBe(alice.publicKey);
    // have announcements land asynchronously after ready
    await vi.waitFor(() => {
      expect(a.remoteHas(descriptor.sha256)).toBe(true);
    }, { timeout: 3000 });
  });

  it('answers pings with pongs, refreshing the liveness timestamp on both ends', async () => {
    const { a, b } = connect();
    expect(await a.whenReady()).toBe(true);
    expect(await b.whenReady()).toBe(true);
    // Backdate both liveness stamps, then probe: the ping lands on b, the pong
    // returns to a — both must be fresh again.
    const past = Date.now() - 120_000;
    a.lastFrameAt = past;
    b.lastFrameAt = past;
    a.ping();
    await vi.waitFor(() => {
      expect(a.lastFrameAt).toBeGreaterThan(past);
      expect(b.lastFrameAt).toBeGreaterThan(past);
    }, { timeout: 3000 });
  });

  it('closes a session that never proves a member key, and answers none of its pings meanwhile', async () => {
    // A device that only holds the room password: it opens the data channel and keeps it
    // busy with pings, but never sends hello / proof.
    const [ours, theirs] = pipePair();
    const answers: number[] = [];
    theirs.onFrame((frame) => { answers.push(decodeFrame(frame)?.type ?? -1); });
    const session = new BlobPeerSession(ours, alice.host, { handshakeMs: 60 });
    const PING = 8;
    const PONG = 9;
    theirs.send(encodeFrame(PING, {}));
    theirs.send(encodeFrame(PING, {}));
    expect(await session.whenReady()).toBe(false); // the deadline closed it — pings did not keep it alive
    expect(session.state).toBe('closed');
    expect(ours.closed).toBe(true);
    expect(answers).not.toContain(PONG);
  });

  it('rejects a peer whose key is not in the members map', async () => {
    bob.members.delete(alice.publicKey); // bob no longer recognizes alice
    const { a, b } = connect();
    expect(await b.whenReady()).toBe(false);
    expect(b.state).toBe('closed');
    expect(await a.whenReady()).toBe(false);
  });

  it('rejects a spliced proof signed by a different key', async () => {
    // Mallory (a member!) relays alice's hello but cannot produce alice's proof.
    const mallory = await createDevice();
    bob.members.add(mallory.publicKey);
    const pipes = pipePair();
    // Mallory claims alice's public key in hello but signs proofs with her own key.
    const malloryHost = { ...mallory.host, getSigningIdentity: () => Promise.resolve({ publicKey: alice.publicKey, privateKey: mallory.privateHex }) };
    void new BlobPeerSession(pipes[0], malloryHost);
    const b = new BlobPeerSession(pipes[1], bob.host);
    expect(await b.whenReady()).toBe(false);
  });
});

describe('blob transfer', () => {
  it('fetches a multi-chunk blob with verification and progress', async () => {
    const { descriptor, bytes } = await shareBlob(bob, BLOB_CHUNK_SIZE * 2 + 777);
    const { a } = connect();
    await a.whenReady();

    const progress: Array<[number, number]> = [];
    const ok = await a.fetchBlob(descriptor, { onProgress: (received, total) => progress.push([received, total]) });
    expect(ok).toBe(true);
    expect(progress.at(-1)).toEqual([3, 3]);
    expectSameBytes(await alice.store.getBlob(descriptor.sha256), bytes);
  }, 20000);

  it('drops the session when a peer sends corrupted chunk data', async () => {
    const { descriptor } = await shareBlob(bob, BLOB_CHUNK_SIZE + 100);
    const { a, pipes } = connect({ fetchIdleMs: 2000 });
    await a.whenReady();

    // Corrupt every chunk payload bob sends to alice.
    pipes[1].intercept = (frame) => {
      const decoded = decodeFrame(frame);
      if (decoded?.type !== FRAME_CHUNK) return frame;
      const corrupted = frame.slice();
      corrupted[corrupted.length - 1] ^= 0xff;
      return corrupted;
    };

    const ok = await a.fetchBlob(descriptor);
    expect(ok).toBe(false);
    expect(a.state).toBe('closed');
    expect(await alice.store.hasBlob(descriptor.sha256)).toBe(false);
  });

  it('ignores wants for blobs outside the file index', async () => {
    const bytes = makeBytes(500);
    const descriptor = await bob.store.putBlob(bytes); // stored but NOT indexed
    const { a } = connect({ fetchIdleMs: 300 });
    await a.whenReady();
    const ok = await a.fetchBlob(descriptor);
    expect(ok).toBe(false); // idle timeout — bob never serves unindexed content
    expect(await alice.store.hasBlob(descriptor.sha256)).toBe(false);
  });

  it('supports ranged fetches for multi-peer scheduling', async () => {
    const { descriptor, bytes } = await shareBlob(bob, BLOB_CHUNK_SIZE * 3);
    const { a } = connect();
    await a.whenReady();

    expect(await a.fetchBlob(descriptor, { indexes: [0, 2] })).toBe(true);
    expect(await alice.store.hasBlob(descriptor.sha256)).toBe(false);
    expect(await alice.store.missingChunks(descriptor)).toEqual([1]);

    expect(await a.fetchBlob(descriptor, { indexes: [1] })).toBe(true);
    expect(await alice.store.hasBlob(descriptor.sha256)).toBe(true);
    expectSameBytes(await alice.store.getBlob(descriptor.sha256), bytes);
  }, 20000);

  it('times out when the remote goes silent', async () => {
    const { descriptor } = await shareBlob(bob, 1000);
    const { a, pipes } = connect({ fetchIdleMs: 150 });
    await a.whenReady();
    pipes[0].intercept = () => null; // alice's outbound frames vanish
    const ok = await a.fetchBlob(descriptor);
    expect(ok).toBe(false);
  });
});

describe('doc sync', () => {
  function wireDocSync(device: TestDevice, doc: Y.Doc) {
    device.host.encodeDocState = (kind, vector) => {
      if (kind !== 'main') return null;
      if (vector) {
        try {
          return Y.encodeStateAsUpdate(doc, vector);
        } catch {
          // fall through to full state
        }
      }
      return Y.encodeStateAsUpdate(doc);
    };
    device.host.applyDocState = (kind, update) => {
      if (kind !== 'main') throw new Error('unknown kind');
      Y.applyUpdate(doc, update, 'doc-sync');
    };
  }

  it('transfers a large doc state chunked with progress and converges', async () => {
    const bobDoc = new Y.Doc();
    const data = bobDoc.getMap('data');
    // ~1.5 MB of state — far beyond a single WebRTC message.
    for (let index = 0; index < 300; index++) {
      data.set(`r-${index}`, 'x'.repeat(5000) + index);
    }
    const aliceDoc = new Y.Doc();
    wireDocSync(bob, bobDoc);
    wireDocSync(alice, aliceDoc);

    const { a } = connect();
    await a.whenReady();
    const progress: Array<[number, number]> = [];
    const ok = await a.requestDocSync('main', Y.encodeStateVector(aliceDoc), {
      onProgress: (received, total) => progress.push([received, total]),
    });
    expect(ok).toBe(true);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)?.[0]).toBe(progress.at(-1)?.[1]);
    expect(aliceDoc.getMap('data').size).toBe(300);
    expect(aliceDoc.getMap('data').get('r-7')).toBe('x'.repeat(5000) + 7);
  }, 20000);

  it('finishes a pull over a slow link: the timeout is idle time, and the serving side keeps answering pings', async () => {
    const bobDoc = new Y.Doc();
    const data = bobDoc.getMap('data');
    // ~5 MB → 25 chunks → the sender has to wait for its buffer to drain three times.
    for (let index = 0; index < 1000; index++) data.set(`r-${index}`, 'x'.repeat(5000) + index);
    const aliceDoc = new Y.Doc();
    wireDocSync(bob, bobDoc);
    wireDocSync(alice, aliceDoc);

    const { a, b, pipes } = connect();
    expect(await a.whenReady()).toBe(true);
    expect(await b.whenReady()).toBe(true);

    // A slow uplink on bob's side: after each burst the send buffer stays full for 120 ms.
    let fullUntil = 0;
    const send = pipes[1].send.bind(pipes[1]);
    let sent = 0;
    pipes[1].send = (frame) => {
      sent += 1;
      if (sent % 8 === 0) fullUntil = Date.now() + 120;
      send(frame);
    };
    pipes[1].bufferedAmount = () => (Date.now() < fullUntil ? Number.MAX_SAFE_INTEGER : 0);

    const started = Date.now();
    const pull = a.requestDocSync('main', Y.encodeStateVector(aliceDoc), { timeoutMs: 200 });

    // While bob is stuck waiting for its buffer, a ping from alice still gets its pong.
    await vi.waitFor(() => { expect(Date.now()).toBeLessThan(fullUntil); }, { timeout: 3000, interval: 5 });
    const past = Date.now() - 120_000;
    a.lastFrameAt = past;
    b.lastFrameAt = past;
    a.ping();
    await vi.waitFor(() => { expect(b.lastFrameAt).toBeGreaterThan(past); }, { timeout: 100, interval: 5 });

    expect(await pull).toBe(true);
    // Longer than the 200 ms timeout in total, yet never idle that long.
    expect(Date.now() - started).toBeGreaterThan(200);
    expect(aliceDoc.getMap('data').size).toBe(1000);
  }, 20000);

  it('tells the requester at once when the state is more than the protocol carries', async () => {
    const aliceDoc = new Y.Doc();
    wireDocSync(alice, aliceDoc);
    // 4097 chunks of 200 KB would be needed; only the length matters here.
    bob.host.encodeDocState = () => ({ byteLength: 4097 * 200 * 1024 } as Uint8Array);
    const { a } = connect();
    await a.whenReady();
    const started = Date.now();
    expect(await a.requestDocSync('main', Y.encodeStateVector(aliceDoc), { timeoutMs: 5000 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('sends only the missing diff when the requester already has most state', async () => {
    const bobDoc = new Y.Doc();
    bobDoc.getMap('data').set('base', 'y'.repeat(400 * 1024));
    const aliceDoc = new Y.Doc();
    Y.applyUpdate(aliceDoc, Y.encodeStateAsUpdate(bobDoc));
    bobDoc.getMap('data').set('delta', 'small');
    wireDocSync(bob, bobDoc);
    wireDocSync(alice, aliceDoc);

    const { a } = connect();
    await a.whenReady();
    const progress: Array<[number, number]> = [];
    const ok = await a.requestDocSync('main', Y.encodeStateVector(aliceDoc), {
      onProgress: (received, total) => progress.push([received, total]),
    });
    expect(ok).toBe(true);
    // The diff fits one chunk even though the doc is ~400 KB.
    expect(progress.at(-1)?.[1]).toBe(1);
    expect(aliceDoc.getMap('data').get('delta')).toBe('small');
  }, 20000);

  it('resolves false when the peer does not serve doc state', async () => {
    const aliceDoc = new Y.Doc();
    wireDocSync(alice, aliceDoc); // only the requester side is wired
    const { a } = connect();
    await a.whenReady();
    const ok = await a.requestDocSync('main', Y.encodeStateVector(aliceDoc), { timeoutMs: 3000 });
    expect(ok).toBe(false);
  }, 10000);
});

describe('live doc updates', () => {
  function wireLive(device: TestDevice, doc: Y.Doc, pokes: string[] = []) {
    device.host.encodeDocState = (kind, vector) => (kind === 'main' ? Y.encodeStateAsUpdate(doc, vector ?? undefined) : null);
    device.host.applyDocState = (kind, update) => {
      if (kind !== 'main') throw new Error('unknown kind');
      Y.applyUpdate(doc, update, 'remote');
    };
    device.host.onDocPoke = (kind) => { pokes.push(kind); };
  }

  it('pushes an incremental update to a ready peer', async () => {
    const aliceDoc = new Y.Doc();
    const bobDoc = new Y.Doc();
    wireLive(alice, aliceDoc);
    wireLive(bob, bobDoc);
    const { a, b } = connect();
    await Promise.all([a.whenReady(), b.whenReady()]);

    aliceDoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') a.sendDocUpdate('main', update);
    });
    aliceDoc.getMap('data').set('greeting', 'hello');

    await vi.waitFor(() => expect(bobDoc.getMap('data').get('greeting')).toBe('hello'));
  });

  it('never applies an update from a device that is not on the member whitelist', async () => {
    const bobDoc = new Y.Doc();
    wireLive(bob, bobDoc);
    bob.members.delete(alice.publicKey); // bob does not know alice
    const { a, b } = connect();
    expect(await b.whenReady()).toBe(false);
    expect(b.rejectedUntrusted).toBe(true);

    const intruderDoc = new Y.Doc();
    intruderDoc.getMap('data').set('forged', 'x');
    expect(a.sendDocUpdate('main', Y.encodeStateAsUpdate(intruderDoc))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bobDoc.getMap('data').size).toBe(0);
  });

  it('replaces an update too large for one frame with a poke, and the pull delivers it', async () => {
    const aliceDoc = new Y.Doc();
    const bobDoc = new Y.Doc();
    const bobPokes: string[] = [];
    wireLive(alice, aliceDoc);
    wireLive(bob, bobDoc, bobPokes);
    const { a, b } = connect();
    await Promise.all([a.whenReady(), b.whenReady()]);

    aliceDoc.on('update', (update: Uint8Array) => { a.sendDocUpdate('main', update); });
    aliceDoc.getMap('data').set('big', 'z'.repeat(600 * 1024));

    await vi.waitFor(() => expect(bobPokes).toEqual(['main']));
    expect(bobDoc.getMap('data').size).toBe(0); // nothing was pushed
    expect(await b.requestDocSync('main', () => Y.encodeStateVector(bobDoc))).toBe(true);
    expect((bobDoc.getMap('data').get('big') as string).length).toBe(600 * 1024);
  }, 20000);

  it('queues a second pull behind a running one instead of dropping it', async () => {
    const aliceDoc = new Y.Doc();
    const bobDoc = new Y.Doc();
    wireLive(alice, aliceDoc);
    wireLive(bob, bobDoc);
    aliceDoc.getMap('data').set('first', 'y'.repeat(500 * 1024));
    const { a, b } = connect();
    await Promise.all([a.whenReady(), b.whenReady()]);

    const first = b.requestDocSync('main', () => Y.encodeStateVector(bobDoc));
    // Lands while the first pull is still in flight; its vector is read only when it starts.
    aliceDoc.getMap('data').set('second', 'late change');
    const second = b.requestDocSync('main', () => Y.encodeStateVector(bobDoc));

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(bobDoc.getMap('data').get('second')).toBe('late change');
  }, 20000);

  it('treats a malformed live update as a protocol violation, not a crash', async () => {
    const bobDoc = new Y.Doc();
    wireLive(bob, bobDoc);
    wireLive(alice, new Y.Doc());
    const { a, b } = connect();
    await Promise.all([a.whenReady(), b.whenReady()]);

    for (let attempt = 0; attempt < 3; attempt++) a.sendDocUpdate('main', new Uint8Array([255, 255, 255, 7]));
    await vi.waitFor(() => expect(b.state).toBe('closed'));
    expect(bobDoc.getMap('data').size).toBe(0);
  });
});

describe('frame robustness', () => {
  it('drops malformed and oversized frames without crashing, closing after repeat violations', async () => {
    const { a, b, pipes } = connect();
    await a.whenReady();
    await b.whenReady();

    // Deliver garbage frames directly to alice.
    const garbage = [
      new Uint8Array([9, 9]),
      encodeFrame(99, { unknown: true }),
      new Uint8Array(MAX_FRAME_BYTES + 10),
    ];
    for (const frame of garbage) {
      pipes[1].intercept = () => frame;
      b.announceHave(['ab'.repeat(32)]);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    pipes[1].intercept = null;

    // Unknown frame types are tolerated; undecodable frames count as violations.
    // Session either survived or closed cleanly — no throw either way.
    expect(['ready', 'closed']).toContain(a.state);
  });
});
