// @vitest-environment happy-dom

// The $share handler path reaches getRootDoc() → IndexeddbPersistence; without
// an indexedDB global its open rejects as an unhandled error after the tests.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  persistenceReady: Promise.resolve(),
  getSnapshot: vi.fn(() => ({ items: ['persisted'] })),
  publishEvent: vi.fn(() => Promise.resolve({ deliveryIds: ['delivery-1'] })),
  registerAction: vi.fn(() => vi.fn()),
  publishChannelEvent: vi.fn(() => Promise.resolve(['channel-delivery-1'])),
  registerChannelAction: vi.fn(() => vi.fn()),
  createChannelShare: vi.fn(() => Promise.resolve({ status: 'accepted' as const })),
  revokeChannelShareParticipant: vi.fn<(share: { id: string }) => Promise<void>>(() => Promise.resolve()),
  deriveContactHandle: vi.fn((_dappId: string, relationshipId: string) => Promise.resolve(`handle-${relationshipId}`)),
  resolveContactHandle: vi.fn((_dappId: string, handle: string) => handle === 'handle-rel-1' ? 'rel-1' : null),
  getRelationship: vi.fn(() => ({ id: 'rel-1', personId: 'person-1', verifiedAt: '2026-08-20T00:00:00.000Z' })),
  getPerson: vi.fn(() => ({ id: 'person-1', displayName: 'Bob' })),
  getCodeAppFile: vi.fn(() => ''),
  getDappConfig: vi.fn((): { meta: { name: string; icon: string; color: string } } | null => null),
  exportDefinitionBundle: vi.fn(() => Promise.resolve(undefined)),
  getAppRole: vi.fn((): { roleId: string; extends: 'owner' | 'editor' | 'viewer' } | null => null),
  assignAppRole: vi.fn(() => Promise.resolve()),
  listAppRoleAssignments: vi.fn(() => [] as unknown[]),
  getIdentity: vi.fn((): { publicKey: string; displayName: string } | null => null),
  showConfirm: vi.fn<(message: string, options?: { title?: string }) => Promise<boolean>>(() => Promise.resolve(true)),
  listSharesByInstance: vi.fn<(dappId: string, instanceId: string) => Array<{ id: string; relationshipId: string; status: string }>>(() => []),
}));

const appData = {
  observeDeep: vi.fn(),
  unobserveDeep: vi.fn(),
};
const entityData = {
  observeDeep: vi.fn(),
  unobserveDeep: vi.fn(),
};

vi.mock('../services/store', () => ({
  getDappDoc: vi.fn(() => ({
    getMap: vi.fn((name: string) => name === 'appData' ? appData : entityData),
  })),
  getDappPersistence: vi.fn(() => ({ whenSynced: mocks.persistenceReady })),
  getCodeAppData: vi.fn(),
  getCodeAppDataSnapshot: mocks.getSnapshot,
  getCodeAppFile: mocks.getCodeAppFile,
  getDappConfig: mocks.getDappConfig,
  exportDefinitionBundle: mocks.exportDefinitionBundle,
  setCodeAppData: vi.fn(),
  deleteCodeAppData: vi.fn(),
  getAppRole: mocks.getAppRole,
  assignAppRole: mocks.assignAppRole,
  listAppRoleAssignments: mocks.listAppRoleAssignments,
}));

vi.mock('../services/identity', () => ({
  getIdentity: mocks.getIdentity,
}));

vi.mock('../services/codeAppStoreBridge.ts', () => ({
  handleStoreOperation: vi.fn(),
  resolveStoreCollectionId: vi.fn((_dappId: string, nameOrId: string) => nameOrId),
}));

vi.mock('../services/directCodeBindingRuntime', () => ({
  getDirectCodeBindingRuntime: () => ({
    publishDirectEvent: mocks.publishEvent,
    registerActionRuntime: mocks.registerAction,
  }),
}));

vi.mock('../services/channelBindingRuntime', () => ({
  getChannelBindingRuntime: () => ({
    publishChannelEvent: mocks.publishChannelEvent,
    registerActionRuntime: mocks.registerChannelAction,
  }),
}));

vi.mock('../services/browserRelationshipRuntime', () => ({
  createChannelShare: mocks.createChannelShare,
  revokeChannelShareParticipant: mocks.revokeChannelShareParticipant,
}));

vi.mock('../services/dialogs.ts', () => ({ showConfirm: mocks.showConfirm }));
// The host reads permissions from the owner-sealed manifest (sourceSeal.ts).
vi.mock('../services/store/sourceSeal.ts', () => ({ getRunnableCodeAppFile: mocks.getCodeAppFile }));
vi.mock('../services/store/channelShares', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/store/channelShares.ts')>()),
  listChannelSharesByInstance: mocks.listSharesByInstance,
}));

vi.mock('../services/store/contacts', () => ({
  deriveDappContactHandle: mocks.deriveContactHandle,
  resolveDappContactHandle: mocks.resolveContactHandle,
}));

vi.mock('../services/store/relationships', () => ({ getRelationship: mocks.getRelationship }));
vi.mock('../services/store/people', () => ({ getPerson: mocks.getPerson }));

import { attachCodeAppBridge, buildCodeAppDocument, CODE_APP_SANDBOX } from '../services/codeAppRuntime.ts';
import { handleStoreOperation } from '../services/codeAppStoreBridge.ts';

class FakeIframe extends EventTarget {
  posted: unknown[] = [];
  contentWindow = {
    postMessage: (message: unknown) => this.posted.push(message),
  };
}

function dispatchCodeAppMessage(source: unknown, data: unknown) {
  const event = new MessageEvent('message', { data });
  Object.defineProperty(event, 'source', { value: source });
  window.dispatchEvent(event);
}

