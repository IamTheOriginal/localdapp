import { setRuntimeNetworkOverrides, type IceServerEntry } from '../services/signalingConfig.ts';

/**
 * Node environment bootstrap for the headless runtime (docs/HEADLESS.md).
 *
 * The browser store stack expects `localStorage`, `indexedDB`, and WebRTC to
 * exist. This module installs Node-side stand-ins ONCE at boot, before any
 * store module runs:
 *
 * - `localStorage`: Node ≥ 25 ships an in-memory global; older Nodes get a
 *   Map-backed polyfill. Volatile either way — everything the headless runtime
 *   must keep (identity, doc state) is persisted to real files by
 *   `identityFile.ts` / `filePersistence.ts` and re-seeded at every boot.
 * - `indexedDB`: fake-indexeddb (in-memory). y-indexeddb and the identity key
 *   cache work against it; durable doc state comes from file persistence.
 * - WebRTC: node-datachannel's polyfill, injected into every room manager via
 *   `setRuntimeNetworkOverrides` so y-webrtc providers and the blob mesh both
 *   use it.
 */

interface HeadlessNetworkConfig {
  signalingUrls: string[];
  iceServers?: IceServerEntry[];
}

function localStorageWorks(): boolean {
  try {
    const probe = '__headless_probe__';
    localStorage.setItem(probe, 'ok');
    const roundTrip = localStorage.getItem(probe) === 'ok';
    localStorage.removeItem(probe);
    return roundTrip;
  } catch {
    return false;
  }
}

export function installLocalStoragePolyfill(): void {
  // Node's built-in localStorage can exist but be non-functional (e.g. a
  // missing/invalid --localstorage-file) — verify it actually works.
  if (typeof localStorage !== 'undefined' && localStorageWorks()) return;
  const backing = new Map<string, string>();
  const storage = {
    getItem: (key: string): string | null => backing.get(key) ?? null,
    setItem: (key: string, value: string): void => { backing.set(key, String(value)); },
    removeItem: (key: string): void => { backing.delete(key); },
    clear: (): void => { backing.clear(); },
    key: (index: number): string | null => [...backing.keys()][index] ?? null,
    get length(): number { return backing.size; },
  };
  (globalThis as Record<string, unknown>).localStorage = storage;
}

interface PlainSessionDescription { type: string; sdp: string }

/**
 * simple-peer mutates the `sdp` property of the offer/answer objects it gets
 * back from `createOffer`/`createAnswer` (trickle filtering). Browsers return
 * plain objects there; node-datachannel returns `RTCSessionDescription`
 * instances with getter-only properties, which makes simple-peer throw
 * "Cannot set property sdp". Wrap the peer connection so those calls resolve
 * to plain `{ type, sdp }` objects.
 */
function createNodeWrtc(polyfill: typeof import('node-datachannel/polyfill')): object {
  const NativePeerConnection = polyfill.RTCPeerConnection as unknown as new (...args: unknown[]) => object;
  class PlainSdpPeerConnection extends NativePeerConnection {}

  type SdpFactory = (this: object, ...args: unknown[]) => Promise<PlainSessionDescription>;
  const nativeProto = NativePeerConnection.prototype as Record<string, SdpFactory>;
  const patchedProto = PlainSdpPeerConnection.prototype as Record<string, SdpFactory>;
  for (const method of ['createOffer', 'createAnswer'] as const) {
    const native = nativeProto[method];
    patchedProto[method] = async function (...args: unknown[]): Promise<PlainSessionDescription> {
      const description = await native.apply(this, args);
      return { type: description.type, sdp: description.sdp };
    };
  }

  return {
    RTCPeerConnection: PlainSdpPeerConnection,
    RTCSessionDescription: polyfill.RTCSessionDescription,
    RTCIceCandidate: polyfill.RTCIceCandidate,
  };
}

let initialized = false;

/** Idempotent; must run before any store/service module touches storage or rooms. */
export async function initHeadlessEnvironment(config: HeadlessNetworkConfig): Promise<void> {
  if (config.signalingUrls.length === 0) {
    throw new Error('headless env: at least one signaling URL is required (SIGNALING_URLS)');
  }
  if (!initialized) {
    installLocalStoragePolyfill();
    if (typeof indexedDB === 'undefined') {
      await import('fake-indexeddb/auto');
    }
    const polyfill = await import('node-datachannel/polyfill');
    setRuntimeNetworkOverrides({ wrtc: createNodeWrtc(polyfill) });
    initialized = true;
  }
  setRuntimeNetworkOverrides({
    signalingUrls: config.signalingUrls,
    ...(config.iceServers ? { iceServers: config.iceServers } : {}),
  });
}
