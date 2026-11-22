import { signWithIdentity, verifySignature, type SigningIdentity } from './protocolCore.ts';

/**
 * Signed lobby announces.
 *
 * An invite lobby is a y-webrtc room: whoever holds the invite link can write any
 * awareness state, including somebody else's `publicKey` next to its OWN
 * `encPublicKey`. The connection code only covers the Ed25519 key, so an owner
 * comparing codes with the real person would have signed the attacker's RSA key
 * into that person's member entry — the attacker gets the room credentials, the
 * real device is locked out (even a later rejoin goes to the stored, wrong key).
 * The keeper's automatic operator admission had the same hole without any person
 * in the loop.
 *
 * So every announce carries an Ed25519 signature by `publicKey` over what it
 * claims, bound to the lobby it was made for. Nothing is listed, approved or
 * auto-admitted before that signature verified. A replayed announce is harmless:
 * it names the victim's real encryption key.
 */

export interface LobbyAnnounceClaim {
  publicKey: string;
  encPublicKey: string;
  isOwner: boolean;
  /** Present on hosts: the invite whose lobby they hold open. */
  inviteId?: string;
}

function announcePayload(lobbyId: string, claim: LobbyAnnounceClaim): Record<string, unknown> {
  return {
    purpose: 'lobby-announce-v1',
    lobbyId,
    publicKey: claim.publicKey,
    encPublicKey: claim.encPublicKey,
    isOwner: claim.isOwner,
    inviteId: claim.inviteId ?? '',
  };
}

/** Signature (hex) a device puts into its awareness state as `announceSig`. */
export async function signLobbyAnnounce(lobbyId: string, claim: LobbyAnnounceClaim, identity: SigningIdentity): Promise<string> {
  if (identity.publicKey !== claim.publicKey) throw new Error('lobby: an announce can only be signed by the key it names');
  return (await signWithIdentity(identity, announcePayload(lobbyId, claim)))._signature;
}

function claimOf(state: unknown): (LobbyAnnounceClaim & { announceSig: string }) | null {
  const peer = (state ?? {}) as Record<string, unknown>;
  if (typeof peer.publicKey !== 'string' || !/^[0-9a-f]{64}$/i.test(peer.publicKey)) return null;
  if (typeof peer.encPublicKey !== 'string' || !peer.encPublicKey || peer.encPublicKey.length > 4096) return null;
  if (typeof peer.announceSig !== 'string' || !/^[0-9a-f]{128}$/i.test(peer.announceSig)) return null;
  if (peer.inviteId !== undefined && typeof peer.inviteId !== 'string') return null;
  return {
    publicKey: peer.publicKey,
    encPublicKey: peer.encPublicKey,
    isOwner: peer.isOwner === true,
    ...(typeof peer.inviteId === 'string' ? { inviteId: peer.inviteId } : {}),
    announceSig: peer.announceSig,
  };
}

// Awareness states are re-read on every change; verify each distinct announce once.
const verdicts = new Map<string, boolean>();
const pending = new Map<string, Promise<boolean>>();
const listeners = new Set<() => void>();
const MAX_VERDICTS = 2_000;

function verdictKey(lobbyId: string, claim: LobbyAnnounceClaim & { announceSig: string }): string {
  return [lobbyId, claim.publicKey, claim.encPublicKey, claim.isOwner ? '1' : '0', claim.inviteId ?? '', claim.announceSig].join('|');
}

/** Whether `state` is an announce whose signature proves possession of the key it names. */
export function verifyLobbyAnnounce(lobbyId: string, state: unknown): Promise<boolean> {
  const claim = claimOf(state);
  if (!claim || !lobbyId) return Promise.resolve(false);
  const key = verdictKey(lobbyId, claim);
  const known = verdicts.get(key);
  if (known !== undefined) return Promise.resolve(known);
  let running = pending.get(key);
  if (!running) {
    running = verifySignature({ ...announcePayload(lobbyId, claim), _signature: claim.announceSig }, claim.publicKey)
      .catch(() => false)
      .then((valid) => {
        pending.delete(key);
        if (verdicts.size >= MAX_VERDICTS) verdicts.clear();
        verdicts.set(key, valid);
        listeners.forEach((listener) => {
          try { listener(); } catch (error) { console.error('lobby-announce listener failed', error); }
        });
        return valid;
      });
    pending.set(key, running);
  }
  return running;
}

/**
 * Synchronous view for render paths: true / false once verified, undefined while
 * the check is still running (it is started here; `onLobbyAnnounceVerdict` fires
 * when it settles). Treat undefined like false.
 */
export function lobbyAnnounceVerdict(lobbyId: string, state: unknown): boolean | undefined {
  const claim = claimOf(state);
  if (!claim || !lobbyId) return false;
  const known = verdicts.get(verdictKey(lobbyId, claim));
  if (known === undefined) void verifyLobbyAnnounce(lobbyId, state);
  return known;
}

export function onLobbyAnnounceVerdict(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The states of a lobby whose announce verified — everything else is noise anyone with the link can write. */
export async function verifiedLobbyStates(lobbyId: string, states: Iterable<unknown>): Promise<unknown[]> {
  const all = [...states];
  const checks = await Promise.all(all.map((state) => verifyLobbyAnnounce(lobbyId, state)));
  return all.filter((_state, index) => checks[index]);
}