describe('Code App bridge persistence readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistenceReady = Promise.resolve();
    vi.stubGlobal('window', new EventTarget());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('waits for IndexedDB restoration before returning a data snapshot', async () => {
    let restoreLocalData!: () => void;
    mocks.persistenceReady = new Promise<void>((resolve) => {
      restoreLocalData = resolve;
    });

    const iframe = new FakeIframe();
    const bridge = attachCodeAppBridge(
      iframe as unknown as HTMLIFrameElement,
      'shopping-app',
      'owner',
      'runtime-1',
      { route: '/', onNavigate: vi.fn(), chrome: 'standard', onSetChrome: vi.fn(), onOpenHostSurface: vi.fn(() => Promise.resolve({ opened: true })) },
    );

    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true,
      runtimeId: 'runtime-1',
      type: 'request',
      requestId: 'snapshot-1',
      method: 'data.snapshot',
      args: [],
    });

    await Promise.resolve();
    expect(mocks.getSnapshot).not.toHaveBeenCalled();
    expect(iframe.posted).toEqual([]);

    restoreLocalData();

    await vi.waitFor(() => {
      expect(iframe.posted).toContainEqual({
        __codeApp: true,
        runtimeId: 'runtime-1',
        type: 'response',
        requestId: 'snapshot-1',
        result: { items: ['persisted'] },
      });
    });
    expect(mocks.getSnapshot).toHaveBeenCalledWith('shopping-app');

    bridge.destroy();
  });

  it('delivers the host query string and updates it without changing routes', () => {
    const iframe = new FakeIframe();
    const bridge = attachCodeAppBridge(
      iframe as unknown as HTMLIFrameElement,
      'recipe-app',
      'owner',
      'runtime-query',
      { route: '/recipe', search: '?recipe=bagels-r81052', onNavigate: vi.fn(), chrome: 'standard', onSetChrome: vi.fn(), onOpenHostSurface: vi.fn(() => Promise.resolve({ opened: true })) },
    );

    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true,
      runtimeId: 'runtime-query',
      type: 'ready',
    });

    expect(iframe.posted).toContainEqual(expect.objectContaining({
      type: 'init',
      route: '/recipe',
      search: '?recipe=bagels-r81052',
      context: expect.objectContaining({
        route: '/recipe',
        search: '?recipe=bagels-r81052',
      }) as unknown,
    }));

    bridge.setRoute('/recipe', '?recipe=pretzels-r123');
    expect(iframe.posted).toContainEqual(expect.objectContaining({
      type: 'route-changed',
      route: '/recipe',
      search: '?recipe=pretzels-r123',
    }));

    bridge.destroy();
  });

  it('reports the initial chrome mode in context, updates it via setChrome, and dispatches router.setChrome to the host callback', async () => {
    const iframe = new FakeIframe();
    const onSetChrome = vi.fn();
    const bridge = attachCodeAppBridge(
      iframe as unknown as HTMLIFrameElement,
      'game-app',
      'owner',
      'runtime-chrome',
      { route: '/', onNavigate: vi.fn(), chrome: 'fullscreen', onSetChrome, onOpenHostSurface: vi.fn(() => Promise.resolve({ opened: true })) },
    );

    dispatchCodeAppMessage(iframe.contentWindow, { __codeApp: true, runtimeId: 'runtime-chrome', type: 'ready' });
    expect(iframe.posted).toContainEqual(expect.objectContaining({
      type: 'init',
      context: expect.objectContaining({ chrome: 'fullscreen' }) as unknown,
    }));

    bridge.setChrome('fullscreen'); // no-op: already fullscreen
    expect(iframe.posted.filter((message) => (message as { type?: string }).type === 'chrome-changed')).toHaveLength(0);

    bridge.setChrome('standard');
    expect(iframe.posted).toContainEqual(expect.objectContaining({ type: 'chrome-changed', chrome: 'standard' }));

    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true,
      runtimeId: 'runtime-chrome',
      type: 'request',
      requestId: 'set-chrome-1',
      method: 'router.setChrome',
      args: ['fullscreen'],
    });
    await vi.waitFor(() => expect(onSetChrome).toHaveBeenCalledWith('fullscreen'));
    expect(iframe.posted).toContainEqual(expect.objectContaining({
      type: 'response',
      requestId: 'set-chrome-1',
      result: { chrome: 'fullscreen' },
    }));

    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true,
      runtimeId: 'runtime-chrome',
      type: 'request',
      requestId: 'set-chrome-bad',
      method: 'router.setChrome',
      args: ['huge'],
    });
    await vi.waitFor(() => {
      expect(iframe.posted).toContainEqual(expect.objectContaining({
        type: 'response',
        requestId: 'set-chrome-bad',
        error: expect.stringMatching(/standard.*fullscreen/i) as unknown,
      }));
    });

    bridge.destroy();
  });

  it('binds event publication and action registration to the exact iframe Dapp context', async () => {
    const iframe = new FakeIframe();
    const bridge = attachCodeAppBridge(
      iframe as unknown as HTMLIFrameElement,
      'recipe-app',
      'owner',
      'runtime-secure',
      { route: '/', onNavigate: vi.fn(), chrome: 'standard', onSetChrome: vi.fn(), onOpenHostSurface: vi.fn(() => Promise.resolve({ opened: true })) },
    );

    const request = {
      __codeApp: true,
      runtimeId: 'runtime-secure',
      type: 'request',
      requestId: 'publish-1',
      method: 'events.publish',
      args: ['recipe.meal-planned', { mealId: 'm-1' }],
    };
    dispatchCodeAppMessage({}, request);
    await Promise.resolve();
    expect(mocks.publishEvent).not.toHaveBeenCalled();

    dispatchCodeAppMessage(iframe.contentWindow, request);
    await vi.waitFor(() => expect(mocks.publishEvent).toHaveBeenCalledWith(
      'recipe-app',
      'recipe.meal-planned',
      { mealId: 'm-1' },
    ));

    dispatchCodeAppMessage(iframe.contentWindow, {
      ...request,
      requestId: 'register-1',
      method: 'actions.register',
      args: ['meal-plan.add'],
    });
    await vi.waitFor(() => expect(mocks.registerAction).toHaveBeenCalled());
    expect(mocks.registerAction.mock.calls[0].slice(0, 3)).toEqual(['recipe-app', 'runtime-secure', 'meal-plan.add']);

    bridge.destroy();
  });

  it('publishes locally and over the selected share instance, and exposes only opaque remote action context', async () => {
    mocks.getCodeAppFile.mockReturnValue(JSON.stringify({
      routes: [{ path: '/', label: 'Home' }],
      bindings: {
        events: [{ id: 'game.move', label: 'Move' }],
        actions: [{ id: 'game.move.apply', label: 'Apply move' }],
      },
      channels: { shares: [{
        id: 'match', label: 'Match', events: ['game.move'], actions: ['game.move.apply'],
        routes: [{ eventId: 'game.move', actionId: 'game.move.apply' }],
      }] },
    }));
    const iframe = new FakeIframe();
    const bridge = attachCodeAppBridge(
      iframe as unknown as HTMLIFrameElement, 'game-app', 'owner', 'runtime-channel',
      { route: '/', onNavigate: vi.fn(), chrome: 'standard', onSetChrome: vi.fn(), onOpenHostSurface: vi.fn(() => Promise.resolve({ opened: true })) },
    );

    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true, runtimeId: 'runtime-channel', type: 'request', requestId: 'publish-shared',
      method: 'events.publish', args: ['game.move', { from: 'e2' }, { instanceId: 'instance-1' }],
    });
    await vi.waitFor(() => expect(mocks.publishChannelEvent).toHaveBeenCalledWith(
      'game-app', 'game.move', { from: 'e2' }, 'instance-1',
    ));
    expect(mocks.publishEvent).toHaveBeenCalledWith('game-app', 'game.move', { from: 'e2' });

    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true, runtimeId: 'runtime-channel', type: 'request', requestId: 'register-channel',
      method: 'actions.register', args: ['game.move.apply'],
    });
    await vi.waitFor(() => expect(mocks.registerChannelAction).toHaveBeenCalled());
    const calls = (mocks.registerChannelAction as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const deliver = calls.at(-1)?.[3] as (delivery: unknown) => Promise<void>;
    const delivered = deliver({
      id: 'remote-delivery', actionId: 'game.move.apply', payload: { from: 'e2' },
      from: { handle: 'opaque-bob', displayName: 'Bob', verified: true }, instanceId: 'instance-1',
    });
    await vi.waitFor(() => expect(iframe.posted).toContainEqual(expect.objectContaining({
      type: 'action-delivery', deliveryId: 'remote-delivery',
      context: {
        from: { handle: 'opaque-bob', displayName: 'Bob', verified: true },
        instanceId: 'instance-1',
      },
    })));
    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true, runtimeId: 'runtime-channel', type: 'action-result', deliveryId: 'remote-delivery',
    });
    await delivered;
    bridge.destroy();
  });

  it('returns only host-selected valid handles and requires explicit consent before opening a share', async () => {
    mocks.getCodeAppFile.mockReturnValue(JSON.stringify({
      routes: [{ path: '/', label: 'Home' }],
      permissions: { host: { contacts: true, sharing: true } },
      bindings: {
        events: [{ id: 'game.move', label: 'Move' }],
        actions: [{ id: 'game.move.apply', label: 'Apply move' }],
      },
      channels: { shares: [{
        id: 'match', label: 'Match', events: ['game.move'], actions: ['game.move.apply'],
        routes: [{ eventId: 'game.move', actionId: 'game.move.apply' }], maxParticipants: 2,
      }] },
    }));
    mocks.getDappConfig.mockReturnValue({ meta: { name: 'Game', icon: '🎲', color: '#123456' } });
    const openRelationshipSurface = vi.fn((surface: string) => Promise.resolve(surface === 'contactPicker'
      ? [{ handle: 'handle-rel-1' }, { handle: 'fabricated' }]
      : { confirmed: true }));
    const iframe = new FakeIframe();
    const bridge = attachCodeAppBridge(
      iframe as unknown as HTMLIFrameElement, 'game-app', 'owner', 'runtime-sharing',
      {
        route: '/', onNavigate: vi.fn(), chrome: 'standard', onSetChrome: vi.fn(),
        onOpenHostSurface: vi.fn(() => Promise.resolve({ opened: true })), onOpenRelationshipSurface: openRelationshipSurface,
      },
    );

    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true, runtimeId: 'runtime-sharing', type: 'request', requestId: 'pick-1',
      method: 'contacts.pick', args: [{ min: 1, max: 2 }],
    });
    await vi.waitFor(() => expect(iframe.posted).toContainEqual(expect.objectContaining({
      type: 'response', requestId: 'pick-1',
      result: [{ handle: 'handle-rel-1', displayName: 'Bob', verified: true }],
    })));

    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true, runtimeId: 'runtime-sharing', type: 'request', requestId: 'share-1',
      method: 'share.open', args: [{ shareId: 'match', contacts: [{ handle: 'handle-rel-1' }] }],
    });
    await vi.waitFor(() => expect(mocks.createChannelShare).toHaveBeenCalledWith(expect.objectContaining({
      dappId: 'game-app', relationshipId: 'rel-1', shareId: 'match', attachDefinition: true,
    })));
    expect(openRelationshipSurface).toHaveBeenCalledWith('shareConsent', expect.objectContaining({
      shareId: 'match', contacts: [{ handle: 'handle-rel-1', displayName: 'Bob', verified: true }],
    }));
    bridge.destroy();
  });
});

