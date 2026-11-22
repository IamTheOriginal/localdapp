import * as Y from 'yjs';
import { recordAutomaticAdmission } from './automaticAdmissions.ts';
import {
  getDappDoc,
  getDappCredentials,
  getInviteDoc,
  generateRoomPassword,
  inviteDocs,
  inviteProviders,
} from './docs.ts';
import { requireRole, getRole, getVerifiedInvite, getVerifiedMember } from './auth.ts';
import { getIdentity, getSigningIdentity, encryptMessage } from '../identity.ts';
import { mapToObject, signedInviteView, writeSignedInvite, writeSignedInviteTombstone } from './protocolCore.ts';
import { setMember } from './members.ts';
import { formatAccessGrant } from './accessGrant.ts';
import { classifyLobbyPeer } from './lobbyPeers.ts';
import { verifiedLobbyStates } from './lobbyAnnounce.ts';
import { signAccessGrant } from './accessGrant.ts';
import { APP_INVITE_URI_PREFIX } from '../inviteLinks.ts';
import type { MemberRole } from '../../types.ts';

// ───── Invite Operations ─────

interface CreateInviteOptions {
  /**
   * 1-step invite: any device that shows up in the lobby with the invite
   * secret is approved automatically by the first online owner device — no
   * safety-number verification. Possession of the link IS the admission
   * check; see docs/security/THREAT_MODEL.md before loosening further.
   */
  autoApprove?: boolean;
  /** Role granted on auto-approval. Defaults to 'editor'. Never 'owner'. */
  autoRole?: 'editor' | 'viewer';
}

export async function createInvite(dappId: string, uses: number = 1, options: CreateInviteOptions = {}): Promise<string> {
  requireRole(dappId, 'owner');
  const doc = getDappDoc(dappId);

  const lobbyId = `dapp-lobby-${crypto.randomUUID()}`;
  const lobbyPassword = generateRoomPassword();
  // Owner-signed (protocolCore.ts "Invites"): peers only act on verified invites.
  await writeSignedInvite(doc, {
    id: crypto.randomUUID(),
    lobbyId,
    lobbyPassword,
    uses: Math.max(1, Math.floor(uses)),
    createdAt: new Date().toISOString(),
    ...(options.autoApprove ? { autoApprove: 'true' as const, autoRole: options.autoRole === 'viewer' ? 'viewer' as const : 'editor' as const } : {}),
  }, await getSigningIdentity());

  return appInviteUri(lobbyId, lobbyPassword);
}

/** The one app-join invite format — every producer must build URIs through this. */
export function appInviteUri(lobbyId: string, lobbyPassword: string): string {
  return `${APP_INVITE_URI_PREFIX}${lobbyId}/${lobbyPassword}`;
}

/** Admissions that count against an invite: members whose owner-signed entry names it. */
function admissionsThrough(doc: Y.Doc, inviteId: string): number {
  let count = 0;
  doc.getMap('members').forEach((raw) => {
    if ((raw as Y.Map<unknown>).get('viaInvite') === inviteId) count += 1;
  });
  return count;
}

/**
 * The invite an approval may act on: the VERIFIED one (auth.ts) once this
 * session scanned invites, otherwise — a dapp created moments ago, isolated
 * tests — the entry in the doc. Null when the invite is unknown, was closed, or
 * its signed `uses` are exhausted.
 */
function usableInvite(dappId: string, inviteId: string): Record<string, unknown> | null {
  const doc = getDappDoc(dappId);
  const verified = getVerifiedInvite(dappId, inviteId);
  const raw = doc.getMap('invites').get(inviteId) as Y.Map<unknown> | undefined;
  const invite = verified !== undefined ? verified : raw ? signedInviteView(mapToObject(raw)) : null;
  if (!invite || !raw || doc.getMap('inviteTombstones').has(inviteId)) return null;
  const uses = typeof invite.uses === 'number' ? invite.uses : 1;
  return admissionsThrough(doc, inviteId) < uses ? invite : null;
}

/** Bookkeeping after an admission or re-grant; closes the invite (signed tombstone) once it is used up. */
async function incrementInviteUse(dappId: string, inviteId: string): Promise<void> {
  requireRole(dappId, 'owner');
  const doc = getDappDoc(dappId);
  const inviteInfo = doc.getMap('invites').get(inviteId) as Y.Map<unknown> | undefined;
  if (!inviteInfo) return;

  const usesLeft = inviteInfo.get('usesLeft');
  const remaining = typeof usesLeft === 'number' ? usesLeft - 1 : 0;
  const uses = inviteInfo.get('uses');
  const exhausted = remaining <= 0 || (typeof uses === 'number' && admissionsThrough(doc, inviteId) >= uses);
  if (exhausted) await writeSignedInviteTombstone(doc, inviteId, await getSigningIdentity());
  else inviteInfo.set('usesLeft', remaining);
}

