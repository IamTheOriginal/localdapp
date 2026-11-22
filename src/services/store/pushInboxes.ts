import type * as Y from 'yjs';
import type { CanonicalJson, HybridEncryptedEnvelope, Relationship } from '../../types.ts';
import { hybridDecrypt, hybridEncrypt, signRelationshipControl, verifyRelationshipControl } from '../relationshipProtocol.ts';

// ───── Push inbox distribution (docs/plans/2026-08-31-push-notifications.md) ─────
//
// Each device tells each contact where a content-free push tickle can reach
// it: an opaque relay inbox id (random, never derived from anything) plus the
// relay URL it registered at. The entry travels in the pair's shared control
// doc, mirroring the rekeys pattern from store/rotation.ts: signed by the
// sender's pinned relationship key, payload encrypted to the recipient's
// relationship encryption key, verify-on-read — a forged, replaced, or
// misattributed entry is inert on honest peers. The relay never appears in
// any synced dapp doc, and the local people/relationship catalog stays
// unattached to any provider.

interface PushInboxEntry {
  protocol: 'push-inbox';
  schemaVersion: 1;
  /** Sender relationship signing key (also the map key). */
  from: string;
  /** Recipient relationship signing key. */
  to: string;
  updatedAt: string;
  encryptedPayload: HybridEncryptedEnvelope;
  signature: string;
}

interface PushInboxAddress {
  /** Relay base URL the sender registered at (https, no trailing slash). */
  relayUrl: string;
  /** Opaque relay inbox ids for the sender's device(s); empty = push disabled. */
  inboxes: string[];
}

const MAX_INBOXES_PER_ENTRY = 8;
const INBOX_ID = /^[0-9a-f]{32}$/;

export function pushInboxEntries(controlDoc: Y.Doc): Y.Map<PushInboxEntry> {
  return controlDoc.getMap<PushInboxEntry>('pushInboxEntries');
}

function routing(entry: Pick<PushInboxEntry, 'protocol' | 'schemaVersion' | 'from' | 'to' | 'updatedAt'>): CanonicalJson {
  return {
    protocol: entry.protocol,
    schemaVersion: entry.schemaVersion,
    from: entry.from,
    to: entry.to,
    updatedAt: entry.updatedAt,
  };
}

function requirePinned(relationship: Relationship): asserts relationship is Relationship & {
  peerPublicKey: string; peerEncPublicKey: string;
} {
  if (relationship.status !== 'active' || !relationship.peerPublicKey || !relationship.peerEncPublicKey) {
    throw new Error('push inboxes: Active relationship with pinned keys required');
  }
}

function isValidAddress(value: unknown): value is PushInboxAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<PushInboxAddress>;
  return typeof candidate.relayUrl === 'string'
    && /^https:\/\/[^\s]+[^/\s]$/.test(candidate.relayUrl)
    && candidate.relayUrl.length < 256
    && Array.isArray(candidate.inboxes)
    && candidate.inboxes.length <= MAX_INBOXES_PER_ENTRY
    && candidate.inboxes.every((inbox) => typeof inbox === 'string' && INBOX_ID.test(inbox));
}

/**
 * Publishes (or replaces) this device's push address for one contact.
 * An empty `inboxes` array announces "push disabled" and is the way to retract.
 */
export async function writePushInboxEntry(options: {
  relationship: Relationship;
  controlDoc: Y.Doc;
  relayUrl: string;
  inboxes: string[];
  now?: Date;
}): Promise<PushInboxEntry> {
  const { relationship, controlDoc } = options;
  requirePinned(relationship);
  const address: PushInboxAddress = { relayUrl: options.relayUrl, inboxes: options.inboxes };
  if (!isValidAddress(address)) throw new Error('push inboxes: Invalid relay URL or inbox list');
  const base = {
    protocol: 'push-inbox' as const,
    schemaVersion: 1 as const,
    from: relationship.localIdentity.publicKey,
    to: relationship.peerPublicKey,
    updatedAt: (options.now ?? new Date()).toISOString(),
  };
  const encryptedPayload = await hybridEncrypt(address as unknown as CanonicalJson, relationship.peerEncPublicKey, routing(base));
  const unsigned = { ...base, encryptedPayload };
  const entry: PushInboxEntry = {
    ...unsigned,
    signature: await signRelationshipControl(unsigned as unknown as CanonicalJson, relationship.localIdentity.privateKey),
  };
  pushInboxEntries(controlDoc).set(entry.from, entry);
  return entry;
}

/**
 * Verify-on-read of the contact's push address: wrong routing, a signature
 * that does not verify against the pinned peer key, or a malformed payload
 * all yield null — never an exception a caller might mistake for "no push".
 */
export async function readContactPushInbox(
  relationship: Relationship,
  controlDoc: Y.Doc,
): Promise<PushInboxAddress | null> {
  requirePinned(relationship);
  const entry = pushInboxEntries(controlDoc).get(relationship.peerPublicKey);
  if (!entry) return null;
  try {
    if (entry.protocol !== 'push-inbox' || entry.schemaVersion !== 1
      || entry.from !== relationship.peerPublicKey
      || entry.to !== relationship.localIdentity.publicKey) return null;
    const unsigned = { ...entry } as Record<string, unknown>;
    delete unsigned.signature;
    if (!await verifyRelationshipControl(unsigned as CanonicalJson, entry.signature, relationship.peerPublicKey)) return null;
    const payload = await hybridDecrypt<unknown>(entry.encryptedPayload, relationship.localIdentity.encPrivateKey, routing(entry));
    return isValidAddress(payload) ? payload : null;
  } catch {
    return null;
  }
}