describe('Code App app roles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistenceReady = Promise.resolve();
    // clearAllMocks() does not reset mockReturnValue overrides — set explicit
    // per-block defaults so a value set by one test cannot leak into the next.
    mocks.getCodeAppFile.mockReturnValue('');
    mocks.getDappConfig.mockReturnValue(null);
    mocks.getAppRole.mockReturnValue(null);
    mocks.assignAppRole.mockReturnValue(Promise.resolve());
    mocks.listAppRoleAssignments.mockReturnValue([]);
    mocks.getIdentity.mockReturnValue({ publicKey: 'aa'.repeat(32), displayName: 'Self' });
    vi.stubGlobal('window', new EventTarget());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes the declared roles and the caller\'s resolved app role in Dapp.context', () => {
    mocks.getCodeAppFile.mockReturnValue(JSON.stringify({
      routes: [{ path: '/', label: 'Home' }],
      roles: [{ id: 'player', label: 'Player', extends: 'editor' }],
    }));
    mocks.getAppRole.mockReturnValue({ roleId: 'player', extends: 'editor' });

    const iframe = new FakeIframe();
    const bridge = attachCodeAppBridge(iframe as unknown as HTMLIFrameElement, 'game-app', 'editor', 'runtime-roles', { route: '/', onNavigate: vi.fn(), chrome: 'standard', onSetChrome: vi.fn(), onOpenHostSurface: vi.fn(() => Promise.resolve({ opened: true })) });

    dispatchCodeAppMessage(iframe.contentWindow, { __codeApp: true, runtimeId: 'runtime-roles', type: 'ready' });

    expect(iframe.posted).toContainEqual(expect.objectContaining({
      type: 'init',
      context: expect.objectContaining({
        roles: [{ id: 'player', label: 'Player', extends: 'editor' }],
        appRole: { id: 'player', label: 'Player', extends: 'editor' },
      }) as unknown,
    }));

    bridge.destroy();
  });

  it('exposes the granted manifest permissions, normalized, in Dapp.context', () => {
    mocks.getCodeAppFile.mockReturnValue(JSON.stringify({
      routes: [{ path: '/', label: 'Home' }],
      permissions: { network: { connect: ['https://catalog.example'] }, host: { files: true }, device: { camera: true } },
    }));

    const iframe = new FakeIframe();
    const bridge = attachCodeAppBridge(iframe as unknown as HTMLIFrameElement, 'catalog-app', 'editor', 'runtime-permissions', { route: '/', onNavigate: vi.fn(), chrome: 'standard', onSetChrome: vi.fn(), onOpenHostSurface: vi.fn(() => Promise.resolve({ opened: true })) });
    dispatchCodeAppMessage(iframe.contentWindow, { __codeApp: true, runtimeId: 'runtime-permissions', type: 'ready' });

    const initContext = (posted: unknown[]) => (posted.find((message) => (message as { type?: string }).type === 'init') as { context: { permissions: unknown } }).context;
    expect(initContext(iframe.posted).permissions).toEqual({ network: { connect: ['https://catalog.example'], images: [] }, host: { files: true }, device: { camera: true } });
    bridge.destroy();

    // No manifest at all still yields the empty shape, never undefined.
    mocks.getCodeAppFile.mockReturnValue('');
    const bare = new FakeIframe();
    const bareBridge = attachCodeAppBridge(bare as unknown as HTMLIFrameElement, 'bare-app', 'viewer', 'runtime-bare', { route: '/', onNavigate: vi.fn(), chrome: 'standard', onSetChrome: vi.fn(), onOpenHostSurface: vi.fn(() => Promise.resolve({ opened: true })) });
    dispatchCodeAppMessage(bare.contentWindow, { __codeApp: true, runtimeId: 'runtime-bare', type: 'ready' });
    expect(initContext(bare.posted).permissions).toEqual({ network: { connect: [], images: [] }, host: {}, device: {} });
    bareBridge.destroy();
  });

  it('rejects a store write for a viewer even when an editor-extending app role is assigned', async () => {
    // The app role is metadata for the app's own logic; enforcement always uses the real framework role.
    mocks.getAppRole.mockReturnValue({ roleId: 'player', extends: 'editor' });

    const iframe = new FakeIframe();
    const bridge = attachCodeAppBridge(iframe as unknown as HTMLIFrameElement, 'game-app', 'viewer', 'runtime-gate', { route: '/', onNavigate: vi.fn(), chrome: 'standard', onSetChrome: vi.fn(), onOpenHostSurface: vi.fn(() => Promise.resolve({ opened: true })) });

    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true,
      runtimeId: 'runtime-gate',
      type: 'request',
      requestId: 'create-1',
      method: 'store.create',
      args: ['tasks', { title: 'x' }],
    });

    await vi.waitFor(() => {
      expect(iframe.posted).toContainEqual(expect.objectContaining({
        type: 'response',
        requestId: 'create-1',
        error: expect.stringMatching(/editor or owner/i) as unknown,
      }));
    });

    bridge.destroy();
  });

  it('rejects roles.assign for a non-owner and roles.assignments for a viewer', async () => {
    const iframe = new FakeIframe();
    const bridge = attachCodeAppBridge(iframe as unknown as HTMLIFrameElement, 'game-app', 'editor', 'runtime-owner-gate', { route: '/', onNavigate: vi.fn(), chrome: 'standard', onSetChrome: vi.fn(), onOpenHostSurface: vi.fn(() => Promise.resolve({ opened: true })) });

    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true,
      runtimeId: 'runtime-owner-gate',
      type: 'request',
      requestId: 'assign-1',
      method: 'roles.assign',
      args: ['bb'.repeat(32), 'player'],
    });
    await vi.waitFor(() => {
      expect(iframe.posted).toContainEqual(expect.objectContaining({
        type: 'response',
        requestId: 'assign-1',
        error: expect.stringMatching(/owner/i) as unknown,
      }));
    });
    expect(mocks.assignAppRole).not.toHaveBeenCalled();

    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true,
      runtimeId: 'runtime-owner-gate',
      type: 'request',
      requestId: 'list-1',
      method: 'roles.assignments',
      args: [],
    });
    await vi.waitFor(() => {
      expect(iframe.posted).toContainEqual(expect.objectContaining({
        type: 'response',
        requestId: 'list-1',
        result: [],
      }));
    });
    expect(mocks.listAppRoleAssignments).toHaveBeenCalledWith('game-app');

    bridge.destroy();
  });

  it('lets an owner assign a declared role and rejects an undeclared one', async () => {
    mocks.getCodeAppFile.mockReturnValue(JSON.stringify({
      routes: [{ path: '/', label: 'Home' }],
      roles: [{ id: 'player', label: 'Player', extends: 'editor' }],
    }));

    const iframe = new FakeIframe();
    const bridge = attachCodeAppBridge(iframe as unknown as HTMLIFrameElement, 'game-app', 'owner', 'runtime-assign', { route: '/', onNavigate: vi.fn(), chrome: 'standard', onSetChrome: vi.fn(), onOpenHostSurface: vi.fn(() => Promise.resolve({ opened: true })) });

    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true,
      runtimeId: 'runtime-assign',
      type: 'request',
      requestId: 'assign-ok',
      method: 'roles.assign',
      args: ['bb'.repeat(32), 'player'],
    });
    await vi.waitFor(() => {
      expect(mocks.assignAppRole).toHaveBeenCalledWith('game-app', 'bb'.repeat(32), 'player');
    });
    expect(iframe.posted).toContainEqual(expect.objectContaining({ type: 'response', requestId: 'assign-ok', result: { success: true } }));

    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true,
      runtimeId: 'runtime-assign',
      type: 'request',
      requestId: 'assign-bad',
      method: 'roles.assign',
      args: ['bb'.repeat(32), 'referee'],
    });
    await vi.waitFor(() => {
      expect(iframe.posted).toContainEqual(expect.objectContaining({
        type: 'response',
        requestId: 'assign-bad',
        error: expect.stringMatching(/undeclared/i) as unknown,
      }));
    });
    expect(mocks.assignAppRole).toHaveBeenCalledTimes(1);

    bridge.destroy();
  });
});

