import type { BlobDescriptor } from '../types.ts';
import type { BlobStore } from './blobStore.ts';
import { BLOB_CHUNK_SIZE } from './blobStore.ts';
import { signWithIdentity, verifySignature, type SigningIdentity } from './store/protocolCore.ts';

/**
 * Blob exchange wire protocol v1 (docs/plans/2026-08-24-blob-store.md).
 *
 * Transport-abstract session state machine: the browser room manager feeds it
 * a data channel, tests feed it an in-memory pipe. Frames are binary:
 *
 *   [1 byte type][4 bytes BE header length][JSON header][payload bytes]
 *
 * A session serves chunks only after the membership handshake: both sides
 * exchange `hello` (public key + nonce) and `proof` (Ed25519 signature over
 * both nonces and both keys), and each side checks the proven key against the
 * dapp members map. Room credentials alone never grant blob access.
 *
 * The same session carries the dapp's Yjs documents (live-sync extension,
 * 2026-09): the member check above is the peer whitelist — nothing about a
 * document leaves this device before the remote key is proven and trusted.
 */

/**
 * Bump when a change makes this build unable to talk to the previous one. A peer
 * with another version is refused, but the mismatch is reported to the host
 * (`onVersionMismatch`) so the person is told to update instead of the two devices
 * silently never syncing.
 */
export const BLOB_PROTOCOL_VERSION = 1;

const FRAME_HELLO = 0;
const FRAME_PROOF = 1;
const FRAME_HAVE = 2;
const FRAME_WANT = 3;
export const FRAME_CHUNK = 4;
const FRAME_ABORT = 5;
// Doc-sync extension: chunked state transfer for Yjs docs. WebRTC data
// channels cap messages (~256 KB), so the requester's missing state (a diff
// against its state vector) moves in bounded chunks.
const FRAME_DOC_REQUEST = 6;
const FRAME_DOC_CHUNK = 7;
// Liveness probes: a datachannel that died during device sleep looks open
// forever; peers that answer pings are provably alive, silent ones get swept.
const FRAME_PING = 8;
/** Hello + proof are four small frames; anything slower than this is not a working connection. */
const HANDSHAKE_DEADLINE_MS = 20_000;
const FRAME_PONG = 9;
// Live-sync extension: one incremental Yjs update pushed as it happens. An
// update too large for a single frame is replaced by a `poke`, which makes the
// receiver pull the difference through the chunked request path above.
const FRAME_DOC_UPDATE = 10;
const FRAME_DOC_POKE = 11;

export const MAX_FRAME_BYTES = BLOB_CHUNK_SIZE + 8192;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_VIOLATIONS = 3;
const MAX_WANT_INDEXES = 512;
const MAX_HAVE_HASHES = 4096;
/** Chunks in flight per peer before waiting for the transport to drain. */
const MAX_IN_FLIGHT_CHUNKS = 8;
const HIGH_WATER_BYTES = 4 * BLOB_CHUNK_SIZE;
const DRAIN_POLL_MS = 25;

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const DOC_SYNC_CHUNK_BYTES = 200 * 1024;
/** Largest incremental update pushed in one frame; bigger ones go out as a poke. */
export const MAX_DOC_UPDATE_BYTES = DOC_SYNC_CHUNK_BYTES;
const MAX_DOC_SYNC_CHUNKS = 4096; // ~800 MB ceiling
const DOC_KIND_PATTERN = /^[a-z][a-z-]{0,15}$/;

export interface BlobTransport {
  send(frame: Uint8Array): void;
  onFrame(callback: (frame: Uint8Array) => void): void;
  onClose(callback: () => void): void;
  close(): void;
  /** Outbound bytes queued but not yet flushed; 0 when unknown. */
  bufferedAmount(): number;
}

