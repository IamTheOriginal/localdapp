import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

/**
 * Regression: ensureBlobChannel awaits key derivation before registering in
 * the channel map, so overlapping calls (React StrictMode double effects,
 * multiple pages ensuring the same dapp) both passed the existence check and
 * spawned a second, orphaned channel — an invisible twin with its own broker
 * socket and clientId that every peer saw as a duplicate device.
 */

// The channel wires the dapp's documents for live sync as it opens.
const docs = vi.hoisted((): { main: unknown; source: unknown } => ({ main: null, source: null }));

vi.mock('../services/store/docs.ts', () => ({
  getDappCredentials: () => ({ roomId: 'room-single-flight', roomPassword: 'pw'.repeat(16), epoch: 0 }),
  getDappBlobReplication: () => 'onDemand',
  isTrustedBlobPeer: () => true,
  registerProviderReconnectListener: () => () => undefined,
  getDappDoc: () => docs.main,
  getDappSourceDoc: () => docs.source,
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
  signalingEndpoints: () => ['ws://broker.test'],
  subscribeSignalingEndpoints: () => () => undefined,
  webrtcPeerOpts: () => undefined,
}));

class FakeWebSocket {
  static instances = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: unknown = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances += 1;
  }
  send(): void { /* noop */ }
  close(): void { this.readyState = 3; }
}

docs.main = new Y.Doc();
docs.source = new Y.Doc();

const { ensureBlobChannel, destroyBlobChannel } = await import('../services/blobRoomManager.ts');

describe('blob channel single-flight creation', () => {
  const realWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = 0;
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    destroyBlobChannel('dapp-race');
    (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
  });

  it('creates exactly one channel (one broker socket) under concurrent ensure calls', async () => {
    const results = await Promise.all([
      ensureBlobChannel('dapp-race'),
      ensureBlobChannel('dapp-race'),
      ensureBlobChannel('dapp-race'),
    ]);
    expect(results).toEqual([true, true, true]);
    expect(FakeWebSocket.instances).toBe(1);

    // A later call reuses the live channel instead of dialing again.
    expect(await ensureBlobChannel('dapp-race')).toBe(true);
    expect(FakeWebSocket.instances).toBe(1);
  });
});