describe('Code App $ui host surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistenceReady = Promise.resolve();
    mocks.getCodeAppFile.mockReturnValue('');
    mocks.getDappConfig.mockReturnValue(null);
    mocks.getAppRole.mockReturnValue(null);
    mocks.getIdentity.mockReturnValue({ publicKey: 'aa'.repeat(32), displayName: 'Self' });
    vi.stubGlobal('window', new EventTarget());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const manifestWithCodeEditor = JSON.stringify({
    routes: [{ path: '/', label: 'Home' }],
    permissions: { host: { codeEditor: true } },
  });

  it('throws and never opens a dialog when the host permission is undeclared', async () => {
    mocks.getCodeAppFile.mockReturnValue(JSON.stringify({ routes: [{ path: '/', label: 'Home' }] }));
    const onOpenHostSurface = vi.fn(() => Promise.resolve({ opened: true }));
    const iframe = new FakeIframe();
    const bridge = attachCodeAppBridge(iframe as unknown as HTMLIFrameElement, 'game-app', 'owner', 'runtime-undeclared', { route: '/', onNavigate: vi.fn(), chrome: 'standard', onSetChrome: vi.fn(), onOpenHostSurface });

    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true, runtimeId: 'runtime-undeclared', type: 'request', requestId: 'open-1', method: 'ui.open', args: ['codeEditor', {}],
    });
    await vi.waitFor(() => {
      expect(iframe.posted).toContainEqual(expect.objectContaining({
        type: 'response',
        requestId: 'open-1',
        error: expect.stringMatching(/not permitted/i) as unknown,
      }));
    });
    expect(onOpenHostSurface).not.toHaveBeenCalled();

    bridge.destroy();
  });

  it('rejects openCodeEditor for a non-owner even when the manifest grants it', async () => {
    mocks.getCodeAppFile.mockReturnValue(manifestWithCodeEditor);
    const onOpenHostSurface = vi.fn(() => Promise.resolve({ opened: true }));
    const iframe = new FakeIframe();
    const bridge = attachCodeAppBridge(iframe as unknown as HTMLIFrameElement, 'game-app', 'editor', 'runtime-non-owner', { route: '/', onNavigate: vi.fn(), chrome: 'standard', onSetChrome: vi.fn(), onOpenHostSurface });

    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true, runtimeId: 'runtime-non-owner', type: 'request', requestId: 'open-2', method: 'ui.open', args: ['codeEditor', {}],
    });
    await vi.waitFor(() => {
      expect(iframe.posted).toContainEqual(expect.objectContaining({
        type: 'response',
        requestId: 'open-2',
        error: expect.stringMatching(/owner/i) as unknown,
      }));
    });
    expect(onOpenHostSurface).not.toHaveBeenCalled();

    bridge.destroy();
  });

  it('resolves the request when the modal closes, and a concurrent second call resolves opened:false without opening a second modal', async () => {
    mocks.getCodeAppFile.mockReturnValue(manifestWithCodeEditor);
    let resolveOpen!: (value: { opened: boolean }) => void;
    const onOpenHostSurface = vi.fn(() => new Promise<{ opened: boolean }>((resolve) => { resolveOpen = resolve; }));
    const iframe = new FakeIframe();
    const bridge = attachCodeAppBridge(iframe as unknown as HTMLIFrameElement, 'game-app', 'owner', 'runtime-exclusive', { route: '/', onNavigate: vi.fn(), chrome: 'standard', onSetChrome: vi.fn(), onOpenHostSurface });

    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true, runtimeId: 'runtime-exclusive', type: 'request', requestId: 'open-first', method: 'ui.open', args: ['codeEditor', {}],
    });
    await vi.waitFor(() => expect(onOpenHostSurface).toHaveBeenCalledTimes(1));

    // A second request arrives while the first modal is still open.
    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true, runtimeId: 'runtime-exclusive', type: 'request', requestId: 'open-second', method: 'ui.open', args: ['codeEditor', {}],
    });
    await vi.waitFor(() => {
      expect(iframe.posted).toContainEqual(expect.objectContaining({ type: 'response', requestId: 'open-second', result: { opened: false } }));
    });
    expect(onOpenHostSurface).toHaveBeenCalledTimes(1); // still just the first

    resolveOpen({ opened: true });
    await vi.waitFor(() => {
      expect(iframe.posted).toContainEqual(expect.objectContaining({ type: 'response', requestId: 'open-first', result: { opened: true } }));
    });

    bridge.destroy();
  });

  it('rate-limits a second open requested immediately after the first closes', async () => {
    mocks.getCodeAppFile.mockReturnValue(manifestWithCodeEditor);
    const onOpenHostSurface = vi.fn(() => Promise.resolve({ opened: true }));
    const iframe = new FakeIframe();
    const bridge = attachCodeAppBridge(iframe as unknown as HTMLIFrameElement, 'game-app', 'owner', 'runtime-rate-limit', { route: '/', onNavigate: vi.fn(), chrome: 'standard', onSetChrome: vi.fn(), onOpenHostSurface });

    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true, runtimeId: 'runtime-rate-limit', type: 'request', requestId: 'open-a', method: 'ui.open', args: ['codeEditor', {}],
    });
    await vi.waitFor(() => {
      expect(iframe.posted).toContainEqual(expect.objectContaining({ type: 'response', requestId: 'open-a', result: { opened: true } }));
    });

    // Fires immediately after — well inside the 500ms minimum interval between opens.
    dispatchCodeAppMessage(iframe.contentWindow, {
      __codeApp: true, runtimeId: 'runtime-rate-limit', type: 'request', requestId: 'open-b', method: 'ui.open', args: ['codeEditor', {}],
    });
    await vi.waitFor(() => {
      expect(iframe.posted).toContainEqual(expect.objectContaining({ type: 'response', requestId: 'open-b', result: { opened: false } }));
    });
    expect(onOpenHostSurface).toHaveBeenCalledTimes(1);

    bridge.destroy();
  });
});

