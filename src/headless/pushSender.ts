/**
 * Keeper as secondary push sender (docs/plans/2026-08-31-push-notifications.md).
 *
 * The keeper re-fires content-free share tickles for outbound share offers
 * that are still pending in its own root catalog — covering the window where
 * the originator's interactive devices went offline before the recipient was
 * woken. It reuses the browser modules under the headless shims: the pairwise
 * control room opens from the stored control capability, the contact's push
 * address is verify-on-read (store/pushInboxes.ts), and the tickle is signed
 * with the relationship identity (services/pushNotifications.ts) — identical
 * invariants to a browser sender.
 *
 * Reach today: the root catalog is local-only by design (it never syncs from
 * the user's devices), so this fires only for relationships and pending
 * shares that live in the keeper's own root doc — i.e. shares the keeper
 * itself originated, or state from a future keeper-enrollment flow. With no
 * relationship state present it is a no-op.
 *
 * Node-only; never import from browser code.
 */

import { getRootDoc } from '../services/store/docs.ts';
import { getRelationshipControlCapability, listRelationships } from '../services/store/relationships.ts';
import { listAllChannelShares } from '../services/store/channelShares.ts';
import {
  createBrowserRelationshipPairingRoomManager,
  type RelationshipPairingRoomManager,
} from '../services/relationshipPairingRoomManager.ts';
import { sendShareTickle } from '../services/pushNotifications.ts';

interface KeeperTickleSweepResult {
  /** Relationships with a pending outbound share whose control room was reachable. */
  relationshipsTickled: number;
}

let sharedRooms: RelationshipPairingRoomManager | null = null;

function rooms(): RelationshipPairingRoomManager {
  // The "browser" room manager runs on the headless shims (fake-indexeddb +
  // injected WebRTC), exactly like the rest of the reused store stack.
  sharedRooms = sharedRooms ?? createBrowserRelationshipPairingRoomManager();
  return sharedRooms;
}

/**
 * One sweep pass: for every active relationship that still has a pending
 * outbound channel share, open the pair's control room and re-send the signed
 * tickle to the contact's registered inboxes. Best-effort per relationship —
 * one unreachable room never stops the sweep.
 */
export async function sendPendingShareTickles(): Promise<KeeperTickleSweepResult> {
  const rootDoc = getRootDoc();
  const pendingRelationships = new Set(
    listAllChannelShares(rootDoc)
      .filter((share) => share.status === 'pending')
      .map((share) => share.relationshipId),
  );
  let relationshipsTickled = 0;
  if (pendingRelationships.size === 0) return { relationshipsTickled };

  for (const relationship of listRelationships(rootDoc)) {
    if (relationship.status !== 'active' || !pendingRelationships.has(relationship.id)) continue;
    const capability = getRelationshipControlCapability(relationship.id, rootDoc);
    if (!capability) continue;
    try {
      const room = rooms().openControl(capability, relationship.localIdentity.publicKey);
      rooms().connect(room.descriptor.id);
      await room.persistenceReady;
      await sendShareTickle(relationship, room.doc);
      relationshipsTickled += 1;
    } catch (error) {
      console.error(`push tickle failed for relationship ${relationship.id}`, error);
    }
  }
  return { relationshipsTickled };
}
