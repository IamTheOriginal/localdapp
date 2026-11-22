// @vitest-environment happy-dom

// Review 3.5: the Code App bridge rate-limits writes, bounds write volume and
// caps `$files` uploads per dapp and session — with a structured error the app
// receives, never a silent drop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCodeAppFile: vi.fn(() => ''),
  handleStoreOperation: vi.fn((): Promise<unknown> => Promise.resolve({ id: 'r1' })),
  handleFilesOperation: vi.fn((): Promise<unknown> => Promise.resolve({ id: 'f1' })),
  setCodeAppData: vi.fn(),
}));

const observable = { observeDeep: vi.fn(), unobserveDeep: vi.fn() };

vi.mock('../services/store', () => ({
  getDappDoc: vi.fn(() => ({ getMap: vi.fn(() => observable) })),
  getDappPersistence: vi.fn(() => ({ whenSynced: Promise.resolve() })),
  getCodeAppData: vi.fn(() => null),
  getCodeAppDataSnapshot: vi.fn(() => ({})),
  getDappConfig: vi.fn(() => null),
  setCodeAppData: mocks.setCodeAppData,
  deleteCodeAppData: vi.fn(),
  getAppRole: vi.fn(() => null),
  assignAppRole: vi.fn(),
  listAppRoleAssignments: vi.fn(() => []),
}));
vi.mock('../services/identity', () => ({ getIdentity: vi.fn(() => null) }));
vi.mock('../services/codeAppStoreBridge.ts', () => ({
  handleStoreOperation: mocks.handleStoreOperation,
  resolveStoreCollectionId: vi.fn((_dappId: string, nameOrId: string) => nameOrId),
}));
vi.mock('../services/codeAppFilesBridge.ts', () => ({ handleFilesOperation: mocks.handleFilesOperation }));
vi.mock('../services/store/sourceSeal.ts', () => ({ getRunnableCodeAppFile: mocks.getCodeAppFile }));

import {
  attachCodeAppBridge,
  CODE_APP_BRIDGE_LIMITS,
  CODE_APP_WRITE_METHODS,
  resetCodeAppFilesBudgets,
} from '../services/codeAppRuntime.ts';

const DEFAULT_LIMITS = { ...CODE_APP_BRIDGE_LIMITS };

class FakeIframe extends EventTarget {
  posted: Array<Record<string, unknown>> = [];
  contentWindow = { postMessage: (message: Record<string, unknown>) => this.posted.push(message) };
}

let counter = 0;
const bridges: Array<{ destroy: () => void }> = [];

function attach(dappId = 'limits-app', runtimeId = `runtime-${++counter}`) {
  const iframe = new FakeIframe();
  bridges.push(attachCodeAppBridge(iframe as unknown as HTMLIFrameElement, dappId, 'owner', runtimeId, {
    route: '/', chrome: 'standard', onNavigate: vi.fn(), onSetChrome: vi.fn(), onOpenHostSurface: vi.fn(() => Promise.resolve({ opened: true })),
  }));
  const call = async (method: string, args: unknown[] = []) => {
    const requestId = `req-${++counter}`;
    const event = new MessageEvent('message', { data: { __codeApp: true, runtimeId, type: 'request', requestId, method, args } });
    Object.defineProperty(event, 'source', { value: iframe.contentWindow });
    window.dispatchEvent(event);
    await vi.advanceTimersByTimeAsync(0);
    return iframe.posted.find((message) => message.requestId === requestId);
  };
  return { iframe, call };
}

