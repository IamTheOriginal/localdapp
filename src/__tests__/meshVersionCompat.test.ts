import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLOB_PROTOCOL_VERSION, BlobPeerSession, decodeFrame, encodeFrame, type BlobSessionHost, type BlobTransport } from '../services/blobProtocol.ts';
import { BlobStore, BLOBS_DB } from '../services/blobStore.ts';
import { getMeshCompatState, reportMeshVersionMismatch, resetMeshCompat, subscribeMeshCompat } from '../services/meshCompat.ts';

/** A transport whose far side is the test itself: frames the session sends are collected. */
class ScriptedTransport implements BlobTransport {
  sent: Uint8Array[] = [];
  closed = false;
  private frameCallback: ((frame: Uint8Array) => void) | null = null;
  private closeCallback: (() => void) | null = null;
  send(frame: Uint8Array): void { this.sent.push(frame); }
  onFrame(callback: (frame: Uint8Array) => void): void { this.frameCallback = callback; }
  onClose(callback: () => void): void { this.closeCallback = callback; }
  bufferedAmount(): number { return 0; }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCallback?.();
  }
  deliver(frame: Uint8Array): void { this.frameCallback?.(frame); }
}

const PEER_KEY = 'ab'.repeat(32);
let dbCounter = 0;

function hostWith(onVersionMismatch: BlobSessionHost['onVersionMismatch']): BlobSessionHost {
  return {
    getSigningIdentity: () => new Promise(() => { /* never needed: the session stops at the hello */ }),
    isMember: () => true,
    getDescriptor: () => null,
    listAvailable: () => Promise.resolve([]),
    store: new BlobStore({ dbName: `${BLOBS_DB}-compat-${++dbCounter}` }),
    onVersionMismatch,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

afterEach(() => { resetMeshCompat(); });

describe('mesh protocol version mismatch', () => {
  it('reports a peer that speaks another version, then refuses it', async () => {
    const reported = vi.fn();
    const transport = new ScriptedTransport();
    new BlobPeerSession(transport, hostWith(reported));
    transport.deliver(encodeFrame(0, { version: BLOB_PROTOCOL_VERSION + 1, publicKey: PEER_KEY, nonce: 'n1' }));
    await flush();
    expect(reported).toHaveBeenCalledWith(BLOB_PROTOCOL_VERSION + 1, PEER_KEY);
    expect(transport.closed).toBe(true);
    // Nothing but our own hello went out — no proof to an incompatible peer.
    expect(transport.sent.map((frame) => decodeFrame(frame)?.type).filter((type) => type !== 0)).toEqual([]);
  });

  it('does not report a peer on the same version, nor a malformed version', async () => {
    const reported = vi.fn();
    const same = new ScriptedTransport();
    new BlobPeerSession(same, hostWith(reported));
    same.deliver(encodeFrame(0, { version: BLOB_PROTOCOL_VERSION, publicKey: PEER_KEY, nonce: 'n1' }));
    const junk = new ScriptedTransport();
    new BlobPeerSession(junk, hostWith(reported));
    junk.deliver(encodeFrame(0, { version: '2', publicKey: PEER_KEY, nonce: 'n1' }));
    await flush();
    expect(reported).not.toHaveBeenCalled();
    expect(junk.closed).toBe(true);
  });

  it('passes no key when the claimed key is malformed', async () => {
    const reported = vi.fn();
    const transport = new ScriptedTransport();
    new BlobPeerSession(transport, hostWith(reported));
    transport.deliver(encodeFrame(0, { version: BLOB_PROTOCOL_VERSION + 3, publicKey: 'not-a-key', nonce: 'n1' }));
    await flush();
    expect(reported).toHaveBeenCalledWith(BLOB_PROTOCOL_VERSION + 3, null);
  });
});

describe('mesh compat state', () => {
  it('tells "this device is out of date" apart from "a peer is out of date", once per dapp', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMeshCompat(listener);
    reportMeshVersionMismatch('dapp-a', 2, 1);
    reportMeshVersionMismatch('dapp-a', 3, 1);
    reportMeshVersionMismatch('dapp-b', 0, 1);
    reportMeshVersionMismatch('dapp-c', 1, 1);
    expect(getMeshCompatState()).toEqual({ newerIn: ['dapp-a'], olderIn: ['dapp-b'] });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
