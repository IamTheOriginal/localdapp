import type { Relationship } from '../types.ts';
import { signRelationshipControl } from './relationshipProtocol.ts';
import { readContactPushInbox, writePushInboxEntry } from './store/pushInboxes.ts';
import type * as Y from 'yjs';

// ───── Web Push client (docs/plans/2026-08-31-push-notifications.md) ─────
//
// This device registers a blind mailbox at the relay (VITE_PUSH_RELAY_URL) —
// subscription plus an allowlist of contact signing keys — and distributes
// the opaque inbox id to contacts through encrypted entries in the pairwise
// control docs (store/pushInboxes.ts). Contacts wake this device with signed,
// content-free tickles the relay verifies against the allowlist. Everything
// here is device-local: the registration record lives in localStorage and is
// never synced.

const STORAGE_KEY = 'push-registration-v1';

interface PushRegistrationRecord {
  inboxId: string;
  /** Relay-issued ownership secret for refreshing the registration. */
  secret: string;
  relayUrl: string;
  endpoint: string;
  updatedAt: string;
}

type PushSupport = 'ok' | 'unsupported' | 'ios-needs-install' | 'no-relay';

export function pushRelayUrl(): string {
  const raw = (import.meta.env?.VITE_PUSH_RELAY_URL as string | undefined) ?? '';
  return raw.trim().replace(/\/+$/, '');
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function getPushRegistration(): PushRegistrationRecord | null {
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PushRegistrationRecord;
    return parsed && typeof parsed.inboxId === 'string' && typeof parsed.secret === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function saveRegistration(record: PushRegistrationRecord | null): void {
  if (record) storage()?.setItem(STORAGE_KEY, JSON.stringify(record));
  else storage()?.removeItem(STORAGE_KEY);
}

/** iOS Safari exposes Web Push only inside a Home-Screen-installed app. */
export function getPushSupport(): PushSupport {
  if (!pushRelayUrl()) return 'no-relay';
  if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    const isIos = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = typeof window !== 'undefined'
      && (window.matchMedia?.('(display-mode: standalone)').matches
        || (navigator as Navigator & { standalone?: boolean }).standalone === true);
    return isIos && !standalone ? 'ios-needs-install' : 'unsupported';
  }
  return 'ok';
}

function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function relayFetch(path: string, body: unknown): Promise<Response> {
  return fetch(`${pushRelayUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Contacts allowed to wake this device: each pair's pinned peer signing key. */
async function currentAllowlist(): Promise<string[]> {
  const { listRelationships } = await import('./store/relationships.ts');
  return listRelationships()
    .filter((relationship) => relationship.status === 'active' && relationship.peerPublicKey)
    .map((relationship) => relationship.peerPublicKey as string);
}

async function subscribeWithRelayKey(registration: ServiceWorkerRegistration): Promise<PushSubscription> {
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;
  const vapidResponse = await fetch(`${pushRelayUrl()}/vapid`);
  if (!vapidResponse.ok) throw new Error('Push relay is unreachable');
  const { publicKey } = await vapidResponse.json() as { publicKey: string };
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(publicKey).buffer as ArrayBuffer,
  });
}

/** Creates a fresh relay inbox for `subscription`, stores it, and announces it to contacts; null when the relay refused. */
async function registerNewInbox(subscription: PushSubscription): Promise<PushRegistrationRecord | null> {
  const response = await relayFetch('/register', { subscription: subscription.toJSON(), allow: await currentAllowlist() });
  if (response.status !== 201) return null;
  const { inboxId, secret } = await response.json() as { inboxId: string; secret: string };
  const record: PushRegistrationRecord = {
    inboxId, secret, relayUrl: pushRelayUrl(), endpoint: subscription.endpoint, updatedAt: new Date().toISOString(),
  };
  saveRegistration(record);
  await publishPushInboxesToContacts();
  return record;
}

/**
 * User-gesture entry point: ask permission, subscribe, register the blind
 * mailbox, then tell every contact where a tickle can reach this device.
 */
export async function enablePushNotifications(): Promise<PushRegistrationRecord> {
  if (getPushSupport() !== 'ok') throw new Error('Push notifications are not available in this browser');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted');
  const subscription = await subscribeWithRelayKey(await navigator.serviceWorker.ready);
  const record = await registerNewInbox(subscription);
  if (!record) throw new Error('Push relay registration failed');
  return record;
}

/** Unsubscribes, drops the local record, and announces "push disabled" to contacts. */
export async function disablePushNotifications(): Promise<void> {
  const registration = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    ? await navigator.serviceWorker.ready.catch(() => null)
    : null;
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe().catch(() => false);
  saveRegistration(null);
  await publishPushInboxesToContacts();
}

/**
 * Boot-time refresh: re-register so the relay holds the current subscription
 * (browsers rotate them) and an allowlist that includes contacts paired since
 * last time. A relay that lost the inbox (403/404) forces a fresh
 * registration and re-announcement.
 */
async function revalidatePushRegistration(): Promise<void> {
  const record = getPushRegistration();
  if (!record || getPushSupport() !== 'ok' || Notification.permission !== 'granted') return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await subscribeWithRelayKey(registration);
    const response = await relayFetch('/register', {
      subscription: subscription.toJSON(),
      allow: await currentAllowlist(),
      inboxId: record.inboxId,
      secret: record.secret,
    });
    if (response.ok) {
      saveRegistration({ ...record, endpoint: subscription.endpoint, updatedAt: new Date().toISOString() });
    } else if (response.status === 403 || response.status === 404) {
      saveRegistration(null);
      await registerNewInbox(subscription);
    }
  } catch {
    // Offline or relay down — the next boot retries; push is best-effort.
  }
}

/** Writes this device's (possibly empty) inbox list into every active pair's control doc. */
async function publishPushInboxesToContacts(): Promise<void> {
  const relayUrl = pushRelayUrl();
  if (!relayUrl) return;
  const record = getPushRegistration();
  const [{ listRelationships }, runtime] = await Promise.all([
    import('./store/relationships.ts'),
    import('./browserRelationshipRuntime.ts'),
  ]);
  for (const relationship of listRelationships()) {
    if (relationship.status !== 'active' || !relationship.peerPublicKey || !relationship.peerEncPublicKey) continue;
    try {
      const control = runtime.ensureRelationshipControl(relationship.id);
      await control.persistenceReady;
      await writePushInboxEntry({
        relationship,
        controlDoc: control.doc,
        relayUrl,
        inboxes: record ? [record.inboxId] : [],
      });
    } catch (error) {
      console.error('push: could not publish inbox to contact', error);
    }
  }
}

/** Boot hook (App.tsx): refresh the registration and re-announce inboxes. */
export function initPushNotifications(): void {
  if (getPushSupport() !== 'ok') return;
  void revalidatePushRegistration().then(() => {
    if (getPushRegistration()) return publishPushInboxesToContacts();
    return undefined;
  }).catch(() => undefined);
  // The SW asks clients to revalidate after a pushsubscriptionchange — only a
  // window holds the relay secret, so re-registration must happen here.
  navigator.serviceWorker?.addEventListener?.('message', (event) => {
    if (event.data === 'push-subscription-changed') void revalidatePushRegistration();
  });
}

/**
 * Fire-and-forget wake-up for one contact's devices after a durable share
 * write. The signed payload is fixed-shape and content-free (security
 * invariant: never put dapp ids, names, or any real data in a tickle); the
 * relay verifies the signature against the inbox owner's allowlist and
 * forwards a payload-less push.
 */
export async function sendShareTickle(relationship: Relationship, controlDoc: Y.Doc): Promise<void> {
  try {
    const address = await readContactPushInbox(relationship, controlDoc);
    if (!address || address.inboxes.length === 0) return;
    await Promise.all(address.inboxes.map(async (inboxId) => {
      const payload = {
        inboxId,
        nonce: crypto.randomUUID().replaceAll('-', ''),
        protocol: 'push-tickle' as const,
        schemaVersion: 1 as const,
        sentAt: new Date().toISOString(),
      };
      const signature = await signRelationshipControl(payload, relationship.localIdentity.privateKey);
      await fetch(`${address.relayUrl}/notify/${inboxId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload, senderPublicKey: relationship.localIdentity.publicKey, signature }),
      }).catch(() => undefined);
    }));
  } catch {
    // Tickles are best-effort by design; the durable P2P write already happened.
  }
}
