import * as Y from 'yjs';
import type { ChannelDescriptor, StreamEvent } from '../types.ts';
import { canonicalSignedStreamEvent, hashStreamEvent, verifyStreamEvent } from './relationshipStream.ts';

/**
 * Signed stream-event log inside a channel doc: verified ingest plus deterministic
 * per-stream chain derivation. Channel bindings (deliveries/acks) and the legacy
 * projected-record streams both live here.
 */

export const RELATIONSHIP_STREAM_EVENTS_MAP = 'relationshipStreamEventsV1';
const PROJECTION_PUBLISH_ORIGIN = Symbol('relationship-projection-publish');

type StreamDescriptor = Pick<ChannelDescriptor, 'id' | 'relationshipId' | 'memberDeviceKeys' | 'status'>;

function streamEvents(doc: Y.Doc): Y.Map<string> {
  return doc.getMap<string>(RELATIONSHIP_STREAM_EVENTS_MAP);
}

function parseCandidate(value: string): StreamEvent | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as StreamEvent;
  } catch {
    return null;
  }
}

interface AcceptedStream {
  streamId: string;
  events: StreamEvent[];
  hashes: string[];
}

/**
 * Verified entries considered per signer in one scan. A channel legitimately
 * holds up to 1,000 queued deliveries per signer plus their acks (100 kept,
 * up to one per delivery while a backlog drains), so an honest signer stays
 * well below this; it only bounds the work a signer can cause by flooding the
 * doc with validly signed entries. It counts VERIFIED entries on purpose: the
 * signer field of an unverified entry is a claim, and counting claims would
 * let a peer crowd out our own entries with junk carrying our key.
 */
export const MAX_STREAM_ENTRIES_PER_SIGNER = 4_000;

/** Verdict for one stored entry; only valid for exactly these bytes. */
interface EntryVerdict {
  serialized: string;
  valid: boolean;
}

/**
 * Verdicts per channel doc, per descriptor view. The verdict of an entry is a
 * pure function of (map key, stored bytes, descriptor fields verification
 * reads), so it is reused only while all three are unchanged: changed bytes
 * miss on `serialized`, a changed descriptor (status, member keys, …) misses on
 * the fingerprint. Rejections are cached too — junk is not re-verified either.
 * Keyed weakly by doc, so a destroyed channel doc takes its verdicts with it.
 */
const verdictCaches = new WeakMap<Y.Doc, Map<string, Map<string, EntryVerdict>>>();
/** A pending share is scanned with two descriptor views (real and outbound 'active'); more means stale ones. */
const MAX_DESCRIPTOR_VIEWS = 2;

function descriptorFingerprint(descriptor: StreamDescriptor): string {
  return JSON.stringify([descriptor.id, descriptor.relationshipId, descriptor.status, descriptor.memberDeviceKeys]);
}

/** The full acceptance check for one stored entry — signature, membership, hash and canonical form. */
async function verifyStoredEntry(storedHash: string, serialized: string, descriptor: StreamDescriptor): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(storedHash)) return false;
  const event = parseCandidate(serialized);
  if (!event || !(await verifyStreamEvent(event, descriptor))) return false;
  const actualHash = await hashStreamEvent(event);
  return actualHash === storedHash && canonicalSignedStreamEvent(event) === serialized;
}