describe('Code App bridge limits', () => {
  let warn: { mockRestore: () => void } & ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal('window', new EventTarget());
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetCodeAppFilesBudgets();
    Object.assign(CODE_APP_BRIDGE_LIMITS, { writeBurst: 3, writeRefillPerSecond: 1, readBurst: 5, readRefillPerSecond: 1 });
  });

  afterEach(() => {
    bridges.splice(0).forEach((bridge) => bridge.destroy());
    Object.assign(CODE_APP_BRIDGE_LIMITS, DEFAULT_LIMITS);
    warn.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('ships sane defaults and classifies every dispatched write', () => {
    expect(DEFAULT_LIMITS).toEqual({
      writeBurst: 50, writeRefillPerSecond: 10, readBurst: 1000, readRefillPerSecond: 200,
      writeBytesPerMinute: 8 * 1024 * 1024, filesBytesPerSession: 512 * 1024 * 1024,
    });
    for (const method of ['data.set', 'data.delete', 'store.create', 'store.update', 'store.delete', 'files.add', 'files.delete', 'events.publish', 'share.open', 'share.close', 'share.leave', 'roles.assign']) {
      expect(CODE_APP_WRITE_METHODS.has(method), method).toBe(true);
    }
    for (const method of ['data.get', 'store.query', 'store.get', 'db.query', 'files.get', 'files.list']) {
      expect(CODE_APP_WRITE_METHODS.has(method), method).toBe(false);
    }
  });

  it('rejects a write burst with a structured rate_limited error and refills over time', async () => {
    const { call } = attach();
    for (let index = 0; index < 3; index += 1) {
      expect(await call('store.create', ['tasks', { n: index }])).toMatchObject({ result: { id: 'r1' } });
    }
    const rejected = await call('store.create', ['tasks', { n: 3 }]);
    expect(rejected).toMatchObject({ code: 'rate_limited', error: expect.stringMatching(/Too many writes/) as unknown });
    expect(rejected?.retryAfterMs).toBeGreaterThan(0);
    expect(mocks.handleStoreOperation).toHaveBeenCalledTimes(3);

    // Reads use their own bucket and still pass.
    expect(await call('data.get', ['key'])).not.toHaveProperty('error');

    await vi.advanceTimersByTimeAsync(1000);
    expect(await call('data.set', ['key', 1])).toMatchObject({ result: { success: true } });
    expect(await call('data.set', ['key', 2])).toMatchObject({ code: 'rate_limited' });
  });

  it('warns once per runtime, however often it rejects', async () => {
    const { call } = attach();
    for (let index = 0; index < 8; index += 1) await call('data.delete', ['key']);
    expect(warn).toHaveBeenCalledTimes(1);
    // A second runtime warns on its own.
    const other = attach();
    for (let index = 0; index < 5; index += 1) await other.call('data.delete', ['key']);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('limits reads with a separate, larger bucket', async () => {
    const { call } = attach();
    for (let index = 0; index < 5; index += 1) expect(await call('data.get', ['key'])).not.toHaveProperty('error');
    expect(await call('data.get', ['key'])).toMatchObject({ code: 'rate_limited' });
    // Writes are unaffected by an exhausted read bucket.
    expect(await call('data.set', ['key', 1])).toMatchObject({ result: { success: true } });
  });

  it('bounds the JSON write volume per minute', async () => {
    Object.assign(CODE_APP_BRIDGE_LIMITS, { writeBurst: 100, writeBytesPerMinute: 1000 });
    const { call } = attach();
    const payload = { text: 'x'.repeat(400) };
    expect(await call('store.create', ['tasks', payload])).toMatchObject({ result: { id: 'r1' } });
    expect(await call('store.update', ['tasks', 'r1', payload])).toMatchObject({ result: { id: 'r1' } });
    expect(await call('events.publish', ['evt', payload])).toMatchObject({ code: 'rate_limited', error: expect.stringMatching(/Write volume/) as unknown });
    // One payload bigger than the whole budget can never pass.
    expect(await call('data.set', ['key', { text: 'x'.repeat(2000) }])).toMatchObject({ code: 'quota_exceeded' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await call('store.create', ['tasks', payload])).toMatchObject({ result: { id: 'r1' } });
  });

  it('caps $files.add bytes per dapp per session, across runtimes, and refunds failed adds', async () => {
    mocks.getCodeAppFile.mockReturnValue(JSON.stringify({ routes: [{ path: '/', label: 'Home' }], permissions: { host: { files: true } } }));
    Object.assign(CODE_APP_BRIDGE_LIMITS, { writeBurst: 100, filesBytesPerSession: 1000 });
    const first = attach('files-app');
    expect(await first.call('files.add', [{ name: 'a', bytes: new ArrayBuffer(600) }])).toMatchObject({ result: { id: 'f1' } });

    mocks.handleFilesOperation.mockRejectedValueOnce(new Error('ingest failed'));
    expect(await first.call('files.add', [{ name: 'b', bytes: new ArrayBuffer(300) }])).toMatchObject({ error: 'ingest failed' });

    // Reopening the app does not reset the budget; the failed add was refunded.
    const second = attach('files-app');
    expect(await second.call('files.add', [{ name: 'c', bytes: new Uint8Array(400) }])).toMatchObject({ result: { id: 'f1' } });
    const over = await second.call('files.add', [{ name: 'd', bytes: new ArrayBuffer(1) }]);
    expect(over).toMatchObject({ code: 'quota_exceeded', error: expect.stringMatching(/per session/) as unknown });
    expect(over).not.toHaveProperty('retryAfterMs');
    expect(mocks.handleFilesOperation).toHaveBeenCalledTimes(3);

    // Another dapp has its own budget.
    const other = attach('other-files-app');
    expect(await other.call('files.add', [{ name: 'e', bytes: new ArrayBuffer(900) }])).toMatchObject({ result: { id: 'f1' } });
  });
});