export async function deleteInvite(dappId: string, inviteId: string): Promise<void> {
  requireRole(dappId, 'owner');
  // A signed tombstone, not a bare delete: the entry is validly signed, so without it
  // any member could simply put the invite back.
  await writeSignedInviteTombstone(getDappDoc(dappId), inviteId, await getSigningIdentity());

  // Also destroy the invite's WebRTC provider and doc
  try { inviteProviders.get(inviteId)?.destroy(); } catch { /* already torn down */ }
  inviteProviders.delete(inviteId);
  inviteDocs.get(inviteId)?.destroy();
  inviteDocs.delete(inviteId);
}

/**
 * Close every open invite (optionally only those created up to a moment). Used
 * when a member is removed or leaves: it knows the lobby secrets of all invites
 * that existed then, and could otherwise walk back in through a 1-step invite.
 * Returns how many were closed. No-op for non-owners.
 */
export async function closeInvites(dappId: string, options: { createdBefore?: number } = {}): Promise<number> {
  const identity = getIdentity();
  if (!identity || getRole(dappId, identity.publicKey) !== 'owner') return 0;
  const doc = getDappDoc(dappId);
  const ids: string[] = [];
  doc.getMap('invites').forEach((raw, inviteId) => {
    const created = (raw as Y.Map<unknown>).get('createdAt');
    const createdAt = typeof created === 'string' ? Date.parse(created) : Number.NaN;
    if (options.createdBefore === undefined || !Number.isFinite(createdAt) || createdAt <= options.createdBefore) ids.push(inviteId);
  });
  for (const inviteId of ids) await deleteInvite(dappId, inviteId);
  return ids.length;
}

// ───── Lobby approval (shared by settings page, Requests inbox, auto-approve) ─────

/** The lobby room of an invite: from the verified invite, else (no scan yet) the doc entry. */
export function inviteLobbyId(dappId: string, inviteId: string): string {
  const verified = getVerifiedInvite(dappId, inviteId);
  const raw = getDappDoc(dappId).getMap('invites').get(inviteId) as Y.Map<unknown> | undefined;
  const lobbyId = verified ? verified.lobbyId : raw?.get('lobbyId');
  return typeof lobbyId === 'string' ? lobbyId : '';
}

interface LobbyDevice {
  publicKey: string;
  displayName?: string;
  encPublicKey?: string;
  /** The invite lobby the device is waiting in — every joiner arrives through one. */
  inviteId: string;
}

/**
 * Owner-side approval of a device waiting in a lobby: signs it into the
 * members map (owner-signed add — the auth observer on every peer expects
 * this), then hands it the *current* room credentials encrypted to its
 * RSA-OAEP key via the lobby doc's grantedAccess map.
 *
 * Rejoin: a device that already IS a member (it lost its copy of the dapp) is
 * not signed in again — its entry, role and name stay untouched, which also
 * covers the founding owner that nobody else could re-sign. It only gets the
 * credentials again, encrypted to the encryption key stored in its member
 * entry. The key announced in the lobby is ignored: anyone holding the invite
 * link can claim a member's public key there, and must not be able to read the
 * grant. See lobbyPeers.ts.
 */
