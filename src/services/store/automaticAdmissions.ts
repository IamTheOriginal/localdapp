import { deriveConnectionCode } from '../connectionCode.ts';

/**
 * Devices this owner device admitted through a 1-step invite, with the connection
 * code it shares with each of them.
 *
 * With a 1-step invite nobody approves by hand, so no person on the owner side ever
 * saw the joiner's code — the joiner's "check who let you in" step had nothing to
 * compare against. The invites panel lists these so the joiner can ask an owner to
 * read the code off this list. Session-only on purpose: it is a check for right
 * now, not a history, and it is never synced.
 */
export interface AutomaticAdmission {
  dappId: string;
  inviteId: string;
  publicKey: string;
  displayName: string;
  code: string;
  at: number;
}

const MAX_PER_DAPP = 20;
const admissions = new Map<string, AutomaticAdmission[]>();
const NONE: AutomaticAdmission[] = [];
const listeners = new Set<() => void>();

export async function recordAutomaticAdmission(entry: Omit<AutomaticAdmission, 'code' | 'at'> & { ownerKey: string; lobbyId: string }): Promise<void> {
  const code = await deriveConnectionCode(entry.ownerKey, entry.publicKey, entry.lobbyId);
  const next: AutomaticAdmission = { dappId: entry.dappId, inviteId: entry.inviteId, publicKey: entry.publicKey, displayName: entry.displayName, code, at: Date.now() };
  const list = (admissions.get(entry.dappId) ?? []).filter((row) => row.publicKey !== entry.publicKey);
  admissions.set(entry.dappId, [next, ...list].slice(0, MAX_PER_DAPP));
  listeners.forEach((listener) => {
    try { listener(); } catch (error) { console.error('automatic admissions listener failed', error); }
  });
}

/** Newest first; a stable empty array when there are none. */
export function getAutomaticAdmissions(dappId: string): AutomaticAdmission[] {
  return admissions.get(dappId) ?? NONE;
}

export function subscribeAutomaticAdmissions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