export interface BlobSessionHost {
  /** This device's signing identity. */
  getSigningIdentity(): Promise<SigningIdentity>;
  /** Whether a proven public key is a current member of the dapp (any role). */
  isMember(publicKey: string): boolean;
  /** Resolve a blob hash to its descriptor via the signed file index; null when unknown. */
  getDescriptor(sha256: string): BlobDescriptor | null;
  /** Blob hashes this device can currently serve completely. */
  listAvailable(): Promise<string[]>;
  store: BlobStore;
  /**
   * Doc-sync (optional): encode this device's state for a doc kind as a diff
   * against the requester's state vector (null/invalid vector → full state),
   * and apply a received state update. Absent hosts refuse doc sync.
   */
  encodeDocState?(kind: string, vector: Uint8Array | null): Uint8Array | null;
  /** `from` is the proven session the bytes arrived on (so a host that relays updates can skip the sender). */
  applyDocState?(kind: string, update: Uint8Array, from: BlobPeerSession): void;
  /** Live sync (optional): the peer has changes too large to push — pull them. */
  onDocPoke?(kind: string, from: BlobPeerSession): void;
  /**
   * The peer's `hello` named another protocol version; the session closes right after.
   * `claimedKey` is NOT proven — the handshake stops before the proof.
   */
  onVersionMismatch?(remoteVersion: number, claimedKey: string | null): void;
}

export function encodeFrame(type: number, header: Record<string, unknown>, payload?: Uint8Array): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const frame = new Uint8Array(5 + headerBytes.length + (payload?.byteLength ?? 0));
  frame[0] = type;
  new DataView(frame.buffer).setUint32(1, headerBytes.length, false);
  frame.set(headerBytes, 5);
  if (payload) frame.set(payload, 5 + headerBytes.length);
  return frame;
}

export function decodeFrame(frame: Uint8Array): { type: number; header: Record<string, unknown>; payload: Uint8Array } | null {
  if (frame.byteLength < 5 || frame.byteLength > MAX_FRAME_BYTES) return null;
  const headerLength = new DataView(frame.buffer, frame.byteOffset).getUint32(1, false);
  if (headerLength > MAX_HEADER_BYTES || 5 + headerLength > frame.byteLength) return null;
  try {
    const header: unknown = JSON.parse(new TextDecoder().decode(frame.subarray(5, 5 + headerLength)));
    if (!header || typeof header !== 'object' || Array.isArray(header)) return null;
    return { type: frame[0], header: header as Record<string, unknown>, payload: frame.subarray(5 + headerLength) };
  } catch {
    return null;
  }
}

function handshakeProofPayload(from: string, to: string, fromNonce: string, toNonce: string): Record<string, unknown> {
  return { protocol: 'dapp-blob-v1', from, to, fromNonce, toNonce };
}

interface PendingFetch {
  descriptor: BlobDescriptor;
  expected: Map<number, string>;
  received: Set<number>;
  resolve: (complete: boolean) => void;
  onProgress?: (received: number, total: number) => void;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

type BlobSessionState = 'handshaking' | 'ready' | 'closed';

export class BlobPeerSession {
  private readonly transport: BlobTransport;
  private readonly host: BlobSessionHost;
  state: BlobSessionState = 'handshaking';
  /** Verified member key of the remote device, set once ready. */
  remotePublicKey: string | null = null;
  /** True when the remote proved a key that is not on the member whitelist. */
  rejectedUntrusted = false;
  /** Timestamp of the last frame received — the liveness signal the sweep reads. */
  lastFrameAt = Date.now();

  private readonly localNonce = crypto.randomUUID();
  private remoteHello: { publicKey: string; nonce: string } | null = null;
  private proofSent = false;
  private remoteProven = false;
  private violations = 0;
  private readonly remoteHave = new Set<string>();
  private readonly fetches = new Map<string, PendingFetch>();
  private readonly abortedServes = new Set<string>();
  private readyCallbacks: Array<(ok: boolean) => void> = [];
  private closed = false;
  private readonly fetchIdleMs: number;

