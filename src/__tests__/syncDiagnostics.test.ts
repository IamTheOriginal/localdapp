// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A device waking from sleep may hold dead data channels and a dead broker
 * socket without ever seeing a close event. The watchdog's job is to nudge the
 * member mesh the moment the page is usable again; the panel helper turns the
 * mesh status into per-document rows.
 */

const state = vi.hoisted(() => ({
  nudges: 0,
  dappPersistences: new Map<string, unknown>(),
  sourcePersistences: new Map<string, unknown>(),
}));

vi.mock('../services/store/docs.ts', () => ({
  dappPersistences: state.dappPersistences,
  sourcePersistences: state.sourcePersistences,
}));
vi.mock('../services/blobRoomManager.ts', () => ({
  nudgeBlobChannels: () => { state.nudges += 1; },
}));

const { startSyncWatchdog, getDappSyncDocs } = await import('../services/syncDiagnostics.ts');

function setVisibility(value: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
}

describe('sync watchdog', () => {
  let stop: () => void;

  beforeEach(() => {
    state.nudges = 0;
    setVisibility('visible');
    stop = startSyncWatchdog();
  });

  afterEach(() => stop());

  it('nudges the member mesh when the page wakes up', async () => {
    for (const [target, type] of [[window, 'online'], [window, 'focus'], [document, 'visibilitychange']] as const) {
      const before = state.nudges;
      target.dispatchEvent(new Event(type));
      await vi.waitFor(() => expect(state.nudges, type).toBe(before + 1));
    }
  });

  it('stays quiet while the page is hidden', async () => {
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.nudges).toBe(0);
  });

  it('is a singleton and stops listening once stopped', async () => {
    expect(startSyncWatchdog()).toBe(stop);
    stop();
    window.dispatchEvent(new Event('online'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.nudges).toBe(0);
  });
});

describe('getDappSyncDocs', () => {
  beforeEach(() => {
    state.dappPersistences.clear();
    state.sourcePersistences.clear();
  });

  it('reports zero traffic and unloaded storage while the mesh is not open', () => {
    const rows = getDappSyncDocs('d1', { active: false, brokerConnected: false, brokerUrl: null, brokers: [], peers: [], docs: null });
    expect(rows).toEqual([
      { label: 'data', sent: 0, received: 0, lastSentAt: null, lastReceivedAt: null, persistenceSynced: false },
      { label: 'source', sent: 0, received: 0, lastSentAt: null, lastReceivedAt: null, persistenceSynced: false },
    ]);
  });

  it('maps mesh traffic onto the data and source documents with their storage state', () => {
    state.dappPersistences.set('dapp-d1', { synced: true });
    state.sourcePersistences.set('dapp-d1-source-v1', { synced: false });
    const rows = getDappSyncDocs('d1', {
      active: true,
      brokerConnected: true,
      brokerUrl: 'wss://signal.example',
      brokers: [{ url: 'wss://signal.example', connected: true }],
      peers: [],
      docs: {
        main: { sent: 3, received: 5, lastSentAt: 10, lastReceivedAt: 20 },
        source: { sent: 1, received: 0, lastSentAt: 30, lastReceivedAt: null },
      },
    });
    expect(rows).toEqual([
      { label: 'data', sent: 3, received: 5, lastSentAt: 10, lastReceivedAt: 20, persistenceSynced: true },
      { label: 'source', sent: 1, received: 0, lastSentAt: 30, lastReceivedAt: null, persistenceSynced: false },
    ]);
  });
});
