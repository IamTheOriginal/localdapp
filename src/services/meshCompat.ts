/**
 * Version compatibility of the member mesh — which dapps met a device that
 * speaks a different mesh protocol version (blobProtocol.ts `hello`).
 *
 * Two devices with different versions cannot sync; before this module they
 * simply never connected and nobody could tell why. Now the handshake reports
 * the mismatch here and the shell tells the person what to do: a NEWER peer
 * means this device should reload to update, an OLDER one means somebody else
 * has to update theirs.
 *
 * The version in a `hello` is not proven yet (the handshake stops before the
 * proof), so a report only counts when the key it claims is a member of the
 * dapp — i.e. from somebody holding the room credentials. The worst a forged
 * report does is show an "update" hint. Leaf module: the shell imports it
 * without pulling in the WebRTC stack.
 */

export interface MeshCompatState {
  /** Dapps in which a device with a NEWER protocol was met — this device is out of date. */
  newerIn: string[];
  /** Dapps in which a device with an OLDER protocol was met — somebody else is out of date. */
  olderIn: string[];
}

const EMPTY: MeshCompatState = { newerIn: [], olderIn: [] };
let state: MeshCompatState = EMPTY;
const listeners = new Set<() => void>();

export function getMeshCompatState(): MeshCompatState {
  return state;
}

export function subscribeMeshCompat(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Called by the mesh when a member's `hello` carried a protocol version other than ours. */
export function reportMeshVersionMismatch(dappId: string, remoteVersion: number, localVersion: number): void {
  if (!Number.isInteger(remoteVersion) || remoteVersion === localVersion) return;
  const key = remoteVersion > localVersion ? 'newerIn' : 'olderIn';
  if (state[key].includes(dappId)) return;
  state = { ...state, [key]: [...state[key], dappId] };
  if (key === 'newerIn') console.warn(`mesh: a member of dapp ${dappId} runs mesh protocol v${remoteVersion}, this device v${localVersion} — reload to update`);
  else console.warn(`mesh: a member of dapp ${dappId} runs the older mesh protocol v${remoteVersion} (this device v${localVersion}) — that device has to update`);
  listeners.forEach((listener) => {
    try { listener(); } catch (error) { console.error('mesh compat listener failed', error); }
  });
}

/** Tests only. */
export function resetMeshCompat(): void {
  state = EMPTY;
}
