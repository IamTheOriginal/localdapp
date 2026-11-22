/**
 * Whether room credentials rotate automatically when a member is removed or
 * leaves. SWITCHED OFF (2026-09): a member who is offline during a rotation
 * never receives its rekey entry — everyone else has moved on, so nobody is
 * left in the old room to hand it over — and the dapp splits into devices on
 * the old room and devices on the new one, which only re-invites repair.
 *
 * While off, a removed member keeps the room password — which no longer gives it
 * anything: dapp documents travel only over the member mesh, whose handshake is
 * the whitelist, so every honest device refuses the removed key and drops its
 * open session as soon as the removal has synced (docs/security/THREAT_MODEL.md).
 * What the password still exposes is signaling metadata (that devices of this
 * dapp are online). Rotation itself stays intact:
 * `rotateDappCredentials` can be called explicitly, and every device keeps
 * following rekey entries from rotations that already happened.
 *
 * Leaf module on purpose — auth.ts, members.ts and the UI all read it, and
 * rotation.ts sits in an import cycle with auth.ts and docs.ts.
 */
export const AUTO_ROTATE_ON_MEMBER_REMOVAL: boolean = false;
