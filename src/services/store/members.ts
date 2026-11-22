import type * as Y from 'yjs';
import { getDappDoc } from './docs.ts';
import { getFounder, requireRole } from './auth.ts';
import { getIdentity, getSigningIdentity } from '../identity.ts';
import {
  FOUNDER_PLACEHOLDER_NAME,
  writeSignedMember,
  writeSignedMemberRemoval,
  type MemberWriteInput,
} from './protocolCore.ts';
import { rotateDappCredentials, type RotationResult } from './rotation.ts';
import { AUTO_ROTATE_ON_MEMBER_REMOVAL } from './rotationPolicy.ts';

export async function setMember(dappId: string, input: MemberWriteInput): Promise<void> {
  requireRole(dappId, 'owner');
  const identity = getIdentity();
  if (!identity) throw new Error('auth: No identity to sign with');

  await writeSignedMember(getDappDoc(dappId), input, await getSigningIdentity());
}

/**
 * Founder entries used to be created with the placeholder name "Owner", so
 * every member list showed an anonymous "Owner" for the device that created
 * the dapp. Only the founder's own device knows its real name: when it opens
 * the dapp it re-signs its entry with that name (role and stored encryption
 * key unchanged). No-op for everyone else and for founders already named.
 * Returns true when the entry was renamed.
 */
export async function healFounderName(dappId: string, doc: Y.Doc = getDappDoc(dappId)): Promise<boolean> {
  const identity = getIdentity();
  const name = identity?.displayName?.trim();
  if (!identity || !name || name === FOUNDER_PLACEHOLDER_NAME) return false;
  if (getFounder(dappId, doc) !== identity.publicKey) return false;
  const entry = doc.getMap('members').get(identity.publicKey) as Y.Map<unknown> | undefined;
  if (!entry || entry.get('role') !== 'owner' || entry.get('name') !== FOUNDER_PLACEHOLDER_NAME) return false;
  await writeSignedMember(doc, { publicKey: identity.publicKey, name, role: 'owner' }, await getSigningIdentity());
  return true;
}

/**
 * Remove the current device's own membership ("leave dapp") with a
 * self-signed tombstone — the one removal honest peers accept from a
 * non-owner. The founding owner cannot leave (they delete instead); their
 * device auto-rotates credentials when it observes the departure (auth.ts).
 * Purely a protocol write: disconnecting and archiving are the caller's job
 * (see dappLeaveRuntime.ts).
 */
export async function leaveDappMembership(dappId: string, doc: Y.Doc = getDappDoc(dappId)): Promise<void> {
  const identity = getIdentity();
  if (!identity) throw new Error('auth: No identity to sign with');

  const foundingOwner = getFounder(dappId, doc);
  if (identity.publicKey === foundingOwner) {
    throw new Error('auth: The founding owner cannot leave — delete the dapp instead');
  }
  if (!doc.getMap('members').has(identity.publicKey)) {
    throw new Error('auth: Not a member of this dapp');
  }

  await writeSignedMemberRemoval(doc, identity.publicKey, await getSigningIdentity(), foundingOwner);
}

/**
 * Remove a member (owner only). When rotation is on (`rotateCredentials`,
 * defaulting to the rotationPolicy.ts switch — currently off), the room
 * credentials are rotated afterwards so the removed member's cached password
 * stops granting read access; rotation failure is reported but does not undo
 * the removal. Returns the rotation result, or null when rotation was off or failed.
 */
export async function removeMember(
  dappId: string,
  publicKey: string,
  options: { rotateCredentials?: boolean } = {},
): Promise<RotationResult | null> {
  requireRole(dappId, 'owner');

  const doc = getDappDoc(dappId);
  const identity = getIdentity();
  if (!identity) throw new Error('auth: No identity to sign with');

  await writeSignedMemberRemoval(doc, publicKey, await getSigningIdentity(), getFounder(dappId, doc));

  // The removed member knows the lobby secret of every open invite — with a 1-step invite
  // it could walk straight back in under a fresh key. Close them all; the owner creates new
  // ones for whoever still needs to join. (Dynamic import: invites.ts imports this module.)
  try {
    const { closeInvites } = await import('./invites.ts');
    await closeInvites(dappId);
  } catch (error) {
    console.warn('invites: closing the open invites after a member removal failed — delete them by hand', error);
  }

  if (!(options.rotateCredentials ?? AUTO_ROTATE_ON_MEMBER_REMOVAL)) return null;
  try {
    return await rotateDappCredentials(dappId, { exclude: [publicKey], doc });
  } catch (error) {
    console.warn('rotation: credential rotation after member removal failed — removed member may retain read access', error);
    return null;
  }
}
