import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';
import type { CodeAppDefinitionBundle, SourceShare } from '@/types.ts';
import { exportDefinitionBundle, verifyDefinitionBundle } from '@/services/store/definitionBundle.ts';
import { generateRoomPassword } from '@/services/store/docs.ts';
import { signalingEndpoints, webrtcPeerOpts } from '@/services/signalingConfig.ts';
import { SOURCE_SHARE_URI_PREFIX } from '@/services/inviteLinks.ts';

const STORAGE_KEY = 'dapp-builder:source-shares:v1';
const SHARE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SHARES = 32;
const PAYLOAD_KEY = 'definition';
const PROTOCOL_KEY = 'protocol';
const SHARE_PROTOCOL = 'source-share-v1';
const RECEIVE_TIMEOUT_MS = 30_000;

interface HostedShare {
  doc: Y.Doc;
  provider: WebrtcProvider;
  expiryTimer: ReturnType<typeof setTimeout>;
}

interface StoredSourceShare extends SourceShare {
  /** Device-local signed snapshot; never enters a dapp document or the link. */
  bundle: CodeAppDefinitionBundle;
}

const hosted = new Map<string, HostedShare>();
const listeners = new Set<() => void>();
let shares: StoredSourceShare[] | null = null;

function validShare(value: unknown): value is StoredSourceShare {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return ['id', 'dappId', 'roomId', 'roomPassword', 'createdAt', 'expiresAt'].every((key) => typeof item[key] === 'string')
    && Date.parse(item.expiresAt as string) > 0
    && typeof item.bundle === 'object' && item.bundle !== null;
}

function readShares(): StoredSourceShare[] {
  if (shares) return shares;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    shares = Array.isArray(parsed) ? parsed.filter(validShare) : [];
  } catch {
    shares = [];
  }
  pruneExpired(false);
  return shares;
}

function persist(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(shares ?? [])); } catch { /* storage health reports persistence failures */ }
  listeners.forEach((listener) => listener());
}

function destroyHosted(id: string): void {
  const entry = hosted.get(id);
  if (!entry) return;
  clearTimeout(entry.expiryTimer);
  entry.provider.destroy();
  entry.doc.destroy();
  hosted.delete(id);
}

function host(share: SourceShare, bundle: CodeAppDefinitionBundle): void {
  if (hosted.has(share.id)) return;
  const doc = new Y.Doc();
  const provider = new WebrtcProvider(share.roomId, doc, {
    password: share.roomPassword,
    signaling: signalingEndpoints(),
    peerOpts: webrtcPeerOpts(),
  });
  doc.transact(() => {
    const payload = doc.getMap('payload');
    payload.set(PROTOCOL_KEY, SHARE_PROTOCOL);
    payload.set(PAYLOAD_KEY, JSON.stringify(bundle));
  });
  const expiryTimer = setTimeout(() => { removeSourceShare(share.id); }, Math.max(0, Date.parse(share.expiresAt) - Date.now()));
  hosted.set(share.id, { doc, provider, expiryTimer });
}

/** Stop expired rooms and forget their capabilities. Returns whether anything changed. */
export function pruneExpired(notify = true): boolean {
  const now = Date.now();
  const before = (shares ?? []).length;
  shares = (shares ?? []).filter((share) => {
    const alive = Date.parse(share.expiresAt) > now;
    if (!alive) destroyHosted(share.id);
    return alive;
  });
  const changed = shares.length !== before;
  if (changed && notify) persist();
  return changed;
}

/** Source shares are local capabilities: this device must stay online to serve them. */
export function listSourceShares(dappId?: string): SourceShare[] {
  const current = readShares();
  return current.filter((share) => !dappId || share.dappId === dappId).map((stored) => ({
    id: stored.id, dappId: stored.dappId, roomId: stored.roomId, roomPassword: stored.roomPassword,
    createdAt: stored.createdAt, expiresAt: stored.expiresAt,
  }));
}

