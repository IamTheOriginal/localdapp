import type { CodeAppBindingDeclaration, CodeAppChromeMode, CodeAppHostPermissions, CodeAppHostSurface, CodeAppManifest, DappContactHandle, MemberRole } from '@/types';
import { normalizeCodeAppRoutePath, parseCodeAppManifest, splitCodeAppNavigationTarget } from './codeAppManifest';
import { extractCodeAppI18n } from './codeAppI18n';
import { CodeAppResourceBundler } from './codeAppResources';
import { CodeAppCamera } from './codeAppCamera.ts';
import { getIdentity } from './identity';
import { showConfirm } from './dialogs.ts';
import { getRunnableCodeAppFile } from './store/sourceSeal.ts';
import { de } from '../i18n/de.ts';
import { handleStoreOperation, resolveStoreCollectionId } from './codeAppStoreBridge.ts';
import { handleFilesOperation } from './codeAppFilesBridge.ts';
import { getReadModel, sanitizeCollectionName, sanitizeQueryOptions } from './store/readModel.ts';
import { getDirectCodeBindingRuntime } from './directCodeBindingRuntime';
import { getChannelBindingRuntime } from './channelBindingRuntime';
import { listChannelShares, listChannelSharesByInstance } from './store/channelShares';
import { deriveDappContactHandle, resolveDappContactHandle } from './store/contacts';
import { getRelationship } from './store/relationships';
import { getPerson } from './store/people';
import {
  assignAppRole,
  deleteCodeAppData,
  getAppRole,
  getCodeAppData,
  getCodeAppDataSnapshot,
  getDappConfig,
  getDappDoc,
  getDappPersistence,
  listAppRoleAssignments,
  setCodeAppData,
} from './store';
import { whenLocalCopyLoaded } from './store/storageHealth';

const MAX_SUBSCRIPTIONS = 32;
/** Doc changes are coalesced for this long before subscriptions refresh (the read model uses the same window). */
const SUBSCRIPTION_REFRESH_DEBOUNCE_MS = 250;
const HOST_SURFACE_MIN_INTERVAL_MS = 500;

/**
 * Backpressure for the Code App bridge. Every write an app makes is signed,
 * written into the shared Yjs doc and broadcast to every member, and `$files`
 * uploads are pinned forever on this device — an app looping on `$store.create`
 * or `$files.add` bloats the dapp for everyone. All limits live here (tests
 * lower them in place); a rejected call gets a {@link CodeAppBridgeError} with
 * `code` `rate_limited` (retry after `retryAfterMs`) or `quota_exceeded`.
 * Documented in docs/code-apps/README.md ("Bridge limits").
 */
export const CODE_APP_BRIDGE_LIMITS = {
  /** Write calls (see {@link CODE_APP_WRITE_METHODS}): burst size of the per-runtime bucket. */
  writeBurst: 50,
  /** Write calls refilled per second. */
  writeRefillPerSecond: 10,
  /** Read / UI calls (everything else): burst size of a separate, far larger bucket. */
  readBurst: 1000,
  /** Read / UI calls refilled per second. */
  readRefillPerSecond: 200,
  /** Serialized JSON payload of `$data` / `$store` / `$events` writes per runtime per minute (burst = one minute's worth). */
  writeBytesPerMinute: 8 * 1024 * 1024,
  /** `$files.add` bytes per dapp per page session (not per runtime: reopening the app does not reset it). */
  filesBytesPerSession: 512 * 1024 * 1024,
};

/**
 * Bridge methods that write to the dapp doc, the blob store, a channel or the
 * member list — each costs a signature, a Yjs update and a mesh broadcast.
 */
export const CODE_APP_WRITE_METHODS: ReadonlySet<string> = new Set([
  'data.set', 'data.delete',
  'store.create', 'store.update', 'store.delete',
  'files.add', 'files.delete',
  'events.publish',
  'share.open', 'share.close', 'share.leave',
  'roles.assign',
]);

export type CodeAppBridgeErrorCode = 'rate_limited' | 'quota_exceeded';

