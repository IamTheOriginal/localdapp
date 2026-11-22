/**
 * Credential grants a joining device holds until its user has confirmed WHO approved it.
 *
 * Why: an invite lobby is open to everyone holding the invite link. Such a device can
 * announce itself as an "owner" with a key of its own (its announce verifies — it really
 * holds that key) and sign a grant into a room it controls. The joiner could not tell that
 * "evil twin" from a real owner, and it used to take the first valid grant and leave the
 * lobby at once, so the owner-side code comparison never got a chance. Now a grant is only
 * used after the person joining has seen "approved by X — code N" and confirmed that the
 * approving device shows the same code for this device. The twin has a different key, so
 * its code is not the one on the real owner's screen.
 *
 * A headless device has nobody to ask: it registers `setAccessGrantAutoConfirm` and decides
 * by the approving key (the keeper accepts its operators; everything else waits for an
 * explicit confirmation through its control surface).
 *
 * Leaf module: state, listeners and the policy hook. docs.ts does the lobby work.
 */

export interface PendingAccessGrant {
  dappId: string;
  /** Device key that signed the grant (and proved that key in the lobby). */
  approvedBy: string;
  /** Self-chosen name of that device — shown for orientation only, it proves nothing. */
  approverName: string;
  /** Connection code between this device and the approving one; the approver shows the same. */
  code: string;
  /**
   * The approver says it admitted this device through a 1-step invite, so no person on its
   * side saw the code. Unsigned and only informative: an impostor simply leaves it out.
   */
  automatic?: boolean;
}

interface HeldGrant extends PendingAccessGrant {
  accept: () => void;
  discard: () => void;
}

const held = new Map<string, HeldGrant>();
/** dappId → approving keys the person refused; their grants are ignored for the rest of the session. */
const refused = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
let autoConfirm: ((dappId: string, approvedBy: string) => boolean) | null = null;

function notify(): void {
  listeners.forEach((listener) => {
    try { listener(); } catch (error) { console.error('pending grant listener failed', error); }
  });
}

export function onPendingAccessGrantsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getPendingAccessGrant(dappId: string): PendingAccessGrant | null {
  const grant = held.get(dappId);
  return grant ? { dappId, approvedBy: grant.approvedBy, approverName: grant.approverName, code: grant.code, ...(grant.automatic ? { automatic: true } : {}) } : null;
}

export function listPendingAccessGrants(): PendingAccessGrant[] {
  return [...held.keys()].map((dappId) => getPendingAccessGrant(dappId)).filter((grant): grant is PendingAccessGrant => grant !== null);
}

/** Policy for devices without a person in front of them; null = always ask. */
export function setAccessGrantAutoConfirm(decide: ((dappId: string, approvedBy: string) => boolean) | null): void {
  autoConfirm = decide;
}

export function isGranterRefused(dappId: string, approvedBy: string): boolean {
  return refused.get(dappId)?.has(approvedBy) ?? false;
}

/**
 * Called by the lobby code with a grant that is signed by a device that proved an owner
 * key in the lobby. Uses it at once when the policy says so, otherwise holds it.
 */
export function offerAccessGrant(grant: HeldGrant): void {
  if (isGranterRefused(grant.dappId, grant.approvedBy)) return;
  if (autoConfirm?.(grant.dappId, grant.approvedBy)) {
    held.delete(grant.dappId);
    grant.accept();
    notify();
    return;
  }
  const current = held.get(grant.dappId);
  if (current && current.approvedBy === grant.approvedBy && current.code === grant.code) return;
  held.set(grant.dappId, grant);
  notify();
}

/** The person confirmed that the approving device shows the same code. */
export function confirmPendingAccessGrant(dappId: string): boolean {
  const grant = held.get(dappId);
  if (!grant) return false;
  held.delete(dappId);
  grant.accept();
  notify();
  return true;
}

/** The codes differ (or the approver is unknown): ignore this device's grants and keep waiting. */
export function refusePendingAccessGrant(dappId: string): boolean {
  const grant = held.get(dappId);
  if (!grant) return false;
  held.delete(dappId);
  let keys = refused.get(dappId);
  if (!keys) {
    keys = new Set();
    refused.set(dappId, keys);
  }
  keys.add(grant.approvedBy);
  grant.discard();
  notify();
  return true;
}

/** The dapp is gone from this device (left, deleted, join cancelled). */
export function forgetAccessGrants(dappId: string): void {
  refused.delete(dappId);
  if (held.delete(dappId)) notify();
}