describe('Code App subscription refresh', () => {
  const RUNTIME_ID = 'runtime-subscriptions';
  const REFRESH_MS = 250;
  /** Records per collection, as the mocked `$store` query returns them. */
  let collections: Record<string, Array<Record<string, unknown>>>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.persistenceReady = Promise.resolve();
    vi.stubGlobal('window', new EventTarget());
    collections = { tasks: [{ id: 't1', title: 'one' }], notes: [{ id: 'n1', text: 'hello' }] };
    vi.mocked(handleStoreOperation).mockImplementation((_dappId, _method, args) =>
      Promise.resolve(structuredClone(collections[args[0] as string] ?? [])));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function attach(iframe: FakeIframe) {
    return attachCodeAppBridge(
      iframe as unknown as HTMLIFrameElement,
      'subscription-app',
      'owner',
      RUNTIME_ID,
      { route: '/', onNavigate: vi.fn(), chrome: 'standard', onSetChrome: vi.fn(), onOpenHostSurface: vi.fn(() => Promise.resolve({ opened: true })) },
    );
  }

  async function request(iframe: FakeIframe, method: string, args: unknown[]) {
    dispatchCodeAppMessage(iframe.contentWindow, { __codeApp: true, runtimeId: RUNTIME_ID, type: 'request', requestId: `${method}-${String(args.at(-1))}`, method, args });
    await vi.advanceTimersByTimeAsync(0);
  }

  const postedOfType = (iframe: FakeIframe, type: string) =>
    (iframe.posted as Array<{ type?: string; subscriptionId?: string }>).filter((message) => message.type === type);

  /** Fires the deep observer the bridge put on `data`, the way Yjs would for the given collections. */
  function changeCollections(...events: Array<{ path: Array<string | number>; keys?: Map<string, unknown> }>) {
    const observer = entityData.observeDeep.mock.calls[0][0] as (events: unknown[]) => void;
    observer(events.map((event) => ({ keys: new Map<string, unknown>(), ...event })));
  }

  it('refreshes only the subscriptions of the collection that changed, after the debounce', async () => {
    const iframe = new FakeIframe();
    const bridge = attach(iframe);
    await request(iframe, 'store.subscribe', ['tasks', undefined, 'sub-tasks']);
    await request(iframe, 'store.subscribe', ['notes', undefined, 'sub-notes']);
    // The first result of a subscription is its immediate response.
    expect(iframe.posted).toContainEqual(expect.objectContaining({ type: 'response', requestId: 'store.subscribe-sub-tasks', result: collections.tasks }));
    vi.mocked(handleStoreOperation).mockClear();

    collections.tasks = [...collections.tasks, { id: 't2', title: 'two' }];
    changeCollections({ path: ['tasks', 't2'] });
    changeCollections({ path: ['tasks', 't2'] });
    await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
    expect(postedOfType(iframe, 'store-changed')).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(postedOfType(iframe, 'store-changed')).toEqual([
      expect.objectContaining({ subscriptionId: 'sub-tasks', records: collections.tasks }),
    ]);
    // The untouched collection was not even scanned.
    expect(handleStoreOperation).toHaveBeenCalledTimes(1);
    expect(handleStoreOperation).toHaveBeenCalledWith('subscription-app', 'query', ['tasks', undefined]);

    bridge.destroy();
  });

  it('reads the changed collection from the keys of a top-level event', async () => {
    const iframe = new FakeIframe();
    const bridge = attach(iframe);
    await request(iframe, 'store.subscribe', ['tasks', undefined, 'sub-tasks']);
    await request(iframe, 'store.subscribe', ['notes', undefined, 'sub-notes']);

    collections.notes = [];
    changeCollections({ path: [], keys: new Map([['notes', { action: 'update' }]]) });
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(postedOfType(iframe, 'store-changed')).toEqual([
      expect.objectContaining({ subscriptionId: 'sub-notes', records: [] }),
    ]);

    bridge.destroy();
  });

  it('does not post a result identical to the last one sent', async () => {
    const iframe = new FakeIframe();
    const bridge = attach(iframe);
    await request(iframe, 'store.subscribe', ['tasks', undefined, 'sub-tasks']);

    // The collection changed, but the result equals the subscribe response.
    changeCollections({ path: ['tasks', 't1'] });
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(postedOfType(iframe, 'store-changed')).toEqual([]);

    collections.tasks = [{ id: 't1', title: 'renamed' }];
    changeCollections({ path: ['tasks', 't1'] });
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    changeCollections({ path: ['tasks', 't1'] });
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(postedOfType(iframe, 'store-changed')).toHaveLength(1);

    bridge.destroy();
  });

  it('refreshes $data subscriptions only when appData changed', async () => {
    const iframe = new FakeIframe();
    const bridge = attach(iframe);
    await request(iframe, 'data.subscribe', ['sub-data']);
    mocks.getSnapshot.mockClear();

    changeCollections({ path: ['tasks', 't1'] });
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(mocks.getSnapshot).not.toHaveBeenCalled();
    expect(postedOfType(iframe, 'data-changed')).toEqual([]);

    mocks.getSnapshot.mockReturnValueOnce({ items: ['persisted', 'new'] });
    (appData.observeDeep.mock.calls[0][0] as () => void)();
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(postedOfType(iframe, 'data-changed')).toEqual([
      expect.objectContaining({ subscriptionId: 'sub-data', data: { items: ['persisted', 'new'] } }),
    ]);

    bridge.destroy();
  });

  it('drops a pending refresh when the bridge is destroyed', async () => {
    const iframe = new FakeIframe();
    const bridge = attach(iframe);
    await request(iframe, 'store.subscribe', ['tasks', undefined, 'sub-tasks']);
    collections.tasks = [];
    changeCollections({ path: ['tasks', 't1'] });
    bridge.destroy();
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(postedOfType(iframe, 'store-changed')).toEqual([]);
  });
});