/** A structured bridge rejection: the app receives `error.code` (and `error.retryAfterMs` when a retry can succeed). */
export class CodeAppBridgeError extends Error {
  readonly code: CodeAppBridgeErrorCode;
  readonly retryAfterMs?: number;
  constructor(code: CodeAppBridgeErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'CodeAppBridgeError';
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** `$files.add` bytes accepted per dapp during this page session. */
const filesBytesUsed = new Map<string, number>();

/** Forgets every dapp's `$files` session budget (tests). */
export function resetCodeAppFilesBudgets(): void {
  filesBytesUsed.clear();
}

/** A token bucket whose size and refill rate are read on every call, so lowered limits apply at once. */
function createTokenBucket(capacity: () => number, refillPerMs: () => number) {
  let tokens = capacity();
  let updatedAt = Date.now();
  const refill = () => {
    const now = Date.now();
    tokens = Math.min(capacity(), tokens + Math.max(0, now - updatedAt) * refillPerMs());
    updatedAt = now;
  };
  return {
    /** Ms until `cost` tokens are available; 0 means available now. */
    waitFor(cost: number): number {
      refill();
      if (tokens >= cost) return 0;
      const rate = refillPerMs();
      return rate > 0 ? Math.ceil((cost - tokens) / rate) : Number.POSITIVE_INFINITY;
    },
    take(cost: number) {
      tokens -= cost;
    },
  };
}

/** Serialized size of a write payload (JSON characters); 0 when it does not serialize — the write itself rejects it. */
function payloadSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** JSON payload a write call adds to the dapp doc / channel. */
function writePayloadBytes(method: string, args: unknown[]): number {
  switch (method) {
    case 'data.set': return payloadSize(args[0]) + payloadSize(args[1]);
    case 'store.create': return payloadSize(args[1]);
    case 'store.update': return payloadSize(args[2]);
    case 'events.publish': return payloadSize(args[1]);
    default: return 0;
  }
}

/** Byte length of the content a `$files.add` call carries. */
function filesAddBytes(args: unknown[]): number {
  const input = args[0] && typeof args[0] === 'object' ? (args[0] as Record<string, unknown>).bytes : undefined;
  return input instanceof ArrayBuffer || ArrayBuffer.isView(input) ? input.byteLength : 0;
}

function codeAppSdk(runtimeId: string, i18nDictionaries: Record<string, Record<string, string>>): string {
  return `(() => {
    'use strict';
    const runtimeId = ${JSON.stringify(runtimeId)};
    // Dictionaries from the app's own i18n/<language>.json source files,
    // embedded at document build time — no runtime fetch, no bridge call.
    const i18nDictionaries = ${JSON.stringify(i18nDictionaries)};
    const pending = new Map();
    const dataSubscriptions = new Map();
    const storeSubscriptions = new Map();
    const routeSubscriptions = new Set();
    const languageSubscriptions = new Set();
    const actionHandlers = new Map();
    const readyCallbacks = [];
    let context = null;
    let currentRoute = '/';
    let currentSearch = '';
    let currentChrome = 'standard';
    let currentLanguage = 'en';

    const post = (message) => parent.postMessage({ __codeApp: true, runtimeId, ...message }, '*');
    const updateRoute = (route, search = '') => {
      if (typeof route !== 'string' || typeof search !== 'string') return;
      if (route === currentRoute && search === currentSearch) return;
      currentRoute = route;
      currentSearch = search;
      routeSubscriptions.forEach((callback) => callback(currentRoute));
      dispatchEvent(new CustomEvent('dapp:route-changed', { detail: { path: currentRoute, search: currentSearch } }));
    };
    const updateChrome = (chrome) => {
      if (chrome !== 'standard' && chrome !== 'fullscreen') return;
      if (chrome === currentChrome) return;
      currentChrome = chrome;
      dispatchEvent(new CustomEvent('dapp:chrome-changed', { detail: { chrome: currentChrome } }));
    };
    const updateLanguage = (language) => {
      if (typeof language !== 'string' || !language || language === currentLanguage) return;
      currentLanguage = language.toLowerCase();
      languageSubscriptions.forEach((callback) => callback(currentLanguage));
      dispatchEvent(new CustomEvent('dapp:language-changed', { detail: { language: currentLanguage } }));
    };
    const request = (method, args = []) => new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      // Human-mediated share consent may legitimately take several minutes in the host;
      // file content may have to be fetched from peers; initial subscribe/query
      // calls on a large collection wait for IndexedDB restore plus a full
      // serialization. Keep ordinary bridge calls fail-fast.
      const timeoutMs = (method === 'share.open' || method === 'ui.openLink' || method === 'share.close' || method === 'share.leave') ? 610000
        : method === 'camera.start' ? 65000
        : method === 'files.get' ? 120000
        : (method.endsWith('.subscribe') || method === 'store.query' || method === 'actions.register') ? 45000
        : 10000;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Code App request timed out'));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      post({ type: 'request', requestId, method, args });
    });

    addEventListener('message', (event) => {
      const message = event.data;
      if (!message || !message.__codeApp || message.runtimeId !== runtimeId) return;
      if (message.type === 'init') {
        context = Object.freeze(message.context);
        updateRoute(message.route || message.context?.route || '/', message.search || message.context?.search || '');
        updateChrome(message.context?.chrome || 'standard');
        updateLanguage(message.context?.language || 'en');
        readyCallbacks.splice(0).forEach((callback) => callback(context));
        dispatchEvent(new CustomEvent('dapp:ready', { detail: context }));
        return;
      }
      if (message.type === 'route-changed') {
        updateRoute(message.route, message.search || '');
        return;
      }
      if (message.type === 'chrome-changed') {
        updateChrome(message.chrome);
        return;
      }
      if (message.type === 'language-changed') {
        updateLanguage(message.language);
        return;
      }
      if (message.type === 'response') {
        const operation = pending.get(message.requestId);
        if (!operation) return;
        clearTimeout(operation.timer);
        pending.delete(message.requestId);
        if (message.error) {
          const error = new Error(message.error);
          if (typeof message.errorName === 'string') error.name = message.errorName;
          if (typeof message.code === 'string') error.code = message.code;
          if (typeof message.retryAfterMs === 'number') error.retryAfterMs = message.retryAfterMs;
          operation.reject(error);
        } else operation.resolve(message.result);
        return;
      }
      if (message.type === 'data-changed') {
        dataSubscriptions.get(message.subscriptionId)?.(message.data);
        return;
      }
      if (message.type === 'store-changed') {
        storeSubscriptions.get(message.subscriptionId)?.(message.records);
        return;
      }
      if (message.type === 'db-changed') {
        const invalidated = dbSubscriptions.get(message.subscriptionId);
        if (invalidated) Promise.resolve().then(() => invalidated());
        return;
      }
      if (message.type === 'action-delivery') {
        const handler = actionHandlers.get(message.actionId);
        if (!handler) {
          post({ type: 'action-result', deliveryId: message.deliveryId, error: 'Action handler is not registered' });
          return;
        }
        Promise.resolve().then(() => handler(message.payload, Object.freeze({
          deliveryId: message.deliveryId,
          from: message.context?.from || null,
          instanceId: message.context?.instanceId || null,
        })))
          .then(() => post({ type: 'action-result', deliveryId: message.deliveryId }))
          .catch((error) => post({ type: 'action-result', deliveryId: message.deliveryId, error: error instanceof Error ? error.message : String(error) }));
      }
    });

    const subscribe = async (kind, args, callback, subscriptions) => {
      if (typeof callback !== 'function') throw new Error('subscribe requires a callback');
      const subscriptionId = crypto.randomUUID();
      subscriptions.set(subscriptionId, callback);
      try {
        const initial = await request(kind + '.subscribe', [...args, subscriptionId]);
        callback(initial);
      } catch (error) {
        subscriptions.delete(subscriptionId);
        throw error;
      }
      return () => {
        subscriptions.delete(subscriptionId);
        request(kind + '.unsubscribe', [subscriptionId]).catch(() => {});
      };
    };

    const Dapp = Object.freeze({
      get context() { return context; },
      onReady(callback) {
        if (context) queueMicrotask(() => callback(context));
        else readyCallbacks.push(callback);
      },
    });
    const data = Object.freeze({
      get: (key) => request('data.get', [key]),
      set: (key, value) => request('data.set', [key, value]),
      delete: (key) => request('data.delete', [key]),
      snapshot: () => request('data.snapshot'),
      subscribe: (callback) => subscribe('data', [], callback, dataSubscriptions),
    });
    const store = Object.freeze({
      query: (entity, filter) => request('store.query', [entity, filter]),
      get: (entity, id) => request('store.get', [entity, id]),
      create: (entity, value) => request('store.create', [entity, value]),
      update: (entity, id, value) => request('store.update', [entity, id, value]),
      delete: (entity, id) => request('store.delete', [entity, id]),
      subscribe: (entity, filter, callback) => subscribe('store', [entity, filter], callback, storeSubscriptions),
    });
    const router = Object.freeze({
      current: () => currentRoute,
      search: () => currentSearch,
      query: (name) => new URLSearchParams(currentSearch).get(String(name)),
      navigate: (path) => request('router.navigate', [path]),
      subscribe(callback) {
        if (typeof callback !== 'function') throw new Error('router.subscribe requires a callback');
        routeSubscriptions.add(callback);
        queueMicrotask(() => callback(currentRoute));
        return () => routeSubscriptions.delete(callback);
      },
      chrome: () => currentChrome,
      setChrome: (mode) => request('router.setChrome', [mode]),
    });
    const events = Object.freeze({
      publish: (eventId, payload, options) => request('events.publish', [eventId, payload, options || {}]),
    });
    const contacts = Object.freeze({
      pick: (options) => request('contacts.pick', [options || {}]),
      invite: () => request('contacts.invite'),
    });
    const share = Object.freeze({
      open: (options) => request('share.open', [options || {}]),
      list: () => request('share.list'),
      participants: (instanceId) => request('share.participants', [instanceId]),
      close: (instanceId) => request('share.close', [instanceId]),
      leave: (instanceId) => request('share.leave', [instanceId]),
    });
    const actions = Object.freeze({
      async handle(actionId, handler) {
        if (typeof handler !== 'function') throw new Error('$actions.handle requires a handler');
        actionHandlers.set(actionId, handler);
        try { await request('actions.register', [actionId]); }
        catch (error) { actionHandlers.delete(actionId); throw error; }
        return () => {
          actionHandlers.delete(actionId);
          request('actions.unregister', [actionId]).catch(() => {});
        };
      },
    });
    const roles = Object.freeze({
      current: () => (context && context.appRole) || null,
      list: () => (context && context.roles) || [],
      assignments: () => request('roles.assignments'),
      assign: (publicKey, roleId) => request('roles.assign', [publicKey, roleId]),
    });
    const ui = Object.freeze({
      openCodeEditor: (params) => request('ui.open', ['codeEditor', params || {}]),
      openSettings: (params) => request('ui.open', ['settings', params || {}]),
      // External pages never replace the host tab: the host asks the person, then opens a new tab.
      openLink: (url) => request('ui.openLink', [String(url)]),
    });
    // The sandbox has neither top-navigation nor popups, so an http(s) link would do
    // nothing on its own. Hand it to the host instead (covers links created by script too).
    addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target;
      const link = target && typeof target.closest === 'function' ? target.closest('a[href], area[href]') : null;
      if (!link) return;
      const href = (link.getAttribute('href') || '').trim();
      if (!href || href.startsWith('#')) return;
      // Everything else would navigate the frame itself (a relative link resolves against
      // the HOST's address). In-app routes go through $router.navigate.
      event.preventDefault();
      if (/^https?:/i.test(href)) ui.openLink(href).catch(() => {});
    });
    const dbSubscriptions = new Map();
    const db = Object.freeze({
      query: (collection, options) => request('db.query', [collection, options || {}]),
      get: (collection, id) => request('db.get', [collection, id]),
      count: (collection, options) => request('db.count', [collection, options || {}]),
      async subscribe(collection, callback) {
        if (typeof callback !== 'function') throw new Error('$db.subscribe requires a callback');
        const subscriptionId = crypto.randomUUID();
        dbSubscriptions.set(subscriptionId, callback);
        try { await request('db.subscribe', [collection, subscriptionId]); }
        catch (error) { dbSubscriptions.delete(subscriptionId); throw error; }
        return () => {
          dbSubscriptions.delete(subscriptionId);
          request('db.unsubscribe', [subscriptionId]).catch(() => {});
        };
      },
    });
    // Resolution: exact language → base language ('de-at' → 'de') → 'en'
    // dictionary (when the app uses abstract keys) → the key itself (when
    // keys are the English source strings, the host-shell convention).
    const i18nLookup = (language, key) => {
      const dictionary = i18nDictionaries[language];
      return dictionary && Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : null;
    };
    const i18n = Object.freeze({
      t(key, params) {
        const id = String(key);
        const base = currentLanguage.split('-')[0];
        let text = i18nLookup(currentLanguage, id) ?? i18nLookup(base, id) ?? i18nLookup('en', id) ?? id;
        if (params && typeof params === 'object') {
          for (const [name, value] of Object.entries(params)) {
            text = text.split('{' + name + '}').join(String(value));
          }
        }
        return text;
      },
      language: () => currentLanguage,
      available: () => {
        const languages = new Set(Object.keys(i18nDictionaries));
        languages.add('en');
        return Array.from(languages).sort();
      },
      subscribe(callback) {
        if (typeof callback !== 'function') throw new Error('$i18n.subscribe requires a callback');
        languageSubscriptions.add(callback);
        queueMicrotask(() => callback(currentLanguage));
        return () => languageSubscriptions.delete(callback);
      },
    });
    const files = Object.freeze({
      list: () => request('files.list'),
      find: (name) => request('files.find', [name]),
      get: (fileId) => request('files.get', [fileId]),
      async add(input) {
        const source = input && typeof input === 'object' ? input : {};
        let bytes = source.data;
        if (bytes instanceof Blob) bytes = await bytes.arrayBuffer();
        if (bytes instanceof Uint8Array) bytes = bytes.slice().buffer;
        return request('files.add', [{ name: source.name, mime: source.mime, bytes, thumbnail: source.thumbnail !== false }]);
      },
      delete: (fileId) => request('files.delete', [fileId]),
      async objectUrl(fileId) {
        const result = await request('files.get', [fileId]);
        if (!result) return null;
        const blob = new Blob([result.bytes], { type: (result.record && result.record.mime) || 'application/octet-stream' });
        return URL.createObjectURL(blob);
      },
    });

    const camera = Object.freeze({
      start: (options) => request('camera.start', [options || {}]),
      frame: () => request('camera.frame'),
      stop: () => request('camera.stop'),
    });

    Object.defineProperties(globalThis, {
      Dapp: { value: Dapp },
      $data: { value: data },
      $store: { value: store },
      $router: { value: router },
      $events: { value: events },
      $contacts: { value: contacts },
      $share: { value: share },
      $actions: { value: actions },
      $roles: { value: roles },
      $ui: { value: ui },
      $files: { value: files },
      $camera: { value: camera },
      $db: { value: db },
      $i18n: { value: i18n },
      $t: { value: i18n.t },
    });
    post({ type: 'ready' });
  })();`;
}

interface CodeAppDocumentBundle {
  srcdoc: string;
  dispose: () => void;
}

// No top-navigation token (not even the by-user-activation one): any click inside the
// app would let script replace the host tab with a look-alike and carry data out in the
// URL. External links go through the `ui.openLink` bridge call and a host confirmation.
export const CODE_APP_SANDBOX = 'allow-scripts allow-modals';

function codeAppCsp(nonce: string, manifest: CodeAppManifest): string {
  const connectOrigins = manifest.permissions?.network?.connect || [];
  const imageOrigins = manifest.permissions?.network?.images || [];
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    // Nonces cannot authorize style="…" attributes, which Code App authors
    // (and the shipped starters) use routinely — the browser blocked them all.
    // Attribute CSS carries no script capability, and CSS-based exfiltration
    // is already cut off by the img/font/media/connect lockdown below, so
    // allowing attributes keeps authoring sane without weakening the sandbox.
    "style-src-attr 'unsafe-inline'",
    // blob: lets apps render content fetched through $files via object URLs —
    // same-document data only, no network reach.
    `img-src data: blob:${imageOrigins.length > 0 ? ` ${imageOrigins.join(' ')}` : ''}`,
    'font-src data:',
    'media-src data: blob:',
    connectOrigins.length > 0 ? `connect-src ${connectOrigins.join(' ')}` : "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    // connect-src does not govern RTCPeerConnection; without this "network: none" would
    // not hold (enforced by Chromium; Firefox ignores the directive — see THREAT_MODEL.md).
    "webrtc 'block'",
    "base-uri 'none'",
  ].join('; ');
}

function safeInlineScript(source: string): string {
  // The document is serialized and parsed again as iframe srcdoc. Prevent a
  // JavaScript string/comment containing </script from terminating its node.
  return source.replace(/<\/script/gi, '<\\/script');
}

function safeInlineStyle(source: string): string {
  // CSS is also serialized into a raw-text element. Escaping the slash keeps
  // authored </style text inside that element during the srcdoc parse.
  return source.replace(/<\/style/gi, '<\\/style');
}

function isClassicScriptType(type: string | null): boolean {
  if (!type) return true;
  return /^(?:text|application)\/(?:java|ecma)script$/i.test(type.trim());
}

function isJsonScriptType(type: string | null): boolean {
  return !!type && /^(?:application|text)\/(?:[\w.-]+\+)?json$/i.test(type.trim());
}

function isAllowedNavigationHref(value: string): boolean {
  const href = value.trim();
  if (!href) return false;
  if (href.startsWith('#')) return true;
  // Absolute http(s) only: a relative link in a srcdoc frame resolves against the host's
  // own address — in-app routes belong to $router.navigate.
  return externalLinkOf(href) !== null;
}

export function buildCodeAppDocument(
  files: Readonly<Record<string, string>>,
  runtimeId: string,
): CodeAppDocumentBundle {
  const { manifest } = parseCodeAppManifest(files['manifest.yaml'] || '');
  const resources = new CodeAppResourceBundler(files, new Set(manifest.permissions?.network?.images || []));
  const nonce = crypto.randomUUID().replaceAll('-', '');
  try {
    const parser = new DOMParser();
    const documentNode = parser.parseFromString(files['index.html'] || '', 'text/html');

    // Authored document policy, navigation, and speculative loading must never
    // weaken or race the Builder's policy.
    documentNode.querySelectorAll('base, meta[http-equiv], link').forEach((node) => {
      if (node.tagName === 'BASE' || node.tagName === 'META') {
        const httpEquiv = node.getAttribute('http-equiv')?.trim().toLowerCase();
        if (node.tagName === 'BASE' || httpEquiv === 'content-security-policy' || httpEquiv === 'refresh') node.remove();
        return;
      }
      const link = node as HTMLLinkElement;
      const rel = link.rel.toLowerCase().split(/\s+/);
      if (rel.includes('stylesheet')) {
        const href = link.getAttribute('href') || '';
        const css = resources.getStylesheet(href, 'index.html');
        if (css === null) link.remove();
        else {
          const style = documentNode.createElement('style');
          style.setAttribute('nonce', nonce);
          style.textContent = safeInlineStyle(css);
          link.replaceWith(style);
        }
      } else {
        // Includes preload/modulepreload/prefetch/preconnect and icons. Only
        // explicitly supported stylesheets are loadable in this phase.
        link.remove();
      }
    });

    documentNode.querySelectorAll('style').forEach((style) => {
      const css = resources.rewriteCss(style.textContent || '', 'index.html');
      if (css === null) {
        style.remove();
        return;
      }
      style.removeAttribute('nonce');
      style.setAttribute('nonce', nonce);
      style.textContent = safeInlineStyle(css);
    });

    const attributeRules: string[] = [];
    documentNode.querySelectorAll<HTMLElement>('[style]').forEach((element, index) => {
      const css = resources.rewriteCss(element.getAttribute('style') || '', 'index.html');
      element.removeAttribute('style');
      if (css === null) return;
      const marker = `s${index}`;
      element.setAttribute('data-code-app-style', marker);
      attributeRules.push(`[data-code-app-style="${marker}"]{${css}}`);
    });
    if (attributeRules.length > 0) {
      const style = documentNode.createElement('style');
      style.setAttribute('nonce', nonce);
      style.textContent = safeInlineStyle(attributeRules.join('\n'));
      documentNode.head.append(style);
    }

    documentNode.querySelectorAll('script').forEach((script) => {
      // SVG script elements use href/xlink:href instead of src. Never grant
      // them the Builder-generated nonce; only HTML classic scripts are supported.
      if (script.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
        script.remove();
        return;
      }
      const type = script.getAttribute('type');
      if (type?.trim().toLowerCase() === 'module') {
        script.remove();
        return;
      }
      if (!isClassicScriptType(type)) {
        if (isJsonScriptType(type) && !script.hasAttribute('src')) {
          script.removeAttribute('nonce');
          return;
        }
        script.remove();
        return;
      }

      const source = script.getAttribute('src');
      const content = source
        ? resources.getScript(source, 'index.html')
        : script.textContent || '';
      if (content === null) {
        script.remove();
        return;
      }
      script.removeAttribute('src');
      script.textContent = safeInlineScript(content);
      for (const attribute of ['nonce', 'integrity', 'crossorigin', 'referrerpolicy', 'href', 'xlink:href']) script.removeAttribute(attribute);
      script.setAttribute('nonce', nonce);
    });

    documentNode.querySelectorAll('[srcset]').forEach((node) => node.removeAttribute('srcset'));
    documentNode.querySelectorAll('img[src], input[type="image"][src]').forEach((node) => {
      const source = node.getAttribute('src') || '';
      const url = resources.resolveImage(source, 'index.html');
      if (url) node.setAttribute('src', url);
      else node.removeAttribute('src');
    });
    documentNode.querySelectorAll('iframe, frame, object, embed, source, track').forEach((node) => node.remove());
    documentNode.querySelectorAll('audio[src], video[src], video[poster], svg image').forEach((node) => {
      node.removeAttribute('src');
      node.removeAttribute('poster');
      node.removeAttribute('href');
      node.removeAttribute('xlink:href');
    });
    documentNode.querySelectorAll('[ping], form[action], [formaction], [background]').forEach((node) => {
      node.removeAttribute('ping');
      node.removeAttribute('action');
      node.removeAttribute('formaction');
      node.removeAttribute('background');
    });
    documentNode.querySelectorAll('a[href], area[href]').forEach((node) => {
      const href = (node.getAttribute('href') || '').trim();
      node.removeAttribute('download');
      if (!isAllowedNavigationHref(href)) {
        node.removeAttribute('href');
        node.removeAttribute('target');
        node.removeAttribute('rel');
      } else if (href.startsWith('#')) {
        node.setAttribute('href', href);
        node.removeAttribute('target');
        node.removeAttribute('rel');
      } else {
        // Stays a plain link for accessibility; the in-frame click handler routes it
        // through `ui.openLink` (the sandbox cannot navigate anything but itself).
        node.setAttribute('href', href);
        node.removeAttribute('target');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    documentNode.querySelectorAll('*').forEach((node) => {
      for (const attribute of [...node.attributes]) {
        if (attribute.name.toLowerCase().startsWith('on')) node.removeAttribute(attribute.name);
      }
    });

    const policy = documentNode.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = codeAppCsp(nonce, manifest);
    documentNode.head.prepend(policy);

    const sdk = documentNode.createElement('script');
    sdk.setAttribute('nonce', nonce);
    sdk.textContent = safeInlineScript(codeAppSdk(runtimeId, extractCodeAppI18n(files)));
    policy.after(sdk);

    return {
      srcdoc: '<!doctype html>\n' + documentNode.documentElement.outerHTML,
      dispose: () => resources.dispose(),
    };
  } catch (error) {
    resources.dispose();
    throw error;
  }
}

interface StoreSubscription {
  entity: string;
  filter?: Record<string, unknown>;
}

/** The slice of a Yjs deep-observer event the subscription refresh reads. */
interface DataChangeEvent {
  path: Array<string | number>;
  keys: Map<string, unknown>;
}

/** Stable text form of a subscription result; null (never equal) when it cannot be serialized. */
function serializeSubscriptionResult(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/**
 * Untrusted envelope a sandboxed Code App posts over the bridge. Fields are
 * declared as unknown, never trusted — each consumer narrows before use.
 */
interface CodeAppBridgeEnvelope {
  __codeApp?: unknown;
  runtimeId?: unknown;
  type?: unknown;
  deliveryId?: unknown;
  error?: unknown;
  requestId?: unknown;
  method?: unknown;
  args?: unknown;
}

/**
 * The bridge's `String(value || '')` coercion for untrusted primitives;
 * objects and arrays yield '' (never default '[object Object]' output).
 */
function bridgeString(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
}

/** Narrows an untrusted bridge value to a plain params object ({} otherwise). */
function bridgeParams(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** window CustomEvent name CodeAppRuntime.tsx dispatches (detail: CodeAppHostSurfaceEventDetail) and AppShell listens for. */
export const CODE_APP_HOST_SURFACE_EVENT = 'code-app-host-surface';
/** window CustomEvent name AppShell dispatches back (detail: CodeAppHostSurfaceClosedEventDetail) once the opened modal closes. */
export const CODE_APP_HOST_SURFACE_CLOSED_EVENT = 'code-app-host-surface-closed';

export interface CodeAppHostSurfaceEventDetail {
  requestId: string;
  dappId: string;
  surface: CodeAppHostSurface;
  params: Record<string, unknown>;
}

export interface CodeAppHostSurfaceClosedEventDetail {
  requestId: string;
}

export const CODE_APP_RELATIONSHIP_SURFACE_EVENT = 'code-app-relationship-surface';
export const CODE_APP_RELATIONSHIP_SURFACE_RESOLVED_EVENT = 'code-app-relationship-surface-resolved';

export type CodeAppRelationshipSurface = 'contactPicker' | 'contactInvite' | 'shareConsent';

/** What a Code App receives when a relationship surface closes without a choice. */
export function cancelledRelationshipSurfaceResult(surface: CodeAppRelationshipSurface): unknown {
  if (surface === 'contactPicker') return [];
  if (surface === 'shareConsent') return { confirmed: false };
  return null;
}


export interface CodeAppRelationshipSurfaceEventDetail {
  requestId: string;
  dappId: string;
  surface: CodeAppRelationshipSurface;
  params: Record<string, unknown>;
}

export interface CodeAppRelationshipSurfaceResolvedEventDetail {
  requestId: string;
  result: unknown;
}

interface CodeAppBridgeOptions {
  route: string;
  search?: string;
  chrome: CodeAppChromeMode;
  /** Host shell language ('en', 'de', …) — drives the app's $i18n dictionaries. */
  language?: string;
  onNavigate: (path: string) => void | Promise<void>;
  onSetChrome: (mode: CodeAppChromeMode) => void | Promise<void>;
  onOpenHostSurface: (surface: CodeAppHostSurface, params: Record<string, unknown>) => Promise<{ opened: boolean }>;
  onOpenRelationshipSurface?: (surface: CodeAppRelationshipSurface, params: Record<string, unknown>) => Promise<unknown>;
}

export interface CodeAppBridge {
  setRoute: (path: string, search?: string) => void;
  setChrome: (mode: CodeAppChromeMode) => void;
  setLanguage: (language: string) => void;
  destroy: () => void;
}

async function contactHandleForRelationship(dappId: string, relationshipId: string): Promise<DappContactHandle> {
  const relationship = getRelationship(relationshipId);
  if (!relationship) throw new Error('Unknown contact relationship');
  const person = getPerson(relationship.personId);
  return {
    handle: await deriveDappContactHandle(dappId, relationship.id),
    displayName: person?.displayName || 'Contact',
    verified: Boolean(relationship.verifiedAt),
  };
}

async function shareParticipantView(dappId: string, share: ReturnType<typeof listChannelShares>[number]) {
  return {
    contact: await contactHandleForRelationship(dappId, share.relationshipId),
    status: share.status,
  };
}

async function listShareViews(dappId: string) {
  const shares = listChannelShares(dappId);
  const instances = new Map<string, typeof shares>();
  shares.forEach((share) => instances.set(share.instanceId, [...(instances.get(share.instanceId) ?? []), share]));
  return Promise.all(Array.from(instances.entries()).map(async ([instanceId, rows]) => ({
    shareId: rows[0]?.shareId ?? '',
    instanceId,
    participants: await Promise.all(rows.map((row) => shareParticipantView(dappId, row))),
    createdAt: rows[0]?.createdAt ?? '',
  })));
}

function readManifest(dappId: string): CodeAppManifest | null {
  // Permissions come from the owner-sealed manifest — the one belonging to the code that runs —
  // never from whatever a member wrote into the synced source (sourceSeal.ts).
  const result = parseCodeAppManifest(getRunnableCodeAppFile(dappId, 'manifest.yaml'));
  return result.error ? null : result.manifest;
}

/** An absolute http(s) URL from an untrusted sandbox value; null for everything else. */
function externalLinkOf(candidate: unknown): URL | null {
  if (typeof candidate !== 'string' || candidate.length > 4096) return null;
  try {
    const url = new URL(candidate.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null; // https://bank.example@evil.test reads like the wrong host
    return url;
  } catch {
    return null;
  }
}

/** The parsed manifest, provided it grants the named host permission. */
function requireHostPermission(dappId: string, permission: keyof CodeAppHostPermissions, denied: string): CodeAppManifest {
  const manifest = readManifest(dappId);
  if (manifest?.permissions?.host?.[permission] !== true) throw new Error(denied);
  return manifest;
}

/** Relationship behind an untrusted `{ handle }` value from the sandbox; null when unknown or stale. */
function relationshipIdOf(dappId: string, candidate: unknown): string | null {
  const handle = bridgeString(bridgeParams(candidate).handle);
  return handle ? resolveDappContactHandle(dappId, handle) : null;
}

/** Declared bindings for the given ids, in id order; missing ids are dropped. */
function pickBindings(ids: string[], declared: CodeAppBindingDeclaration[] | undefined): CodeAppBindingDeclaration[] {
  return ids.flatMap((id) => {
    const binding = declared?.find((entry) => entry.id === id);
    return binding ? [binding] : [];
  });
}

export function attachCodeAppBridge(
  iframe: HTMLIFrameElement,
  dappId: string,
  role: MemberRole | null,
  runtimeId: string,
  options: CodeAppBridgeOptions,
): CodeAppBridge {
  const dataSubscriptions = new Set<string>();
  const storeSubscriptions = new Map<string, StoreSubscription>();
  const actionRegistrations = new Map<string, () => void>();
  const dbSubscriptionCleanups = new Map<string, () => void>();
  const pendingActions = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const doc = getDappDoc(dappId);
  // Bounded: when the local database never opens, the app still starts (in memory, with the
  // shell's storage warning) instead of every bridge call waiting forever.
  const localDataReady = whenLocalCopyLoaded(getDappPersistence(dappId));
  const appData = doc.getMap('appData');
  const entityData = doc.getMap('data');
  // Pending subscription refresh: which `data` collections changed, whether
  // `appData` changed, and the last result posted per subscription (so an
  // unchanged result is not posted again).
  const changedEntityIds = new Set<string>();
  const lastSentResults = new Map<string, string | null>();
  let appDataChanged = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let currentRoute = normalizeCodeAppRoutePath(options.route);
  let currentSearch = options.search || '';
  let currentChrome: CodeAppChromeMode = options.chrome;
  let currentLanguage = options.language || 'en';
  /** Host-dialog wording in the shell language (this module has no React context). */
  const hostText = (key: string): string => (currentLanguage.toLowerCase().startsWith('de') ? de[key] ?? key : key);
  let hostSurfaceOpen = false;
  let camera: CodeAppCamera | null = null;
  let destroyed = false;
  let lastHostSurfaceOpenAt = 0;
  const writeCalls = createTokenBucket(
    () => CODE_APP_BRIDGE_LIMITS.writeBurst, () => CODE_APP_BRIDGE_LIMITS.writeRefillPerSecond / 1000,
  );
  const readCalls = createTokenBucket(
    () => CODE_APP_BRIDGE_LIMITS.readBurst, () => CODE_APP_BRIDGE_LIMITS.readRefillPerSecond / 1000,
  );
  const writeBytes = createTokenBucket(
    () => CODE_APP_BRIDGE_LIMITS.writeBytesPerMinute, () => CODE_APP_BRIDGE_LIMITS.writeBytesPerMinute / 60_000,
  );
  let limitWarned = false;

  /**
   * Charges one bridge call against this runtime's buckets (and a `$files.add`
   * against the dapp's session budget) — over the limit it throws a
   * CodeAppBridgeError the app receives, never a silent drop. Returns a refund
   * of the `$files` budget for when the add itself fails.
   */
  const admit = (method: string, args: unknown[]): (() => void) | null => {
    const reject = (error: CodeAppBridgeError): never => {
      if (!limitWarned) {
        limitWarned = true;
        console.warn(`Code App ${dappId}: bridge limit reached (${error.code}); further rejections of this runtime are not logged.`, error.message);
      }
      throw error;
    };
    if (!CODE_APP_WRITE_METHODS.has(method)) {
      const wait = readCalls.waitFor(1);
      if (wait > 0) reject(new CodeAppBridgeError('rate_limited', `Too many Code App requests, retry in ${wait} ms`, wait));
      readCalls.take(1);
      return null;
    }
    const callWait = writeCalls.waitFor(1);
    if (callWait > 0) reject(new CodeAppBridgeError('rate_limited', `Too many writes, retry in ${callWait} ms`, callWait));
    const bytes = writePayloadBytes(method, args);
    if (bytes > CODE_APP_BRIDGE_LIMITS.writeBytesPerMinute) {
      reject(new CodeAppBridgeError('quota_exceeded', `Write payload exceeds the ${CODE_APP_BRIDGE_LIMITS.writeBytesPerMinute}-byte per-minute budget`));
    }
    const byteWait = bytes > 0 ? writeBytes.waitFor(bytes) : 0;
    if (byteWait > 0) reject(new CodeAppBridgeError('rate_limited', `Write volume limit reached, retry in ${byteWait} ms`, byteWait));
    let refund: (() => void) | null = null;
    if (method === 'files.add') {
      const fileBytes = filesAddBytes(args);
      const used = filesBytesUsed.get(dappId) ?? 0;
      if (used + fileBytes > CODE_APP_BRIDGE_LIMITS.filesBytesPerSession) {
        reject(new CodeAppBridgeError(
          'quota_exceeded',
          `$files.add: an app may add ${CODE_APP_BRIDGE_LIMITS.filesBytesPerSession} bytes per session (${used} used); reload to continue`,
        ));
      }
      filesBytesUsed.set(dappId, used + fileBytes);
      refund = () => filesBytesUsed.set(dappId, Math.max(0, (filesBytesUsed.get(dappId) ?? 0) - fileBytes));
    }
    writeCalls.take(1);
    if (bytes > 0) writeBytes.take(bytes);
    return refund;
  };

  const send = (message: Record<string, unknown>) => {
    if (destroyed) return;
    iframe.contentWindow?.postMessage({ __codeApp: true, runtimeId, ...message }, '*');
  };

  const sendContext = () => {
    const config = getDappConfig(dappId);
    const identity = getIdentity();
    const manifest = readManifest(dappId);
    const roles = manifest?.roles ?? [];
    const permissions = manifest?.permissions;
    const resolvedAppRole = identity ? getAppRole(dappId, identity.publicKey) : null;
    const appRoleDeclaration = resolvedAppRole ? roles.find((declared) => declared.id === resolvedAppRole.roleId) ?? null : null;
    send({
      type: 'init',
      route: currentRoute,
      search: currentSearch,
      context: {
        dappId,
        route: currentRoute,
        search: currentSearch,
        chrome: currentChrome,
        language: currentLanguage,
        meta: config?.meta || null,
        entities: config?.schema?.entities || [],
        role,
        identity: identity ? { publicKey: identity.publicKey, displayName: identity.displayName } : null,
        roles,
        appRole: appRoleDeclaration
          ? { id: appRoleDeclaration.id, label: appRoleDeclaration.label, extends: appRoleDeclaration.extends }
          : null,
        // What the manifest granted, normalized so apps can read it without
        // null checks — e.g. the origins the sandbox CSP lets them fetch from.
        permissions: {
          network: {
            connect: [...(permissions?.network?.connect ?? [])],
            images: [...(permissions?.network?.images ?? [])],
          },
          host: { ...(permissions?.host ?? {}) },
          device: { ...(permissions?.device ?? {}) },
        },
      },
    });
  };

  const storeQuery = (entity: string, filter?: Record<string, unknown>) =>
    handleStoreOperation(dappId, 'query', [entity, filter]);

  /** Posts a subscription result unless it equals the last one posted for that subscription. */
  const sendIfChanged = (subscriptionId: string, message: Record<string, unknown>, result: unknown) => {
    const serialized = serializeSubscriptionResult(result);
    if (serialized !== null && lastSentResults.get(subscriptionId) === serialized) return;
    lastSentResults.set(subscriptionId, serialized);
    send(message);
  };

  const refreshSubscriptions = () => {
    refreshTimer = null;
    const entityIds = new Set(changedEntityIds);
    changedEntityIds.clear();
    const refreshData = appDataChanged;
    appDataChanged = false;

    if (refreshData && dataSubscriptions.size > 0) {
      const snapshot = getCodeAppDataSnapshot(dappId);
      dataSubscriptions.forEach((subscriptionId) => {
        sendIfChanged(subscriptionId, { type: 'data-changed', subscriptionId, data: snapshot }, snapshot);
      });
    }
    if (entityIds.size === 0) return;
    void Promise.all([...storeSubscriptions.entries()].map(async ([subscriptionId, subscription]) => {
      try {
        // Only collections that changed are scanned again. A name that does
        // not resolve falls through to the query, which reports the error.
        let collectionId: string | null = null;
        try { collectionId = resolveStoreCollectionId(dappId, subscription.entity); } catch { /* reported by the query below */ }
        if (collectionId !== null && !entityIds.has(collectionId)) return;
        const records = await storeQuery(subscription.entity, subscription.filter);
        if (storeSubscriptions.get(subscriptionId) !== subscription) return;
        sendIfChanged(subscriptionId, { type: 'store-changed', subscriptionId, records }, records);
      } catch (error) {
        console.warn('Code App subscription refresh failed', error);
      }
    }));
  };

  // Trailing debounce without a reset: the first change opens the window, so a
  // chatty peer cannot postpone the refresh indefinitely.
  const scheduleRefresh = () => {
    refreshTimer ??= setTimeout(refreshSubscriptions, SUBSCRIPTION_REFRESH_DEBOUNCE_MS);
  };

  const handleAppDataChange = () => {
    appDataChanged = true;
    scheduleRefresh();
  };

  /** Top-level keys of `data` are collection ids: a nested event names its collection first in the path. */
  const handleEntityDataChange = (events: DataChangeEvent[]) => {
    events.forEach((event) => {
      if (event.path.length > 0) changedEntityIds.add(String(event.path[0]));
      else event.keys.forEach((_change, key) => changedEntityIds.add(key));
    });
    scheduleRefresh();
  };

  const processMessage = async (event: MessageEvent) => {
    const data: unknown = event.data;
    if (event.source !== iframe.contentWindow || typeof data !== 'object' || data === null) return;
    const message = data as CodeAppBridgeEnvelope;
    if (!message.__codeApp || message.runtimeId !== runtimeId) return;
    if (message.type === 'ready') {
      sendContext();
      return;
    }
    if (message.type === 'action-result' && typeof message.deliveryId === 'string') {
      const pending = pendingActions.get(message.deliveryId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingActions.delete(message.deliveryId);
      if (message.error) pending.reject(new Error(bridgeString(message.error)));
      else pending.resolve();
      return;
    }
    if (message.type !== 'request' || typeof message.requestId !== 'string') return;

    const respond = (result?: unknown, error?: unknown) => send({
      type: 'response',
      requestId: message.requestId,
      ...(error ? {
        error: error instanceof Error ? error.message : bridgeString(error),
        ...(error instanceof Error && error.name !== 'Error' ? { errorName: error.name } : {}),
      } : { result }),
      ...(error instanceof CodeAppBridgeError
        ? { code: error.code, ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) }
        : {}),
    });

    let refundFilesBudget: (() => void) | null = null;
    try {
      const method = bridgeString(message.method);
      const args: unknown[] = Array.isArray(message.args) ? message.args : [];
      // First of all: a flood is rejected without waiting for storage.
      refundFilesBudget = admit(method, args);
      // Do not expose an empty snapshot or accept writes until IndexedDB has
      // restored the main Yjs document. Otherwise an app can overwrite its
      // persisted values with defaults during refresh.
      if (method !== 'router.navigate' && method !== 'router.setChrome' && method !== 'ui.open' && !method.startsWith('db.') && !method.startsWith('camera.')) await localDataReady;
      if (destroyed) return;
      const isWrite = ['data.set', 'data.delete', 'store.create', 'store.update', 'store.delete'].includes(method);
      if (isWrite && role === 'viewer') throw new Error('Write access requires editor or owner role');

      let result: unknown;
      switch (method) {
        case 'camera.start':
        case 'camera.frame': {
          camera ??= new CodeAppCamera(() => readManifest(dappId)?.permissions?.device?.camera === true);
          result = method === 'camera.start' ? await camera.start(args[0]) : await camera.frame();
          break;
        }
        case 'camera.stop': {
          camera?.stop();
          result = { stopped: true };
          break;
        }
        case 'router.navigate': {
          const { path, search } = splitCodeAppNavigationTarget(bridgeString(args[0]));
          await options.onNavigate(path + search);
          result = { path };
          break;
        }
        case 'router.setChrome': {
          const mode = args[0] === 'standard' ? 'standard' : args[0] === 'fullscreen' ? 'fullscreen' : null;
          if (!mode) throw new Error('router.setChrome requires "standard" or "fullscreen"');
          await options.onSetChrome(mode);
          result = { chrome: mode };
          break;
        }
        case 'ui.open': {
          const surface: CodeAppHostSurface | null = args[0] === 'codeEditor' ? 'codeEditor' : args[0] === 'settings' ? 'settings' : null;
          if (!surface) throw new Error(`Unknown host surface: ${bridgeString(args[0])}`);
          const params = bridgeParams(args[1]);
          requireHostPermission(dappId, surface, 'Host surface not permitted by manifest');
          if (surface === 'codeEditor' && role !== 'owner') throw new Error('Only the dapp owner can open the code editor');
          if (hostSurfaceOpen || Date.now() - lastHostSurfaceOpenAt < HOST_SURFACE_MIN_INTERVAL_MS) {
            result = { opened: false };
            break;
          }
          hostSurfaceOpen = true;
          lastHostSurfaceOpenAt = Date.now();
          try {
            result = await options.onOpenHostSurface(surface, params);
          } finally {
            hostSurfaceOpen = false;
          }
          break;
        }
        case 'ui.openLink': {
          const url = externalLinkOf(args[0]);
          if (!url) throw new Error('$ui.openLink only opens http(s) links');
          // Same throttle as host surfaces: script can call this without a click, and must
          // not be able to stack dialogs.
          if (hostSurfaceOpen || Date.now() - lastHostSurfaceOpenAt < HOST_SURFACE_MIN_INTERVAL_MS) {
            result = { opened: false };
            break;
          }
          hostSurfaceOpen = true;
          try {
            const confirmed = await showConfirm(
              `${hostText('This app wants to open an external page in a new tab:')}\n\n${url.href}\n\n${hostText('Only continue if you trust this address. Anything the app put into the link is sent to that site.')}`,
              { title: `${hostText('Open')} ${url.host}?`, confirmLabel: hostText('Open link') },
            );
            if (confirmed) window.open(url.href, '_blank', 'noopener,noreferrer');
            result = { opened: confirmed };
          } finally {
            hostSurfaceOpen = false;
            lastHostSurfaceOpenAt = Date.now();
          }
          break;
        }
        case 'data.get': result = getCodeAppData(dappId, args[0] as string); break;
        case 'data.set': setCodeAppData(dappId, args[0] as string, args[1]); result = { success: true }; break;
        case 'data.delete': deleteCodeAppData(dappId, args[0] as string); result = { success: true }; break;
        case 'data.snapshot': result = getCodeAppDataSnapshot(dappId); break;
        case 'data.subscribe': {
          if (dataSubscriptions.size + storeSubscriptions.size >= MAX_SUBSCRIPTIONS) throw new Error('Subscription limit reached');
          dataSubscriptions.add(args[0] as string);
          // The first result stays immediate: it is this response, not a debounced post.
          result = getCodeAppDataSnapshot(dappId);
          lastSentResults.set(args[0] as string, serializeSubscriptionResult(result));
          break;
        }
        case 'data.unsubscribe': {
          dataSubscriptions.delete(args[0] as string);
          lastSentResults.delete(args[0] as string);
          result = { success: true };
          break;
        }
        case 'events.publish': {
          const eventId = bridgeString(args[0]);
          const direct = await getDirectCodeBindingRuntime().publishDirectEvent(dappId, eventId, args[1]);
          const publishOptions = bridgeParams(args[2]);
          const instanceId = typeof publishOptions.instanceId === 'string' ? publishOptions.instanceId : null;
          const shared = instanceId
            ? await getChannelBindingRuntime().publishChannelEvent(dappId, eventId, args[1], instanceId)
            : [];
          result = { direct, shared };
          break;
        }
        case 'contacts.pick': {
          requireHostPermission(dappId, 'contacts', 'Contact picker not permitted by manifest');
          if (!options.onOpenRelationshipSurface) throw new Error('Contact picker is unavailable');
          const requested = bridgeParams(args[0]);
          const min = Math.max(0, Math.min(16, Number.isInteger(requested.min) ? Number(requested.min) : 0));
          const max = Math.max(min, Math.min(16, Number.isInteger(requested.max) ? Number(requested.max) : 16));
          const picked = await options.onOpenRelationshipSurface('contactPicker', {
            label: typeof requested.label === 'string' ? requested.label.slice(0, 120) : '', min, max,
          });
          if (!Array.isArray(picked)) { result = []; break; }
          const selected: DappContactHandle[] = [];
          for (const candidate of picked.slice(0, max)) {
            const relationshipId = relationshipIdOf(dappId, candidate);
            if (!relationshipId) continue;
            selected.push(await contactHandleForRelationship(dappId, relationshipId));
          }
          result = selected.length >= min ? selected : [];
          break;
        }
        case 'contacts.invite': {
          requireHostPermission(dappId, 'contacts', 'Contact invite not permitted by manifest');
          if (!options.onOpenRelationshipSurface) throw new Error('Contact invite is unavailable');
          const relationshipId = relationshipIdOf(dappId, await options.onOpenRelationshipSurface('contactInvite', {}));
          result = relationshipId ? await contactHandleForRelationship(dappId, relationshipId) : null;
          break;
        }
        case 'share.open': {
          const manifest = requireHostPermission(dappId, 'sharing', 'Channel sharing not permitted by manifest');
          if (!options.onOpenRelationshipSurface) throw new Error('Channel sharing is unavailable');
          const input = bridgeParams(args[0]);
          const shareId = bridgeString(input.shareId);
          const declaration = manifest.channels?.shares?.find((entry) => entry.id === shareId);
          if (!declaration) throw new Error(`Undeclared channel share: ${shareId}`);
          if (!Array.isArray(input.contacts) || input.contacts.length === 0) throw new Error('$share.open requires at least one selected contact');
          if (input.contacts.length > (declaration.maxParticipants ?? 16)) throw new Error('Channel share participant limit exceeded');
          const events = pickBindings(declaration.events, manifest.bindings?.events);
          const actions = pickBindings(declaration.actions, manifest.bindings?.actions);
          if (events.length !== declaration.events.length || actions.length !== declaration.actions.length) {
            throw new Error('Share declarations no longer match the current manifest bindings');
          }
          const contacts: Array<{ handle: DappContactHandle; relationshipId: string }> = [];
          for (const candidate of input.contacts) {
            const relationshipId = relationshipIdOf(dappId, candidate);
            if (!relationshipId) throw new Error('Unknown or stale contact handle');
            if (!contacts.some((entry) => entry.relationshipId === relationshipId)) {
              contacts.push({ handle: await contactHandleForRelationship(dappId, relationshipId), relationshipId });
            }
          }
          const consent = await options.onOpenRelationshipSurface('shareConsent', {
            shareId, shareLabel: declaration.label, contacts: contacts.map((entry) => entry.handle), events, actions,
          });
          if (!consent || typeof consent !== 'object' || (consent as Record<string, unknown>).confirmed !== true) {
            result = { shareId, instanceId: null, participants: [] };
            break;
          }
          const config = getDappConfig(dappId);
          if (!config) throw new Error('Dapp configuration is unavailable');
          // Reuse before re-invite: a contact who already holds a channel for this
          // shareId must not be prompted again — later shares queue onto the same
          // channel. Pick the instance already covering the most selected contacts
          // (newest on a tie); only contacts not yet on it get a fresh signed offer.
          const shareRows = listChannelShares(dappId)
            .filter((row) => row.shareId === shareId && row.status !== 'revoked');
          const rowsByContact = new Map(contacts.flatMap((contact) => {
            const newest = shareRows
              .filter((row) => row.relationshipId === contact.relationshipId)
              .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
            return newest ? [[contact.relationshipId, newest] as const] : [];
          }));
          const instanceVotes = new Map<string, { count: number; newest: string }>();
          for (const row of rowsByContact.values()) {
            const vote = instanceVotes.get(row.instanceId) ?? { count: 0, newest: '' };
            vote.count += 1;
            if (row.createdAt > vote.newest) vote.newest = row.createdAt;
            instanceVotes.set(row.instanceId, vote);
          }
          const reusedInstanceId = [...instanceVotes.entries()]
            .sort((left, right) => right[1].count - left[1].count || right[1].newest.localeCompare(left[1].newest))[0]?.[0];
          const instanceId = reusedInstanceId ?? crypto.randomUUID();
          const { createChannelShare } = await import('./browserRelationshipRuntime');
          const participants = await Promise.all(contacts.map(async (contact) => {
            const existing = rowsByContact.get(contact.relationshipId);
            if (existing && existing.instanceId === instanceId) {
              return { contact: contact.handle, status: existing.status === 'active' ? 'accepted' as const : 'pending' as const };
            }
            const outcome = await createChannelShare({
              dappId, relationshipId: contact.relationshipId, shareId, shareLabel: declaration.label, instanceId,
              dappMeta: { name: config.meta.name, icon: config.meta.icon, color: config.meta.color }, events, actions,
              routes: declaration.routes, attachDefinition: role === 'owner',
              // Never block the app on the recipient's accept: the offer and the
              // pending share row are durable, activation runs via the control-room
              // scan, and channel deliveries queue until then.
              waitForResponse: false,
            });
            return { contact: contact.handle, status: outcome.status };
          }));
          result = { shareId, instanceId, participants };
          break;
        }
        case 'share.list': {
          requireHostPermission(dappId, 'sharing', 'Channel sharing not permitted by manifest');
          result = await listShareViews(dappId);
          break;
        }
        case 'share.participants': {
          requireHostPermission(dappId, 'sharing', 'Channel sharing not permitted by manifest');
          const rows = listChannelSharesByInstance(dappId, bridgeString(args[0]));
          result = await Promise.all(rows.map((row) => shareParticipantView(dappId, row)));
          break;
        }
        case 'share.close':
        case 'share.leave': {
          requireHostPermission(dappId, 'sharing', 'Channel sharing not permitted by manifest');
          // Pending offers count too: leaving them behind meant a "closed" share that a
          // contact could still accept.
          const rows = listChannelSharesByInstance(dappId, bridgeString(args[0])).filter((row) => row.status !== 'revoked');
          if (rows.length === 0) {
            result = { success: true, revoked: 0 };
            break;
          }
          // Opening a share needs the person's consent — so does ending it for everyone.
          const names = await Promise.all(rows.map(async (row) => (await contactHandleForRelationship(dappId, row.relationshipId)).displayName));
          const confirmed = await showConfirm(
            `${hostText('This app wants to stop sharing with:')}\n\n${[...new Set(names)].join(', ')}\n\n${hostText('They keep what they already received, but get no further updates.')}`,
            { title: hostText('Stop sharing?'), confirmLabel: hostText('Stop sharing'), danger: true },
          );
          if (!confirmed) {
            result = { success: false, revoked: 0 };
            break;
          }
          const { revokeChannelShareParticipant } = await import('./browserRelationshipRuntime');
          await Promise.all(rows.map((row) => revokeChannelShareParticipant(row)));
          result = { success: true, revoked: rows.length };
          break;
        }
        case 'actions.register': {
          const actionId = bridgeString(args[0]);
          actionRegistrations.get(actionId)?.();
          const deliver = (delivery: { id: string; payload: unknown; from?: DappContactHandle; instanceId?: string }) => new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              pendingActions.delete(delivery.id);
              reject(new Error('Code App action timed out'));
            }, 10_000);
            pendingActions.set(delivery.id, { resolve, reject, timer });
            send({
              type: 'action-delivery', deliveryId: delivery.id, actionId, payload: delivery.payload,
              context: { from: delivery.from ?? null, instanceId: delivery.instanceId ?? null },
            });
          });
          const unregisterDirect = getDirectCodeBindingRuntime().registerActionRuntime(
            dappId, runtimeId, actionId, (delivery) => deliver({ id: delivery.id, payload: delivery.payload }),
          );
          const unregisterChannel = getChannelBindingRuntime().registerActionRuntime(dappId, runtimeId, actionId, deliver);
          actionRegistrations.set(actionId, () => { unregisterDirect(); unregisterChannel(); });
          result = { success: true };
          break;
        }
        case 'actions.unregister': {
          const actionId = bridgeString(args[0]);
          actionRegistrations.get(actionId)?.();
          actionRegistrations.delete(actionId);
          result = { success: true };
          break;
        }
        case 'store.subscribe': {
          if (dataSubscriptions.size + storeSubscriptions.size >= MAX_SUBSCRIPTIONS) throw new Error('Subscription limit reached');
          const entity = args[0] as string;
          const filter = args[1] as Record<string, unknown> | undefined;
          storeSubscriptions.set(args[2] as string, { entity, filter });
          // The first result stays immediate: it is this response, not a debounced post.
          result = await storeQuery(entity, filter);
          lastSentResults.set(args[2] as string, serializeSubscriptionResult(result));
          break;
        }
        case 'store.unsubscribe': {
          storeSubscriptions.delete(args[0] as string);
          lastSentResults.delete(args[0] as string);
          result = { success: true };
          break;
        }
        case 'db.query': {
          result = getReadModel(dappId).query(sanitizeCollectionName(args[0]), sanitizeQueryOptions(args[1]));
          break;
        }
        case 'db.get': {
          const requestedId = typeof args[1] === 'string' ? args[1] : '';
          result = getReadModel(dappId).get(sanitizeCollectionName(args[0]), requestedId);
          break;
        }
        case 'db.count': {
          const countOptions = sanitizeQueryOptions(args[1]);
          result = getReadModel(dappId).count(sanitizeCollectionName(args[0]), { index: countOptions.index, range: countOptions.range });
          break;
        }
        case 'db.subscribe': {
          if (dataSubscriptions.size + storeSubscriptions.size + dbSubscriptionCleanups.size >= MAX_SUBSCRIPTIONS) throw new Error('Subscription limit reached');
          const collection = sanitizeCollectionName(args[0]);
          const subscriptionId = typeof args[1] === 'string' ? args[1] : '';
          if (!subscriptionId) throw new Error('$db.subscribe requires a subscription id');
          dbSubscriptionCleanups.get(subscriptionId)?.();
          dbSubscriptionCleanups.set(subscriptionId, getReadModel(dappId).subscribe(collection, () => {
            send({ type: 'db-changed', subscriptionId });
          }));
          result = { success: true };
          break;
        }
        case 'db.unsubscribe': {
          const subscriptionId = typeof args[0] === 'string' ? args[0] : '';
          dbSubscriptionCleanups.get(subscriptionId)?.();
          dbSubscriptionCleanups.delete(subscriptionId);
          result = { success: true };
          break;
        }
        case 'files.list':
        case 'files.find':
        case 'files.get':
        case 'files.add':
        case 'files.delete': {
          requireHostPermission(dappId, 'files', 'File access not permitted by manifest');
          const filesWrite = method === 'files.add' || method === 'files.delete';
          if (filesWrite && role !== 'owner' && role !== 'editor') {
            throw new Error('Write access requires editor or owner role');
          }
          result = await handleFilesOperation(dappId, method.slice('files.'.length), args);
          break;
        }
        case 'roles.assignments': {
          if (role === null || role === 'viewer') throw new Error('Viewing app role assignments requires editor or owner access');
          result = listAppRoleAssignments(dappId);
          break;
        }
        case 'roles.assign': {
          if (role !== 'owner') throw new Error('Only the dapp owner can assign app roles');
          const targetPublicKey = bridgeString(args[0]);
          const roleId = bridgeString(args[1]);
          if (!readManifest(dappId)?.roles?.some((declaredRole) => declaredRole.id === roleId)) {
            throw new Error(`Undeclared app role: ${roleId}`);
          }
          await assignAppRole(dappId, targetPublicKey, roleId);
          result = { success: true };
          break;
        }
        default: {
          if (!method.startsWith('store.')) throw new Error(`Unknown Code App method: ${method}`);
          result = await handleStoreOperation(dappId, method.slice('store.'.length), args);
        }
      }
      respond(result);
    } catch (error) {
      refundFilesBudget?.();
      respond(undefined, error);
    }
  };

  // Keep the listener itself synchronous: the returned promise is intentionally
  // detached (every request path resolves through respond()).
  const handleMessage = (event: MessageEvent) => { void processMessage(event); };
  window.addEventListener('message', handleMessage);
  appData.observeDeep(handleAppDataChange);
  entityData.observeDeep(handleEntityDataChange);
  iframe.addEventListener('load', sendContext);

  return {
    setRoute(path: string, search = '') {
      const normalized = normalizeCodeAppRoutePath(path);
      if (normalized === currentRoute && search === currentSearch) return;
      currentRoute = normalized;
      currentSearch = search;
      send({ type: 'route-changed', route: currentRoute, search: currentSearch });
    },
    setChrome(mode: CodeAppChromeMode) {
      if (mode === currentChrome) return;
      currentChrome = mode;
      send({ type: 'chrome-changed', chrome: currentChrome });
    },
    setLanguage(language: string) {
      if (!language || language === currentLanguage) return;
      currentLanguage = language;
      send({ type: 'language-changed', language: currentLanguage });
    },
    destroy() {
      destroyed = true;
      camera?.destroy();
      actionRegistrations.forEach((unregister) => unregister());
      dbSubscriptionCleanups.forEach((cleanup) => cleanup());
      dbSubscriptionCleanups.clear();
      pendingActions.forEach(({ reject, timer }) => { clearTimeout(timer); reject(new Error('Code App runtime closed')); });
      pendingActions.clear();
      window.removeEventListener('message', handleMessage);
      appData.unobserveDeep(handleAppDataChange);
      entityData.unobserveDeep(handleEntityDataChange);
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = null;
      iframe.removeEventListener('load', sendContext);
    },
  };
}