export async function approveLobbyDevice(dappId: string, peer: LobbyDevice, role: MemberRole = 'editor', options: { automatic?: boolean } = {}): Promise<void> {
  // Admission only happens through an invite this device verified (owner-signed, not
  // closed, signed `uses` not exhausted) — never through whatever entry a member wrote.
  if (!usableInvite(dappId, peer.inviteId)) {
    throw new Error('This invite is not valid any more (closed, used up, or not signed by an owner). Create a new one.');
  }

  // The members map decides whether this is a rejoin — never a caller-supplied flag. The
  // stored key comes from the VERIFIED entry when there is one: a key swapped into the
  // doc a moment ago must not receive the credentials.
  const existing = getDappDoc(dappId).getMap('members').get(peer.publicKey) as Y.Map<unknown> | undefined;
  const verifiedEntry = getVerifiedMember(dappId, peer.publicKey);
  const storedKey = verifiedEntry ? verifiedEntry.encPublicKey : existing?.get('encPublicKey');
  const grantKey = existing ? (typeof storedKey === 'string' ? storedKey : '') : peer.encPublicKey;
  if (!grantKey) {
    throw new Error(existing
      ? 'This member has no stored encryption key, so it cannot be let back in safely. Remove it and invite it again.'
      : 'Peer did not provide an encryption key. Cannot securely share the room password.');
  }

  // Resolve the lobby doc BEFORE touching the members map: failing here must
  // not leave a half-approved member who never receives credentials.
  const lobbyGrantDoc = getInviteDoc(peer.inviteId);
  const lobbyProvider = inviteProviders.get(peer.inviteId);
  const lobbyId = inviteLobbyId(dappId, peer.inviteId);
  if (!lobbyGrantDoc || !lobbyProvider || !lobbyId) throw new Error('The invite lobby is not open on this device.');

  // Proof of possession (lobbyAnnounce.ts): the device must be in the lobby RIGHT NOW with a
  // signed announce for exactly this key pair. Everything a caller passes in — the inbox row,
  // the keeper's operator auto-admission — started as a self-asserted awareness state.
  // A returning member proves its device key only: its grant goes to the STORED encryption
  // key whatever it announces — but without the proof anyone holding the link could make an
  // owner burn invite uses on grants nobody asked for.
  const proven = (await verifiedLobbyStates(lobbyId, lobbyProvider.awareness.getStates().values())).some((state) => {
    const announced = state as { publicKey?: unknown; encPublicKey?: unknown };
    return announced.publicKey === peer.publicKey && (existing !== undefined || announced.encPublicKey === grantKey);
  });
  if (!proven) throw new Error('This device did not prove that it owns the key it announced (or it left the lobby). Ask it to open the invite again.');

  if (existing) {
    requireRole(dappId, 'owner'); // setMember enforces this on the newcomer path
  } else {
    await setMember(dappId, {
      name: peer.displayName || 'Unknown',
      role,
      publicKey: peer.publicKey,
      encPublicKey: grantKey,
      viaInvite: peer.inviteId,
    });
  }

  // Read live from the catalog — rotation may have replaced older credentials.
  const { roomId, roomPassword, epoch } = getDappCredentials(dappId);
  // The grant names this device as the approver: with several owner devices in
  // one lobby the joiner cannot otherwise tell whose key to pin as its trust anchor.
  const grant = formatAccessGrant({ roomId, roomPassword, epoch, grantedBy: getIdentity()?.publicKey });
  const encrypted = await encryptMessage(grantKey, grant);
  // Signed over lobby + joiner + ciphertext: the joiner accepts no grant without it (accessGrant.ts).
  const grantSignature = await signAccessGrant({ lobbyId, joinerKey: peer.publicKey, ciphertext: encrypted }, await getSigningIdentity());

  // `automatic` sits beside the signature, outside what it covers: it only tells an honest
  // joiner that no person saw its code (a twin can leave it out, as it can lie about anything
  // else it writes), and older joiners ignore the extra field.
  const signatureEntry = options.automatic ? { ...grantSignature, automatic: true } : grantSignature;
  lobbyGrantDoc.transact(() => {
    lobbyGrantDoc.getMap('grantSignatures').set(peer.publicKey, signatureEntry);
    lobbyGrantDoc.getMap('grantedAccess').set(peer.publicKey, encrypted);
  });
  await incrementInviteUse(dappId, peer.inviteId);
}

const autoApproveInFlight = new Set<string>();

/**
 * 1-step invites: approve every eligible device currently waiting in the
 * invite's lobby. No-op unless this device is an owner of the dapp and the
 * invite is flagged `autoApprove`. docs.ts calls this on every awareness
 * change of an invite lobby, so any online owner device (including the
 * headless keeper) admits joiners without user interaction.
 */
export async function autoApproveLobbyPeers(dappId: string, inviteId: string): Promise<void> {
  const identity = getIdentity();
  if (!identity) return;
  if (getRole(dappId, identity.publicKey) !== 'owner') return;

  const doc = getDappDoc(dappId);
  // The SIGNED fields of a verified invite decide — `autoApprove` in the raw entry is
  // exactly what a member would flip to get a device admitted without a person.
  const invite = usableInvite(dappId, inviteId);
  if (!invite || invite.autoApprove !== 'true') return;
  const role: MemberRole = invite.autoRole === 'viewer' ? 'viewer' : 'editor';

  const provider = inviteProviders.get(inviteId);
  const inviteDoc = inviteDocs.get(inviteId);
  if (!provider || !inviteDoc) return;

  const members = doc.getMap('members');
  const granted = inviteDoc.getMap('grantedAccess');

  const waiting: LobbyDevice[] = [];
  const lobbyId = typeof invite.lobbyId === 'string' ? invite.lobbyId : '';
  (await verifiedLobbyStates(lobbyId, provider.awareness.getStates().values())).forEach((state) => {
    const peer = classifyLobbyPeer(state, identity.publicKey, members);
    // Rejoins are never automatic: letting a member back in stays a person's decision.
    if (!peer || peer.rejoin || !peer.encPublicKey || granted.has(peer.publicKey)) return;
    waiting.push({ publicKey: peer.publicKey, displayName: peer.displayName, encPublicKey: peer.encPublicKey, inviteId });
  });

  for (const peer of waiting) {
    const flightKey = `${dappId}:${peer.publicKey}`;
    if (autoApproveInFlight.has(flightKey)) continue;
    if (!usableInvite(dappId, inviteId)) break; // used up or closed in the meantime
    autoApproveInFlight.add(flightKey);
    try {
      await approveLobbyDevice(dappId, peer, role, { automatic: true });
      void recordAutomaticAdmission({ dappId, inviteId, publicKey: peer.publicKey, displayName: peer.displayName ?? '', ownerKey: identity.publicKey, lobbyId })
        .catch((error: unknown) => console.error('could not record the automatic admission', error));
    } catch (error) {
      console.error(`auto-approve failed for lobby peer ${peer.publicKey}`, error);
    } finally {
      autoApproveInFlight.delete(flightKey);
    }
  }
}