export async function deriveAcceptedStreams(
  doc: Y.Doc,
  descriptor: StreamDescriptor,
  options: { maxEntriesPerSigner?: number } = {},
): Promise<Map<string, AcceptedStream>> {
  const maxEntriesPerSigner = options.maxEntriesPerSigner ?? MAX_STREAM_ENTRIES_PER_SIGNER;
  const fingerprint = descriptorFingerprint(descriptor);
  let views = verdictCaches.get(doc);
  if (!views) {
    views = new Map<string, Map<string, EntryVerdict>>();
    verdictCaches.set(doc, views);
  }
  const known = views.get(fingerprint);
  // Rebuilt every scan, so verdicts of entries that left the doc are dropped.
  const verdicts = new Map<string, EntryVerdict>();

  const candidates = new Map<string, StreamEvent>();
  const duplicateEventIds = new Set<string>();
  const eventIdHashes = new Map<string, string>();

  for (const [storedHash, serialized] of streamEvents(doc)) {
    const cached = known?.get(storedHash);
    const valid = cached?.serialized === serialized
      ? cached.valid
      : await verifyStoredEntry(storedHash, serialized, descriptor);
    verdicts.set(storedHash, { serialized, valid });
    // Parsed again on a cache hit: callers get their own event objects, as before.
    const event = valid ? parseCandidate(serialized) : null;
    if (!event) continue;
    const previous = eventIdHashes.get(event.eventId);
    if (previous && previous !== storedHash) duplicateEventIds.add(event.eventId);
    eventIdHashes.set(event.eventId, storedHash);
    candidates.set(storedHash, event);
  }
  if (!views.has(fingerprint) && views.size >= MAX_DESCRIPTOR_VIEWS) views.clear();
  views.set(fingerprint, verdicts);

  candidates.forEach((event, hash) => {
    if (duplicateEventIds.has(event.eventId)) candidates.delete(hash);
  });

  // Per-signer cap. Which entries fall out is deterministic (hash order), and a
  // stream that lost an entry is not derived at all this scan: a partial view
  // could otherwise crown a fork or a successor that the full view rejects.
  const hashesBySigner = new Map<string, string[]>();
  candidates.forEach((event, hash) => {
    const hashes = hashesBySigner.get(event.signerPublicKey);
    if (hashes) hashes.push(hash);
    else hashesBySigner.set(event.signerPublicKey, [hash]);
  });
  const truncatedStreams = new Set<string>();
  hashesBySigner.forEach((hashes) => {
    if (hashes.length <= maxEntriesPerSigner) return;
    hashes.sort((left, right) => left.localeCompare(right)).slice(maxEntriesPerSigner).forEach((hash) => {
      const event = candidates.get(hash);
      if (event) truncatedStreams.add(event.streamId);
      candidates.delete(hash);
    });
  });

  // Index once: stream → sequence → previous hash → entries. Map keys compare
  // like `===` for the values looked up here, so the chain walk below accepts
  // exactly what the former filter over all candidates accepted.
  type StreamEntries = Array<[string, StreamEvent]>;
  const index = new Map<string, Map<unknown, Map<unknown, StreamEntries>>>();
  candidates.forEach((event, hash) => {
    if (truncatedStreams.has(event.streamId)) return;
    let bySequence = index.get(event.streamId);
    if (!bySequence) {
      bySequence = new Map<unknown, Map<unknown, StreamEntries>>();
      index.set(event.streamId, bySequence);
    }
    let byPrevious = bySequence.get(event.sequence);
    if (!byPrevious) {
      byPrevious = new Map<unknown, StreamEntries>();
      bySequence.set(event.sequence, byPrevious);
    }
    const entries = byPrevious.get(event.previousEventHash);
    if (entries) entries.push([hash, event]);
    else byPrevious.set(event.previousEventHash, [[hash, event]]);
  });

  const streams = new Map<string, AcceptedStream>();
  for (const [streamId, bySequence] of index) {
    const accepted: AcceptedStream = { streamId, events: [], hashes: [] };
    let previousHash: string | null = null;
    let sequence = 0;
    let ownerKey: string | null = null;
    while (true) {
      const children: StreamEntries = (bySequence.get(sequence)?.get(previousHash) ?? [])
        .filter(([, event]) => ownerKey === null || event.signerPublicKey === ownerKey)
        .sort(([left], [right]) => left.localeCompare(right));
      if (children.length === 0) break;
      const [hash, event] = children[0];
      ownerKey ??= event.signerPublicKey;
      accepted.hashes.push(hash);
      accepted.events.push(event);
      previousHash = hash;
      sequence += 1;
    }
    if (accepted.events.length > 0) streams.set(streamId, accepted);
  }
  return streams;
}

export async function ingestStreamEvent(
  doc: Y.Doc,
  descriptor: StreamDescriptor,
  event: StreamEvent,
): Promise<{ status: 'stored' | 'duplicate' | 'rejected'; hash?: string }> {
  if (!(await verifyStreamEvent(event, descriptor))) return { status: 'rejected' };
  const hash = await hashStreamEvent(event);
  const serialized = canonicalSignedStreamEvent(event);
  const current = streamEvents(doc).get(hash);
  if (current === serialized) return { status: 'duplicate', hash };
  if (current !== undefined) return { status: 'rejected' };
  doc.transact(() => streamEvents(doc).set(hash, serialized), PROJECTION_PUBLISH_ORIGIN);
  return { status: 'stored', hash };
}