describe('Code App camera bridge', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['', 'routes: [{path: /, label: Home}]\npermissions: {device: {camera: false}}',
    'routes: [{path: /, label: Home}]\npermissions: {device: {camera: "true"}}'])(
  'rejects camera start/frame without a valid grant from the sealed manifest (%s)', async (manifest) => {
    mocks.getCodeAppFile.mockReturnValue(manifest);
    const iframe = new FakeIframe();
    const bridge = attachCodeAppBridge(iframe as unknown as HTMLIFrameElement, 'camera-app', 'owner', 'runtime-camera', {
      route: '/', chrome: 'standard', onNavigate: vi.fn(), onSetChrome: vi.fn(), onOpenHostSurface: vi.fn(),
    });
    for (const method of ['camera.start', 'camera.frame']) {
      dispatchCodeAppMessage(iframe.contentWindow, {
        __codeApp: true, runtimeId: 'runtime-camera', type: 'request', requestId: method, method, args: [],
      });
      await vi.waitFor(() => expect(iframe.posted).toContainEqual(expect.objectContaining({
        requestId: method, error: expect.stringContaining('permissions.device.camera') as unknown, errorName: 'NotAllowedError',
      })));
    }
    bridge.destroy();
  });
});

describe('Code App document resource bundling', () => {
  it('grants scripts and dialogs only — no top navigation, popups or same-origin in the iframe sandbox', () => {
    expect(CODE_APP_SANDBOX.split(' ')).toEqual(['allow-scripts', 'allow-modals']);
    expect(CODE_APP_SANDBOX).not.toContain('allow-top-navigation');
    expect(CODE_APP_SANDBOX).not.toContain('allow-popups');
    expect(CODE_APP_SANDBOX).not.toContain('allow-same-origin');
  });

  it('gives human-mediated share consent longer than ordinary bridge requests', () => {
    const bundle = buildCodeAppDocument({
      'manifest.yaml': JSON.stringify({ routes: [{ path: '/', label: 'Share' }] }),
      'index.html': '<html><body></body></html>',
    }, 'runtime-share-timeout');
    expect(bundle.srcdoc).toMatch(/method === 'share\.open' \|\| method === 'ui\.openLink'[^?]*\? 610000/);
    expect(bundle.srcdoc).toContain("method === 'files.get' ? 120000");
    expect(bundle.srcdoc).toContain(": 10000");
  });

  it('applies connect and image permissions only to their corresponding CSP directives', () => {
    const bundle = buildCodeAppDocument({
      'manifest.yaml': JSON.stringify({
        routes: [{ path: '/', label: 'Map' }],
        permissions: { network: {
          connect: ['https://api.example.com'],
          images: ['https://tiles.example.com'],
        } },
      }),
      'index.html': '<html><body></body></html>',
    }, 'runtime-network');

    const reparsed = new DOMParser().parseFromString(bundle.srcdoc, 'text/html');
    const policy = reparsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || '';
    expect(policy).toContain('connect-src https://api.example.com');
    expect(policy).toContain('img-src data: blob: https://tiles.example.com');
    expect(policy).not.toContain('connect-src https://tiles.example.com');
    expect(policy).not.toContain('img-src data: https://api.example.com');
    expect(policy).toMatch(/script-src 'nonce-[a-f\d]{32}'/);
    expect(policy).toMatch(/style-src 'nonce-[a-f\d]{32}'/);
    // connect-src does not cover RTCPeerConnection; navigate-to is enforced by no browser.
    expect(policy).toContain("webrtc 'block'");
    expect(policy).not.toContain('navigate-to');
  });

  it('keeps absolute web links for the host-confirmed opener and strips everything else', () => {
    const bundle = buildCodeAppDocument({
      'index.html': `<html><body>
        <a id="https" href="https://example.com/path" target="_blank">HTTPS</a>
        <a id="http" href="http://192.168.1.2/page">HTTP</a>
        <a id="relative" href="/settings">Relative</a>
        <a id="fragment" href="#section" target="_top">Fragment</a>
        <a id="javascript" href="javascript:alert(1)" target="_top">Script</a>
        <a id="data" href="data:text/html,unsafe">Data</a>
        <a id="mailto" href="mailto:test@example.com">Mail</a>
      </body></html>`,
    }, 'runtime-links');

    const documentNode = new DOMParser().parseFromString(bundle.srcdoc, 'text/html');
    for (const id of ['https', 'http']) {
      const link = documentNode.querySelector(`#${id}`);
      expect(link?.hasAttribute('href')).toBe(true);
      expect(link?.hasAttribute('target')).toBe(false); // never _top / _blank: the click goes through ui.openLink
      expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    }
    // A relative link in a srcdoc frame would resolve against the host's own address.
    expect(documentNode.querySelector('#relative')?.hasAttribute('href')).toBe(false);
    expect(bundle.srcdoc).toContain("ui.openLink(href)");
    expect(documentNode.querySelector('#fragment')?.getAttribute('href')).toBe('#section');
    expect(documentNode.querySelector('#fragment')?.hasAttribute('target')).toBe(false);
    for (const id of ['javascript', 'data', 'mailto']) {
      const link = documentNode.querySelector(`#${id}`);
      expect(link?.hasAttribute('href')).toBe(false);
      expect(link?.hasAttribute('target')).toBe(false);
    }
  });

  it('preserves only authored HTTPS images from allowlisted exact origins', () => {
    const bundle = buildCodeAppDocument({
      'manifest.yaml': JSON.stringify({
        routes: [{ path: '/', label: 'Map' }],
        permissions: { network: { images: ['https://tiles.example.com:8443'] } },
      }),
      'index.html': `<html><body>
        <img id="allowed" src="https://tiles.example.com:8443/1/2/3.png?key=value">
        <img id="wrong-port" src="https://tiles.example.com/1.png">
        <img id="subdomain" src="https://sub.tiles.example.com:8443/1.png">
        <img id="http" src="http://tiles.example.com:8443/1.png">
      </body></html>`,
    }, 'runtime-images');

    const reparsed = new DOMParser().parseFromString(bundle.srcdoc, 'text/html');
    expect(reparsed.querySelector('#allowed')?.getAttribute('src')).toBe('https://tiles.example.com:8443/1/2/3.png?key=value');
    for (const id of ['wrong-port', 'subdomain', 'http']) {
      expect(reparsed.querySelector(`#${id}`)?.hasAttribute('src')).toBe(false);
    }
  });

  it('preserves allowlisted remote images in linked, block, and attribute CSS only', () => {
    const bundle = buildCodeAppDocument({
      'manifest.yaml': JSON.stringify({
        routes: [{ path: '/', label: 'Map' }],
        permissions: { network: { images: ['https://tiles.example.com'] } },
      }),
      'index.html': `<html><head>
        <link rel="stylesheet" href="styles/map.css">
        <style>.block-ok{background:url(https://tiles.example.com/block.png)} .block-no{background:url(https://other.example/no.png)}</style>
      </head><body>
        <div id="attribute" style="background:url('https://tiles.example.com/attribute.png')"></div>
        <div id="http" style="background:url(http://tiles.example.com/no.png)"></div>
      </body></html>`,
      'styles/map.css': `.linked-ok{background:url("https://tiles.example.com/linked.png")} .linked-no{background:url(https://other.example/no.png)}`,
    }, 'runtime-css-images');

    const documentNode = new DOMParser().parseFromString(bundle.srcdoc, 'text/html');
    const css = [...documentNode.querySelectorAll('style')].map((style) => style.textContent).join('\n');
    expect(css).toContain('url("https://tiles.example.com/linked.png")');
    expect(css).toContain('url("https://tiles.example.com/block.png")');
    expect(css).toContain('url("https://tiles.example.com/attribute.png")');
    expect(css).not.toContain('other.example');
    expect(css).not.toContain('http://tiles.example.com');
    expect(css.match(/url\("data:,"\)/g)).toHaveLength(3);
  });

  it('fails closed for malformed manifests', () => {
    const bundle = buildCodeAppDocument({
      'manifest.yaml': JSON.stringify({
        routes: [{ path: '/', label: 'Map' }],
        permissions: { network: { images: ['https://tiles.example.com/path'] } },
      }),
      'index.html': '<html><body><img src="https://tiles.example.com/1.png"></body></html>',
    }, 'runtime-invalid-manifest');

    const reparsed = new DOMParser().parseFromString(bundle.srcdoc, 'text/html');
    const policy = reparsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || '';
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain('img-src data:');
    expect(policy).not.toContain('tiles.example.com');
    expect(reparsed.querySelector('img')?.hasAttribute('src')).toBe(false);
  });

  it('embeds classic scripts and CSS with a generated nonce and SVGs as data URLs', () => {
    const bundle = buildCodeAppDocument({
      'index.html': `<!doctype html><html><head>
        <link rel="stylesheet" href="styles/app.css">
      </head><body>
        <img id="logo" src="assets/logo.svg#mark">
        <script nonce="authored">globalThis.inlineRan = true</script>
        <script src="vendor/app.js"></script>
      </body></html>`,
      'styles/app.css': `.logo { background: url('../assets/logo.svg#mark') }`,
      'assets/logo.svg': `<svg xmlns="http://www.w3.org/2000/svg"><g id="mark"/></svg>`,
      'vendor/app.js': `globalThis.vendorRan = true`,
    }, 'runtime-1');

    const documentNode = new DOMParser().parseFromString(bundle.srcdoc, 'text/html');
    const scripts = [...documentNode.querySelectorAll('script:not([type="application/json"])')];
    expect(scripts).toHaveLength(3);
    expect(scripts.every((script) => !script.hasAttribute('src'))).toBe(true);
    expect(scripts.map((script) => script.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('const runtimeId = "runtime-1"'),
      'globalThis.inlineRan = true',
      'globalThis.vendorRan = true',
    ]));

    const policy = documentNode.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || '';
    const nonce = policy.match(/script-src 'nonce-([^']+)'/)?.[1] || '';
    expect(nonce).toMatch(/^[a-f\d]{32}$/);
    expect(nonce).not.toBe('authored');
    expect(bundle.srcdoc.match(new RegExp(`nonce="${nonce}"`, 'g'))).toHaveLength(4);

    const style = documentNode.querySelector('style');
    expect(style?.textContent).toMatch(/url\("data:image\/svg\+xml;charset=utf-8,.+#mark"\)/);
    expect(documentNode.querySelector('#logo')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,.+#mark$/);

    expect(policy).toContain(`script-src 'nonce-${nonce}'`);
    expect(policy).toContain(`style-src 'nonce-${nonce}'`);
    // Attribute styles are allowed (nonces can't cover them); script
    // directives must never gain 'unsafe-inline'.
    expect(policy).toContain("style-src-attr 'unsafe-inline'");
    expect(policy).not.toMatch(/script-src[^;]*unsafe/);
    expect(policy).toContain('img-src data: blob:');
    expect(policy).toContain('media-src data: blob:');
    // blob: is granted to images/media only — never to scripts or network.
    expect(policy).not.toMatch(/script-src[^;]*blob:/);
    expect(policy).not.toMatch(/connect-src[^;]*blob:/);

    bundle.dispose();
    bundle.dispose();
  });

  it('removes network, missing, module, import, and authored policy escape hatches', () => {
    const bundle = buildCodeAppDocument({
      'index.html': `<html><head>
        <base href="https://evil.example/">
        <meta http-equiv="refresh" content="0;url=https://evil.example/">
        <meta http-equiv="Content-Security-Policy" content="default-src *">
        <link rel="preload" href="https://evil.example/a.js">
        <link rel="stylesheet" href="https://evil.example/a.css">
        <style nonce="authored">@import 'https://evil.example/a.css'; body { color: red }</style>
      </head><body>
        <img src="missing.svg" srcset="https://evil.example/a.svg 2x">
        <script type="module" src="module.js"></script>
        <script nonce="authored" src="missing.js"></script>
        <script type="application/json" id="payload" nonce="authored">{"safe":true}</script>
      </body></html>`,
      'module.js': 'alert(1)',
    }, 'runtime-2');

    expect(bundle.srcdoc).not.toContain('evil.example');
    expect(bundle.srcdoc).not.toContain('nonce="authored"');
    const documentNode = new DOMParser().parseFromString(bundle.srcdoc, 'text/html');
    expect(documentNode.querySelector('base, meta[http-equiv="refresh"], link, script[type="module"]')).toBeNull();
    expect(documentNode.querySelector('img')?.hasAttribute('src')).toBe(false);
    expect(documentNode.querySelector('img')?.hasAttribute('srcset')).toBe(false);
    expect(documentNode.querySelector('#payload')?.textContent).toBe('{"safe":true}');
    expect(documentNode.querySelector('#payload')?.hasAttribute('nonce')).toBe(false);
    const policy = documentNode.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toMatch(/script-src 'nonce-[a-f\d]{32}'/);
    expect(policy).not.toMatch(/script-src[^;]*blob:/);
    expect(policy).not.toMatch(/connect-src[^;]*blob:/);
  });

  it('contains style end tags and removes SVG scripts before granting a nonce', () => {
    const bundle = buildCodeAppDocument({
      'index.html': `<html><head>
        <link rel="stylesheet" href="styles/escape.css">
      </head><body>
        <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
          <script href="https://injected.example/a.js"></script>
          <script xlink:href="https://injected.example/b.js"></script>
        </svg>
      </body></html>`,
      'styles/escape.css': `body { color: red } </style><meta http-equiv="refresh" content="0;url=https://injected.example/"><style>`,
    }, 'runtime-3');

    const documentNode = new DOMParser().parseFromString(bundle.srcdoc, 'text/html');
    expect(documentNode.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(documentNode.querySelector('svg script')).toBeNull();
    expect(documentNode.querySelector('style')?.textContent).toContain('<\\/style>');
    expect(bundle.srcdoc).not.toContain('<script href=');
    expect(bundle.srcdoc).not.toContain('xlink:href=');
  });
});

