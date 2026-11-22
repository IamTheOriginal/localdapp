/**
 * Who is connected to a dapp right now — fed by the member mesh
 * (blobRoomManager.ts), read by hooks, the sync panel and the keeper.
 *
 * Every key in here was PROVEN in the mesh handshake and checked against the
 * signed members map, unlike the self-asserted awareness states the y-webrtc
 * rooms used to provide. Leaf module on purpose: readers must not pull the
 * WebRTC stack into their chunk just to show a peer count.
 */

const peersByDapp = new Map<string, string[]>();
/** One shared instance so snapshot readers (useSyncExternalStore) see a stable value. */
const NO_PEERS: string[] = [];
const listeners = new Map<string, Set<() => void>>();

/** Distinct verified member keys with a live, ready mesh session (this device excluded). */
export function getMeshPeerKeys(dappId: string): string[] {
  return peersByDapp.get(dappId) ?? NO_PEERS;
}

/** Called by the mesh whenever its set of ready sessions changes. */
export function publishMeshPeerKeys(dappId: string, publicKeys: string[]): void {
  const next = [...new Set(publicKeys)].sort();
  const previous = peersByDapp.get(dappId) ?? NO_PEERS;
  if (previous.length === next.length && previous.every((key, index) => key === next[index])) return;
  if (next.length === 0) peersByDapp.delete(dappId);
  else peersByDapp.set(dappId, next);
  listeners.get(dappId)?.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('mesh presence listener failed', error);
    }
  });
}

export function subscribeMeshPeers(dappId: string, listener: () => void): () => void {
  let set = listeners.get(dappId);
  if (!set) {
    set = new Set();
    listeners.set(dappId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(dappId) === set) listeners.delete(dappId);
  };
}