export function subscribeSourceShares(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-open durable local source shares after reload. */
export function initializeSourceShares(): void {
  for (const share of readShares()) {
    try { host(share, share.bundle); }
    catch (error) { console.error(`source share ${share.id} could not be hosted`, error); }
  }
}

export function sourceShareUri(share: Pick<SourceShare, 'roomId' | 'roomPassword' | 'expiresAt'>): string {
  return `${SOURCE_SHARE_URI_PREFIX}${share.roomId}/${share.roomPassword}/${encodeURIComponent(share.expiresAt)}`;
}

export function sourceShareLink(share: SourceShare, origin = window.location.origin): string {
  return `${origin}/import#code=${encodeURIComponent(sourceShareUri(share))}`;
}

/** Creates a reusable 24-hour link and begins serving its signed definition immediately. */
export async function createSourceShare(dappId: string): Promise<SourceShare> {
  pruneExpired();
  const current = readShares();
  if (current.length >= MAX_SHARES) throw new Error(`This device can host at most ${MAX_SHARES} active source links. Remove one first.`);
  const bundle = await exportDefinitionBundle(dappId);
  const createdAt = new Date().toISOString();
  const share: StoredSourceShare = {
    id: crypto.randomUUID(), dappId,
    roomId: `source-share-${crypto.randomUUID()}`,
    roomPassword: generateRoomPassword(), createdAt,
    expiresAt: new Date(Date.now() + SHARE_TTL_MS).toISOString(),
    bundle,
  };
  host(share, bundle);
  shares = [...current, share];
  persist();
  return {
    id: share.id, dappId: share.dappId, roomId: share.roomId, roomPassword: share.roomPassword,
    createdAt: share.createdAt, expiresAt: share.expiresAt,
  };
}

/** Removes the local capability and shuts down its transfer room immediately. */
export function removeSourceShare(id: string): boolean {
  const current = readShares();
  if (!current.some((share) => share.id === id)) return false;
  shares = current.filter((share) => share.id !== id);
  destroyHosted(id);
  persist();
  return true;
}

export interface SourceShareReceive {
  bundle: Promise<CodeAppDefinitionBundle>;
  close(): void;
}

/** Join a transfer room only long enough to obtain and verify one definition bundle. */
export function receiveSourceShare(uri: string): SourceShareReceive {
  const match = /^dapp:\/\/share\/source\/([^/]+)\/([a-f0-9]{64})\/([^/?#]+)$/i.exec(uri.trim());
  if (!match) throw new Error('This source-share link is invalid.');
  const [, roomId, roomPassword, encodedExpiry] = match;
  const expiresAt = decodeURIComponent(encodedExpiry);
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) throw new Error('This source-share link has expired.');
  const doc = new Y.Doc();
  const provider = new WebrtcProvider(roomId, doc, { password: roomPassword, signaling: signalingEndpoints(), peerOpts: webrtcPeerOpts() });
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cleanup: () => void = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    cleanup();
    provider.destroy();
    doc.destroy();
  };
  const bundle = new Promise<CodeAppDefinitionBundle>((resolve, reject) => {
    const payload = doc.getMap('payload');
    const receive = () => {
      if (payload.get(PROTOCOL_KEY) !== SHARE_PROTOCOL) return;
      const raw = payload.get(PAYLOAD_KEY);
      if (typeof raw !== 'string') return;
      cleanup();
      try {
        void verifyDefinitionBundle(JSON.parse(raw)).then(resolve, reject);
      } catch (error) {
        reject(error instanceof Error ? error : new Error('The shared source payload is invalid.'));
      }
    };
    cleanup = () => payload.unobserve(receive);
    payload.observe(receive);
    receive();
    timer = setTimeout(() => { close(); reject(new Error('The source owner is not reachable. Ask them to open Dapp Builder or send a new link.')); }, RECEIVE_TIMEOUT_MS);
  });
  return { bundle: bundle.finally(() => { if (timer) clearTimeout(timer); }), close };
}