  private frameChain: Promise<void> = Promise.resolve();
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(transport: BlobTransport, host: BlobSessionHost, options: { fetchIdleMs?: number; handshakeMs?: number } = {}) {
    this.transport = transport;
    this.host = host;
    this.fetchIdleMs = options.fetchIdleMs ?? 15_000;
    transport.onClose(() => this.handleClosed());
    // A hard deadline, whatever frames arrive: a device that holds the room password but
    // cannot prove a member key must not be able to park connections in `handshaking`
    // (pings used to keep such a session alive forever).
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.state === 'handshaking') this.close();
    }, options.handshakeMs ?? HANDSHAKE_DEADLINE_MS);
    // Frames MUST be processed strictly in order, one at a time: handshake
    // verification is async, and a `have` sent right after the peer's proof
    // would otherwise race the verification and be dropped as "not ready".
    transport.onFrame((frame) => {
      this.frameChain = this.frameChain.then(() => this.handleFrame(frame));
    });
    void this.sendHello();
  }

  /** Resolves true when the handshake completes, false when the session closes first. */
  whenReady(): Promise<boolean> {
    if (this.state === 'ready') return Promise.resolve(true);
    if (this.state === 'closed') return Promise.resolve(false);
    return new Promise((resolve) => this.readyCallbacks.push(resolve));
  }

  remoteHas(sha256: string): boolean {
    return this.remoteHave.has(sha256);
  }

  close(): void {
    this.transport.close();
    this.handleClosed();
  }

  /** Announce additional locally-available blob hashes to the remote. */
  announceHave(hashes: string[]): void {
    if (this.state !== 'ready') return;
    const valid = hashes.filter((hash) => HASH_PATTERN.test(hash)).slice(0, MAX_HAVE_HASHES);
    if (valid.length > 0) this.transport.send(encodeFrame(FRAME_HAVE, { hashes: valid }));
  }

  /**
   * Fetch the chunks of `descriptor` this device is missing, restricted to
   * `indexes` when given. Resolves true when every requested chunk arrived and
   * verified (the blob is also finalized once no chunks are missing overall —
   * callers splitting ranges across sessions check `store.hasBlob` at the
   * end). Never rejects — failures resolve false.
   */
  async fetchBlob(
    descriptor: BlobDescriptor,
    options: { indexes?: number[]; onProgress?: (received: number, total: number) => void } = {},
  ): Promise<boolean> {
    if (this.state !== 'ready') return false;
    if (this.fetches.has(descriptor.sha256)) return false;
    await this.host.store.registerRemoteBlob(descriptor);
    let missing = await this.host.store.missingChunks(descriptor);
    if (options.indexes) {
      const wanted = new Set(options.indexes);
      missing = missing.filter((index) => wanted.has(index));
    }
    if (missing.length === 0) return this.host.store.finalizeBlob(descriptor);

    return new Promise<boolean>((resolve) => {
      const expected = new Map<number, string>();
      for (const index of missing) expected.set(index, descriptor.chunkHashes[index]);
      const fetch: PendingFetch = {
        descriptor,
        expected,
        received: new Set(),
        onProgress: options.onProgress,
        idleTimer: null,
        resolve: (complete) => {
          if (fetch.idleTimer) clearTimeout(fetch.idleTimer);
          this.fetches.delete(descriptor.sha256);
          resolve(complete);
        },
      };
      this.fetches.set(descriptor.sha256, fetch);
      this.armIdleTimer(fetch);
      for (let offset = 0; offset < missing.length; offset += MAX_WANT_INDEXES) {
        this.transport.send(encodeFrame(FRAME_WANT, {
          sha256: descriptor.sha256,
          indexes: missing.slice(offset, offset + MAX_WANT_INDEXES),
        }));
      }
    });
  }

  /**
   * Push one incremental Yjs update to the peer. Returns false when the
   * session is not ready (the peer catches up with its pull on connect).
   */
  sendDocUpdate(kind: string, update: Uint8Array): boolean {
    if (this.state !== 'ready' || !DOC_KIND_PATTERN.test(kind)) return false;
    // Backpressure: a bulk import towards a slow peer must not pile megabytes into the
    // data channel's queue (the channel dies, the window's updates are lost). Above the
    // mark nothing is pushed; ONE poke follows once the queue drained and the peer pulls
    // everything it missed as a single diff.
    if (this.transport.bufferedAmount() > HIGH_WATER_BYTES) {
      this.owePoke(kind);
      return true;
    }
    if (update.byteLength > MAX_DOC_UPDATE_BYTES) {
      this.transport.send(encodeFrame(FRAME_DOC_POKE, { kind }));
    } else {
      this.transport.send(encodeFrame(FRAME_DOC_UPDATE, { kind }, update));
    }
    return true;
  }

  private readonly owedPokes = new Set<string>();
  private settlingOwedPokes = false;

  private owePoke(kind: string): void {
    this.owedPokes.add(kind);
    if (this.settlingOwedPokes) return;
    this.settlingOwedPokes = true;
    void this.drain().then(() => {
      this.settlingOwedPokes = false;
      const kinds = [...this.owedPokes];
      this.owedPokes.clear();
      if (this.closed) return;
      kinds.forEach((owed) => { this.transport.send(encodeFrame(FRAME_DOC_POKE, { kind: owed })); });
    });
  }

  private onDocUpdate(header: Record<string, unknown>, payload: Uint8Array): void {
    if (!this.requireReady()) return;
    const kind = header.kind;
    if (typeof kind !== 'string' || !DOC_KIND_PATTERN.test(kind) || payload.byteLength === 0 || payload.byteLength > MAX_DOC_UPDATE_BYTES) {
      return this.violation();
    }
    if (!this.host.applyDocState) return; // this side does not take doc state
    // A throw (malformed update, unknown kind) counts as a violation upstream.
    this.host.applyDocState(kind, payload.slice(), this);
  }

  private onDocPoke(header: Record<string, unknown>): void {
    if (!this.requireReady()) return;
    const kind = header.kind;
    if (typeof kind !== 'string' || !DOC_KIND_PATTERN.test(kind)) return this.violation();
    this.host.onDocPoke?.(kind, this);
  }

  private readonly docSyncBuffers = new Map<string, { chunks: Array<Uint8Array | null>; received: number; total: number }>();
  /** Tail of the per-kind request queue — requests for one kind run one after another. */
  private readonly docSyncQueue = new Map<string, Promise<unknown>>();
  private readonly docSyncWaiters = new Map<string, { id: string; resolve: (ok: boolean) => void; onProgress?: (received: number, total: number) => void; touch: () => void }>();
  /** Doc kind → id of the request being served; a newer request for the kind replaces the running one. */
  private readonly docServes = new Map<string, string>();
  private docRequestCounter = 0;

  /**
   * Request the peer's state for a doc kind as a chunked diff against our
   * state vector. Resolves true once the reassembled update was applied via
   * the host. Requests for the same kind queue behind each other (a poke that
   * lands mid-pull must not be lost), so pass the vector as a function to have
   * it encoded when the request actually goes out.
   */
  requestDocSync(
    kind: string,
    stateVector: Uint8Array | (() => Uint8Array),
    options: { onProgress?: (received: number, total: number) => void; timeoutMs?: number } = {},
  ): Promise<boolean> {
    if (this.state !== 'ready' || !this.host.applyDocState || !DOC_KIND_PATTERN.test(kind)) return Promise.resolve(false);
    const previous = this.docSyncQueue.get(kind) ?? Promise.resolve();
    const next = previous.then(() => this.requestDocSyncNow(kind, stateVector, options));
    this.docSyncQueue.set(kind, next);
    return next;
  }

  private requestDocSyncNow(
    kind: string,
    stateVector: Uint8Array | (() => Uint8Array),
    options: { onProgress?: (received: number, total: number) => void; timeoutMs?: number },
  ): Promise<boolean> {
    if (this.state !== 'ready' || this.docSyncWaiters.has(kind)) return Promise.resolve(false);
    let vector: Uint8Array;
    try {
      vector = typeof stateVector === 'function' ? stateVector() : stateVector;
    } catch {
      return Promise.resolve(false);
    }
    // The id ties chunks to THIS request: chunks of an abandoned transfer that are
    // still in flight must not be mixed into the next one's buffer.
    const id = `${++this.docRequestCounter}`;
    return new Promise((resolve) => {
      // An IDLE timeout, re-armed by every chunk: a big document over a slow link takes
      // as long as it takes; only a transfer that stopped moving is given up.
      const idleMs = options.timeoutMs ?? 120_000;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        if (this.docSyncWaiters.get(kind)?.id === id) {
          this.docSyncWaiters.delete(kind);
          this.docSyncBuffers.delete(kind);
        }
        resolve(ok);
      };
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { finish(false); }, idleMs);
      };
      touch();
      this.docSyncWaiters.set(kind, { id, onProgress: options.onProgress, touch, resolve: finish });
      this.transport.send(encodeFrame(FRAME_DOC_REQUEST, { kind, id }, vector));
    });
  }

  private onDocRequest(header: Record<string, unknown>, payload: Uint8Array): void {
    if (!this.requireReady()) return;
    const kind = header.kind;
    if (typeof kind !== 'string' || !DOC_KIND_PATTERN.test(kind)) return this.violation();
    // Builds before request ids send none; their chunks then carry none either.
    const id = typeof header.id === 'string' && header.id.length <= 32 ? header.id : undefined;
    if (!this.host.encodeDocState) return; // this side does not serve doc state
    let state: Uint8Array | null;
    try {
      state = this.host.encodeDocState(kind, payload.byteLength > 0 ? payload : null);
    } catch {
      state = null;
    }
    const total = state ? Math.max(1, Math.ceil(state.byteLength / DOC_SYNC_CHUNK_BYTES)) : 0;
    if (!state || total > MAX_DOC_SYNC_CHUNKS) {
      // Nothing to send, or more than the protocol carries: say so, or the requester waits out its timeout.
      this.transport.send(encodeFrame(FRAME_DOC_CHUNK, { kind, seq: 0, total: 0, ...(id ? { id } : {}) }));
      return;
    }
    // Served OUTSIDE the frame chain (like blob chunks): waiting for the send buffer to drain
    // inside it kept pongs and every other frame from being handled for the whole transfer,
    // so a long one looked like a dead session to this side's own liveness sweep.
    void this.serveDocState(kind, id, state, total);
  }

  private async serveDocState(kind: string, id: string | undefined, state: Uint8Array, total: number): Promise<void> {
    const serveId = id ?? `legacy-${++this.docRequestCounter}`;
    this.docServes.set(kind, serveId); // a repeated request for the kind takes over; this loop stops below
    try {
      let inFlight = 0;
      for (let seq = 0; seq < total; seq++) {
        if (this.closed || this.docServes.get(kind) !== serveId) return;
        if (inFlight >= MAX_IN_FLIGHT_CHUNKS) {
          await this.drain();
          inFlight = 0;
          if (this.closed || this.docServes.get(kind) !== serveId) return;
        }
        const chunk = state.subarray(seq * DOC_SYNC_CHUNK_BYTES, Math.min(state.byteLength, (seq + 1) * DOC_SYNC_CHUNK_BYTES));
        this.transport.send(encodeFrame(FRAME_DOC_CHUNK, { kind, seq, total, ...(id ? { id } : {}) }, chunk));
        inFlight++;
      }
    } catch {
      // transport closed mid-transfer; the requester's idle timeout ends its side
    } finally {
      if (this.docServes.get(kind) === serveId) this.docServes.delete(kind);
    }
  }

  private onDocChunk(header: Record<string, unknown>, payload: Uint8Array): void {
    if (!this.requireReady()) return;
    const kind = header.kind;
    const seq = header.seq;
    const total = header.total;
    if (typeof kind !== 'string' || !DOC_KIND_PATTERN.test(kind)
      || !Number.isInteger(seq) || !Number.isInteger(total)
      || (total as number) < 0 || (total as number) > MAX_DOC_SYNC_CHUNKS) {
      return this.violation();
    }
    const waiter = this.docSyncWaiters.get(kind);
    if (!waiter) return; // unsolicited or timed out — ignore
    // A chunk of an earlier, abandoned request for this kind (responders before request ids send none).
    if (header.id !== undefined && header.id !== waiter.id) return;
    waiter.touch();
    if (total === 0) {
      // Responder had nothing to send (no serving host or empty diff).
      waiter.resolve(false);
      return;
    }
    let buffer = this.docSyncBuffers.get(kind);
    if (!buffer) {
      buffer = { chunks: new Array<Uint8Array | null>(total as number).fill(null), received: 0, total: total as number };
      this.docSyncBuffers.set(kind, buffer);
    }
    if (buffer.total !== total || (seq as number) < 0 || (seq as number) >= buffer.total) return this.violation();
    if (!buffer.chunks[seq as number]) {
      buffer.chunks[seq as number] = payload.slice();
      buffer.received++;
      waiter.onProgress?.(buffer.received, buffer.total);
    }
    if (buffer.received < buffer.total) return;
    const size = buffer.chunks.reduce((sum, chunk) => sum + (chunk?.byteLength ?? 0), 0);
    const update = new Uint8Array(size);
    let offset = 0;
    for (const chunk of buffer.chunks) {
      if (!chunk) return waiter.resolve(false);
      update.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      this.host.applyDocState?.(kind, update, this);
      waiter.resolve(true);
    } catch {
      waiter.resolve(false);
    }
  }

  private armIdleTimer(fetch: PendingFetch): void {
    if (fetch.idleTimer) clearTimeout(fetch.idleTimer);
    fetch.idleTimer = setTimeout(() => {
      this.transport.send(encodeFrame(FRAME_ABORT, { sha256: fetch.descriptor.sha256 }));
      fetch.resolve(false);
    }, this.fetchIdleMs);
  }

  private async sendHello(): Promise<void> {
    try {
      const identity = await this.host.getSigningIdentity();
      if (this.closed) return;
      this.transport.send(encodeFrame(FRAME_HELLO, {
        version: BLOB_PROTOCOL_VERSION,
        publicKey: identity.publicKey,
        nonce: this.localNonce,
      }));
    } catch {
      this.close();
    }
  }

  private violation(): void {
    this.violations++;
    if (this.violations >= MAX_VIOLATIONS) this.close();
  }

  private handleClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.state = 'closed';
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.fetches.forEach((fetch) => fetch.resolve(false));
    this.docSyncWaiters.forEach((waiter) => waiter.resolve(false));
    this.readyCallbacks.splice(0).forEach((callback) => callback(false));
  }

  /** Sends a liveness probe; the peer's pong refreshes its lastFrameAt on our side. */
  ping(): void {
    if (this.closed) return;
    this.transport.send(encodeFrame(FRAME_PING, {}));
  }

  private async handleFrame(frame: Uint8Array): Promise<void> {
    if (this.closed) return;
    this.lastFrameAt = Date.now();
    const decoded = decodeFrame(frame);
    if (!decoded) {
      this.violation();
      return;
    }
    const { type, header, payload } = decoded;
    try {
      switch (type) {
        case FRAME_HELLO: return await this.onHello(header);
        case FRAME_PROOF: return await this.onProof(header);
        case FRAME_HAVE: return this.onHave(header);
        case FRAME_WANT: return this.onWant(header);
        case FRAME_CHUNK: return await this.onChunk(header, payload);
        case FRAME_ABORT: return this.onAbort(header);
        case FRAME_DOC_REQUEST: return this.onDocRequest(header, payload);
        case FRAME_DOC_CHUNK: return this.onDocChunk(header, payload);
        case FRAME_PING:
          // Unproven peers get no answer (and no violation — an honest peer's sweep may ping mid-handshake).
          if (this.state === 'ready') this.transport.send(encodeFrame(FRAME_PONG, {}));
          return;
        case FRAME_PONG: return; // lastFrameAt above is the whole point
        case FRAME_DOC_UPDATE: return this.onDocUpdate(header, payload);
        case FRAME_DOC_POKE: return this.onDocPoke(header);
        default: return; // unknown types are ignored (forward compatibility)
      }
    } catch {
      this.violation();
    }
  }

  private async onHello(header: Record<string, unknown>): Promise<void> {
    if (this.remoteHello || this.state !== 'handshaking') return this.violation();
    const publicKey = header.publicKey;
    const nonce = header.nonce;
    if (typeof header.version === 'number' && Number.isInteger(header.version) && header.version !== BLOB_PROTOCOL_VERSION) {
      try {
        this.host.onVersionMismatch?.(header.version, typeof publicKey === 'string' && HASH_PATTERN.test(publicKey) ? publicKey : null);
      } catch { /* reporting must never keep an incompatible session open */ }
      this.close();
      return;
    }
    if (header.version !== BLOB_PROTOCOL_VERSION
      || typeof publicKey !== 'string' || !HASH_PATTERN.test(publicKey)
      || typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 128) {
      this.close();
      return;
    }
    this.remoteHello = { publicKey, nonce };
    const identity = await this.host.getSigningIdentity();
    const payload = handshakeProofPayload(identity.publicKey, publicKey, this.localNonce, nonce);
    const signature = await signWithIdentity(identity, payload);
    if (this.closed) return;
    this.proofSent = true;
    this.transport.send(encodeFrame(FRAME_PROOF, { ...payload, ...signature }));
    this.maybeReady();
  }

  private async onProof(header: Record<string, unknown>): Promise<void> {
    if (this.remoteProven || this.state !== 'handshaking') return this.violation();
    if (!this.remoteHello) return this.violation();
    const identity = await this.host.getSigningIdentity();
    const expected = handshakeProofPayload(this.remoteHello.publicKey, identity.publicKey, this.remoteHello.nonce, this.localNonce);
    const matchesExpected = (Object.entries(expected))
      .every(([key, value]) => header[key] === value);
    const signedBy = header._signedBy;
    if (!matchesExpected || signedBy !== this.remoteHello.publicKey) {
      this.close();
      return;
    }
    if (!(await verifySignature(header, this.remoteHello.publicKey))) {
      this.close();
      return;
    }
    if (!this.host.isMember(this.remoteHello.publicKey)) {
      this.rejectedUntrusted = true;
      this.close();
      return;
    }
    this.remoteProven = true;
    this.maybeReady();
  }

  private maybeReady(): void {
    if (this.state !== 'handshaking' || !this.proofSent || !this.remoteProven || !this.remoteHello) return;
    this.state = 'ready';
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.remotePublicKey = this.remoteHello.publicKey;
    this.readyCallbacks.splice(0).forEach((callback) => callback(true));
    void this.host.listAvailable().then((hashes) => this.announceHave(hashes));
  }

  private requireReady(): boolean {
    if (this.state === 'ready') return true;
    this.violation();
    return false;
  }

  private onHave(header: Record<string, unknown>): void {
    if (!this.requireReady()) return;
    const hashes = header.hashes;
    if (!Array.isArray(hashes) || hashes.length > MAX_HAVE_HASHES) return this.violation();
    for (const hash of hashes) {
      if (typeof hash === 'string' && HASH_PATTERN.test(hash)) this.remoteHave.add(hash);
    }
  }

  private onWant(header: Record<string, unknown>): void {
    if (!this.requireReady()) return;
    const sha256 = header.sha256;
    const indexes = header.indexes;
    if (typeof sha256 !== 'string' || !HASH_PATTERN.test(sha256)
      || !Array.isArray(indexes) || indexes.length > MAX_WANT_INDEXES
      || indexes.some((index) => !Number.isInteger(index))) {
      return this.violation();
    }
    // Serving is gated on the signed file index: only content a valid record
    // references is ever handed out, so deleted blobs stop being served once
    // the tombstone lands even if chunks linger locally before GC.
    const descriptor = this.host.getDescriptor(sha256);
    if (!descriptor) return; // unknown or deleted — silently ignore
    if ((indexes as number[]).some((index) => index < 0 || index >= descriptor.chunkHashes.length)) {
      return this.violation();
    }
    this.abortedServes.delete(sha256);
    // The serve loop runs OUTSIDE the frame chain: a long transfer must not
    // stall processing of concurrent frames (abort, other wants, chunks).
    void this.serveChunks(descriptor, sha256, indexes as number[]);
  }

  private async serveChunks(descriptor: BlobDescriptor, sha256: string, indexes: number[]): Promise<void> {
    let inFlight = 0;
    for (const index of indexes) {
      if (this.closed || this.abortedServes.has(sha256)) return;
      const bytes = await this.host.store.getChunk(descriptor.chunkHashes[index]);
      if (!bytes) continue;
      if (inFlight >= MAX_IN_FLIGHT_CHUNKS) {
        await this.drain();
        inFlight = 0;
      }
      if (this.closed || this.abortedServes.has(sha256)) return;
      this.transport.send(encodeFrame(FRAME_CHUNK, { sha256, index }, bytes));
      inFlight++;
    }
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.transport.bufferedAmount() > HIGH_WATER_BYTES) {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
  }

  private async onChunk(header: Record<string, unknown>, payload: Uint8Array): Promise<void> {
    if (!this.requireReady()) return;
    const sha256 = header.sha256;
    const index = header.index;
    if (typeof sha256 !== 'string' || !Number.isInteger(index)) return this.violation();
    const fetch = this.fetches.get(sha256);
    if (!fetch) return; // late chunk after abort/timeout — ignore
    const expectedHash = fetch.expected.get(index as number);
    if (!expectedHash || fetch.received.has(index as number)) return;

    if (!(await this.host.store.putChunkVerified(expectedHash, payload))) {
      // Hash mismatch — the peer sent corrupted or forged data.
      this.transport.send(encodeFrame(FRAME_ABORT, { sha256 }));
      fetch.resolve(false);
      this.close();
      return;
    }
    fetch.received.add(index as number);
    this.armIdleTimer(fetch);
    fetch.onProgress?.(fetch.received.size, fetch.expected.size);
    if (fetch.received.size === fetch.expected.size) {
      if ((await this.host.store.missingChunks(fetch.descriptor)).length === 0) {
        await this.host.store.finalizeBlob(fetch.descriptor);
      }
      fetch.resolve(true);
    }
  }

  private onAbort(header: Record<string, unknown>): void {
    if (!this.requireReady()) return;
    const sha256 = header.sha256;
    if (typeof sha256 !== 'string' || !HASH_PATTERN.test(sha256)) return this.violation();
    this.abortedServes.add(sha256);
    this.fetches.get(sha256)?.resolve(false);
  }
}