describe('Code App external links and share teardown', () => {
  const sharingManifest = JSON.stringify({
    routes: [{ path: '/', label: 'Home' }],
    permissions: { host: { sharing: true } },
  });
  const plainManifest = JSON.stringify({ routes: [{ path: '/', label: 'Home' }] });
  const bridgeOptions = () => ({ route: '/', onNavigate: vi.fn(), chrome: 'standard' as const, onSetChrome: vi.fn(), onOpenHostSurface: vi.fn(() => Promise.resolve({ opened: true })) });

  let iframe: FakeIframe;
  let open: ReturnType<typeof vi.fn>;
  const call = (runtimeId: string, requestId: string, method: string, args: unknown[]) => dispatchCodeAppMessage(iframe.contentWindow, {
    __codeApp: true, runtimeId, type: 'request', requestId, method, args,
  });
  const response = async (requestId: string): Promise<{ result?: unknown; error?: string }> => {
    await vi.waitFor(() => expect(iframe.posted).toContainEqual(expect.objectContaining({ type: 'response', requestId })));
    return iframe.posted.find((entry) => (entry as { requestId?: string }).requestId === requestId) as { result?: unknown; error?: string };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.showConfirm.mockResolvedValue(true);
    mocks.listSharesByInstance.mockReturnValue([]);
    mocks.getCodeAppFile.mockReturnValue(plainManifest);
    iframe = new FakeIframe();
    open = vi.fn();
    vi.stubGlobal('open', open);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens an http(s) link in a new tab only after the person confirmed the address', async () => {
    const bridge = attachCodeAppBridge(iframe as unknown as HTMLIFrameElement, 'links-app', 'viewer', 'runtime-link', bridgeOptions());
    call('runtime-link', 'link-1', 'ui.openLink', ['https://example.com/recipe?id=1']);
    expect((await response('link-1')).result).toEqual({ opened: true });
    expect(mocks.showConfirm).toHaveBeenCalledTimes(1);
    expect(mocks.showConfirm.mock.calls[0][0]).toContain('https://example.com/recipe?id=1');
    expect(mocks.showConfirm.mock.calls[0][1]?.title).toContain('example.com');
    expect(open).toHaveBeenCalledWith('https://example.com/recipe?id=1', '_blank', 'noopener,noreferrer');
    bridge.destroy();
  });

  it('opens nothing when the person declines', async () => {
    mocks.showConfirm.mockResolvedValue(false);
    const bridge = attachCodeAppBridge(iframe as unknown as HTMLIFrameElement, 'links-app', 'owner', 'runtime-decline', bridgeOptions());
    call('runtime-decline', 'link-2', 'ui.openLink', ['https://example.com/']);
    expect((await response('link-2')).result).toEqual({ opened: false });
    expect(open).not.toHaveBeenCalled();
    bridge.destroy();
  });

  it('refuses non-web schemes, relative targets and credentials in the address without asking', async () => {
    const bridge = attachCodeAppBridge(iframe as unknown as HTMLIFrameElement, 'links-app', 'owner', 'runtime-scheme', bridgeOptions());
    const refused = ['javascript:alert(1)', 'data:text/html,x', '/settings', 'https://bank.example@evil.test/', 42];
    for (const [index, target] of refused.entries()) {
      call('runtime-scheme', `bad-${index}`, 'ui.openLink', [target]);
      expect((await response(`bad-${index}`)).error).toMatch(/http\(s\)/);
    }
    expect(mocks.showConfirm).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    bridge.destroy();
  });

  it('never stacks link dialogs: a second request while one is open is dropped', async () => {
    let settle: (confirmed: boolean) => void = () => {};
    mocks.showConfirm.mockImplementation(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    const bridge = attachCodeAppBridge(iframe as unknown as HTMLIFrameElement, 'links-app', 'owner', 'runtime-stack', bridgeOptions());
    call('runtime-stack', 'first', 'ui.openLink', ['https://one.example/']);
    await vi.waitFor(() => expect(mocks.showConfirm).toHaveBeenCalledTimes(1));
    call('runtime-stack', 'second', 'ui.openLink', ['https://two.example/']);
    expect((await response('second')).result).toEqual({ opened: false });
    settle(true);
    expect((await response('first')).result).toEqual({ opened: true });
    expect(mocks.showConfirm).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    bridge.destroy();
  });

  it('keeps every $share call behind the sharing permission', async () => {
    mocks.listSharesByInstance.mockReturnValue([{ id: 'share-1', relationshipId: 'rel-1', status: 'active' }]);
    const bridge = attachCodeAppBridge(iframe as unknown as HTMLIFrameElement, 'share-app', 'owner', 'runtime-noshare', bridgeOptions());
    for (const method of ['share.list', 'share.participants', 'share.close', 'share.leave']) {
      call('runtime-noshare', method, method, ['instance-1']);
      expect((await response(method)).error).toMatch(/not permitted/i);
    }
    expect(mocks.showConfirm).not.toHaveBeenCalled();
    expect(mocks.revokeChannelShareParticipant).not.toHaveBeenCalled();
    bridge.destroy();
  });

  it('ends a share only after confirmation, and withdraws pending offers together with active ones', async () => {
    mocks.getCodeAppFile.mockReturnValue(sharingManifest);
    mocks.listSharesByInstance.mockReturnValue([
      { id: 'share-active', relationshipId: 'rel-1', status: 'active' },
      { id: 'share-pending', relationshipId: 'rel-1', status: 'pending' },
      { id: 'share-gone', relationshipId: 'rel-1', status: 'revoked' },
    ]);
    const bridge = attachCodeAppBridge(iframe as unknown as HTMLIFrameElement, 'share-app', 'editor', 'runtime-close', bridgeOptions());

    mocks.showConfirm.mockResolvedValueOnce(false);
    call('runtime-close', 'close-declined', 'share.close', ['instance-1']);
    expect((await response('close-declined')).result).toEqual({ success: false, revoked: 0 });
    expect(mocks.revokeChannelShareParticipant).not.toHaveBeenCalled();

    call('runtime-close', 'close-confirmed', 'share.close', ['instance-1']);
    expect((await response('close-confirmed')).result).toEqual({ success: true, revoked: 2 });
    expect(mocks.showConfirm.mock.calls[1][0]).toContain('Bob');
    expect(mocks.revokeChannelShareParticipant.mock.calls.map(([row]) => row.id)).toEqual(['share-active', 'share-pending']);
    bridge.destroy();
  });
});
