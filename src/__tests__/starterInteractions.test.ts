// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadStarterDefinitions, starterScripts } from './helpers/starterFixtures.ts';

const CODE_APP_STARTERS = loadStarterDefinitions();

function installStarter(
  starterId: string,
  store: Record<string, unknown>,
  options: { shares?: unknown[]; context?: Record<string, unknown>; query?: (name: string) => string | null } = {},
) {
  const starter = CODE_APP_STARTERS.find((entry) => entry.id === starterId);
  if (!starter) throw new Error(`Missing starter ${starterId}`);
  const parsed = new DOMParser().parseFromString(starter.source['index.html'], 'text/html');
  // Linked stylesheets would make happy-dom try to fetch them; the runtime inlines them instead.
  parsed.querySelectorAll('link').forEach((link) => link.remove());
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
  const scripts = starterScripts(starter);
  if (scripts.length === 0) throw new Error('Missing starter script');
  const router = {
    current: () => '/', query: options.query ?? (() => null), subscribe: vi.fn(), navigate: vi.fn(), setChrome: vi.fn(),
  };
  const publish = vi.fn();
  const handle = vi.fn();
  // Default $data stub (a test may pre-assign its own richer one before calling).
  let dataState: Record<string, unknown> = {};
  let dataSubscriber: ((snapshot: Record<string, unknown>) => void) | undefined;
  const data = (globalThis as Record<string, unknown>).$data ?? {
    set: vi.fn((key: string, value: unknown) => {
      dataState = { ...dataState, [key]: value };
      dataSubscriber?.(dataState);
      return Promise.resolve({ success: true });
    }),
    get: vi.fn((key: string) => dataState[key]),
    snapshot: vi.fn(() => Promise.resolve(dataState)),
    subscribe: vi.fn((callback: typeof dataSubscriber) => {
      dataSubscriber = callback;
      callback?.(dataState);
      return Promise.resolve(() => {});
    }),
  };
  Object.assign(globalThis, {
    Dapp: { context: options.context ?? { identity: { publicKey: 'owner-key', displayName: 'Owner' } }, onReady: (callback: () => unknown) => queueMicrotask(callback) },
    $store: store,
    $router: router,
    $events: { publish },
    $actions: { handle },
    $contacts: { pick: vi.fn() },
    $share: { open: vi.fn(), list: vi.fn(() => options.shares ?? []) },
    $data: data,
  });
  // Intentional: this harness executes the shipped first-party app (inline and
  // linked scripts, in document order) against mocked public SDK globals.
  for (const script of scripts) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    (new Function(script.code) as () => void)();
  }
  return { router, handle, publish };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('starter source interactions', () => {
  beforeEach(() => { document.head.innerHTML = ''; document.body.innerHTML = ''; });
  afterEach(() => {
    for (const key of ['Dapp', '$store', '$router', '$events', '$actions', '$contacts', '$share', '$files', '$data']) {
      Reflect.deleteProperty(globalThis, key);
    }
    vi.restoreAllMocks();
  });

  it('creates and renders a To-Do task through the public $store façade', async () => {
    let rows: Array<Record<string, unknown>> = [];
    let subscriber: ((next: typeof rows) => void) | undefined;
    const create = vi.fn((_collection: string, data: Record<string, unknown>) => {
      const record = { ...data, id: 'task-1' };
      rows = [...rows, record];
      subscriber?.(rows);
      return Promise.resolve(record);
    });
    installStarter('todo-list', {
      create,
      subscribe: vi.fn((_collection: string, _filter: unknown, callback: typeof subscriber) => {
        subscriber = callback;
        callback?.(rows);
        return Promise.resolve(() => {});
      }),
      update: vi.fn(), delete: vi.fn(), query: vi.fn(() => []),
    });
    await flush();
    const title = document.querySelector<HTMLInputElement>('#title');
    const button = document.querySelector<HTMLButtonElement>('#add-task');
    if (!title || !button) throw new Error('Missing To-Do controls');
    title.value = 'Verify starter runtime';
    button.click();
    await flush();
    expect(create).toHaveBeenCalledWith('tasks', expect.objectContaining({ title: 'Verify starter runtime', done: false }));
    expect(document.querySelector('#count')?.textContent).toBe('1 task');
    expect(document.querySelector('#tasks')?.textContent).toContain('Verify starter runtime');
  });

  it('saves a Diary entry from its explicit button', async () => {
    const create = vi.fn((_collection: string, data: Record<string, unknown>) => Promise.resolve({ ...data, id: 'entry-1' }));
    installStarter('diary', {
      create,
      subscribe: vi.fn((_collection: string, _filter: unknown, callback: (rows: unknown[]) => void) => {
        callback([]);
        return Promise.resolve(() => {});
      }),
      query: vi.fn(() => Promise.resolve([])), update: vi.fn(), delete: vi.fn(),
    });
    await flush();
    const date = document.querySelector<HTMLInputElement>('#entry-date');
    const text = document.querySelector<HTMLTextAreaElement>('#entry-text');
    const save = document.querySelector<HTMLButtonElement>('#save-entry');
    if (!date || !text || !save) throw new Error('Missing Diary controls');
    date.value = '2026-08-21';
    text.value = 'Explicit click works';
    save.click();
    await flush();

    expect(create).toHaveBeenCalledWith('entries', {
      date: '2026-08-21', text: 'Explicit click works',
    });
    expect(document.querySelector('#status')?.textContent).toBe('Saved locally.');
  });

  it('runs the Shared Expenses add action from its explicit button', async () => {
    const members = [
      { id: 'me', name: 'Owner', kind: 'me' },
      { id: 'friend', name: 'Friend', instanceId: 'expense-channel' },
    ];
    const create = vi.fn((collection: string, data: Record<string, unknown>) => Promise.resolve({ ...data, id: collection === 'expenses' ? 'expense-1' : 'record-1' }));
    const { router, publish } = installStarter('shared-expenses', {
      create,
      query: vi.fn(() => Promise.resolve([members[0]])),
      subscribe: vi.fn((collection: string, _filter: unknown, callback: (rows: unknown[]) => void) => {
        callback(collection === 'members' ? members : []);
        return Promise.resolve(() => {});
      }),
      update: vi.fn(), delete: vi.fn(),
    });
    await flush();
    const routeCallback = router.subscribe.mock.calls[0]?.[0] as ((path: string) => void) | undefined;
    if (!routeCallback) throw new Error('Expense route subscription was not registered');
    routeCallback('/add');
    const amount = document.querySelector<HTMLInputElement>('#amount');
    const date = document.querySelector<HTMLInputElement>('#date');
    const payer = document.querySelector<HTMLSelectElement>('#payer');
    const splitInputs = document.querySelectorAll<HTMLInputElement>('[name=split]');
    const add = document.querySelector<HTMLButtonElement>('#add-expense');
    if (!amount || !date || !payer || !add) throw new Error('Missing expense controls');
    payer.value = 'me';
    splitInputs.forEach((input) => { input.checked = true; });
    amount.reportValidity = vi.fn(() => true);
    date.reportValidity = vi.fn(() => true);
    amount.value = '24';
    date.value = '2026-08-21';
    add.click();
    await flush();

    expect(create).toHaveBeenCalledWith('expenses', expect.objectContaining({ amount: 24, payerId: 'me' }));
    expect(publish).toHaveBeenCalledWith('expense.shared', {
      expenseId: 'expense-1', payerId: 'sender', payerName: 'Owner', amount: 12,
      splitAmongIds: ['recipient'], note: '', date: '2026-08-21',
    }, { instanceId: 'expense-channel' });
    expect(router.navigate).toHaveBeenCalledWith('/expenses');
  });

  it('installs the remote expense participant and maps wire roles to local member IDs', async () => {
    const mine = { id: 'local-me', name: 'Phone', kind: 'me' };
    const remote = { id: 'local-laptop', name: 'Laptop', instanceId: 'expense-channel', kind: 'contact' };
    const create = vi.fn((collection: string, data: Record<string, unknown>) => Promise.resolve({
      ...data, id: collection === 'expenses' ? 'received-expense' : 'created-contact',
    }));
    const query = vi.fn((collection: string, filter: Record<string, unknown>) => {
      if (collection === 'members' && filter.kind === 'me') return Promise.resolve([mine]);
      if (collection === 'members' && filter.instanceId === 'expense-channel') return Promise.resolve([remote]);
      return Promise.resolve([]);
    });
    const { handle } = installStarter('shared-expenses', {
      create, query, update: vi.fn(), delete: vi.fn(),
      subscribe: vi.fn((_collection: string, _filter: unknown, callback: (rows: unknown[]) => void) => {
        callback([]); return Promise.resolve(() => {});
      }),
    }, {
      shares: [{
        shareId: 'expense-settlement', instanceId: 'expense-channel',
        participants: [{ status: 'active', contact: { handle: 'opaque', displayName: 'Laptop', verified: true } }],
      }],
    });
    await flush();
    const receive = handle.mock.calls.find(([actionId]) => actionId === 'expense.receive')?.[1] as
      | ((payload: Record<string, unknown>, context: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!receive) throw new Error('Expense receive action was not registered');
    await receive({
      expenseId: 'remote-1', payerId: 'sender', payerName: 'Ignored wire label', amount: 12,
      splitAmongIds: ['recipient'], note: 'Dinner', date: '2026-08-21',
    }, {
      instanceId: 'expense-channel', from: { handle: 'opaque', displayName: 'Laptop', verified: true },
    });

    expect(create).toHaveBeenCalledWith('expenses', expect.objectContaining({
      externalId: 'remote-1', payerId: 'local-laptop', payerName: 'Laptop',
      splitAmongIds: ['local-me'], amount: 12, received: true,
    }));
  });

  it('runs the Group Chat send action and reports a missing channel', async () => {
    const create = vi.fn();
    installStarter('group-chat', {
      create, query: vi.fn(() => Promise.resolve([])), update: vi.fn(), delete: vi.fn(),
      subscribe: vi.fn((_collection: string, _filter: unknown, callback: (rows: unknown[]) => void) => {
        callback([]);
        return Promise.resolve(() => {});
      }),
    });
    await flush();
    const message = document.querySelector<HTMLTextAreaElement>('#message');
    const send = document.querySelector<HTMLButtonElement>('#send-message');
    if (!message || !send) throw new Error('Missing Group Chat controls');
    message.value = 'Hello';
    send.click();
    await flush();

    expect(create).not.toHaveBeenCalled();
    expect(document.querySelector('#status')?.textContent).toBe('Start a chat first.');
  });

  it('drops hostile Diary attachment URLs at the receive boundary', async () => {
    const create = vi.fn((_collection: string, data: Record<string, unknown>) => Promise.resolve({ ...data, id: 'entry-1' }));
    const { handle } = installStarter('diary', {
      create,
      subscribe: vi.fn((_collection: string, _filter: unknown, callback: (rows: unknown[]) => void) => {
        callback([]);
        return Promise.resolve(() => {});
      }),
      query: vi.fn(() => Promise.resolve([])), update: vi.fn(), delete: vi.fn(),
    });
    await flush();
    const receive = handle.mock.calls.find(([action]) => action === 'entry.receive')?.[1] as
      | ((payload: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!receive) throw new Error('Diary receive action was not registered');

    await receive({ date: '2026-08-21', text: 'Shared safely', photoDataUrl: 'x" onerror="alert(1)' });

    expect(create).toHaveBeenCalledWith('entries', {
      date: '2026-08-21', text: 'Shared safely', received: true,
    });
  });

  it('adds a weigh-in from the Weight Tracker form and renders the summary', async () => {
    let rows: Array<Record<string, unknown>> = [];
    let subscriber: ((next: typeof rows) => void) | undefined;
    const create = vi.fn((_collection: string, data: Record<string, unknown>) => {
      const record = { ...data, id: 'weigh-1' };
      rows = [...rows, record];
      subscriber?.(rows);
      return Promise.resolve(record);
    });
    const { router } = installStarter('weight-tracker', {
      create,
      subscribe: vi.fn((_collection: string, _filter: unknown, callback: typeof subscriber) => {
        subscriber = callback;
        callback?.(rows);
        return Promise.resolve(() => {});
      }),
      update: vi.fn(), delete: vi.fn(), query: vi.fn(() => []),
    });
    await flush();
    const date = document.querySelector<HTMLInputElement>('#weight-date');
    const value = document.querySelector<HTMLInputElement>('#weight-value');
    const note = document.querySelector<HTMLInputElement>('#weight-note');
    const add = document.querySelector<HTMLButtonElement>('#add-weight');
    if (!date || !value || !note || !add) throw new Error('Missing Weight Tracker controls');
    date.value = '2026-08-20';
    value.value = '82.5';
    note.value = 'Morning';
    value.reportValidity = vi.fn(() => true);
    date.reportValidity = vi.fn(() => true);
    add.click();
    await flush();

    expect(create).toHaveBeenCalledWith('weights', { date: '2026-08-20', weight: 82.5, note: 'Morning' });
    expect(router.navigate).toHaveBeenCalledWith('/');
    expect(document.querySelector('#log')?.textContent).toContain('82.5 kg');
    expect(document.querySelector('#summary')?.textContent).toBe('1 entry · latest 82.5 kg');
  });

  it('sorts the Weight Tracker log newest first and deletes entries', async () => {
    const rows: Array<Record<string, unknown>> = [
      { id: 'weigh-old', date: '2026-08-19', weight: 83 },
      { id: 'weigh-new', date: '2026-08-21', weight: 82.4 },
    ];
    const deleted: string[] = [];
    installStarter('weight-tracker', {
      create: vi.fn(),
      subscribe: vi.fn((_collection: string, _filter: unknown, callback: (next: typeof rows) => void) => {
        callback(rows);
        return Promise.resolve(() => {});
      }),
      update: vi.fn(),
      delete: vi.fn((_collection: string, id: string) => { deleted.push(id); return Promise.resolve(); }),
      query: vi.fn(() => []),
    });
    await flush();
    const titles = Array.from(document.querySelectorAll('#log .item-title')).map((node) => node.textContent);
    expect(titles).toEqual(['2026-08-21', '2026-08-19']);
    expect(document.querySelector('#summary')?.textContent).toBe('2 entries · latest 82.4 kg ↓0.6');

    const remove = document.querySelector<HTMLButtonElement>('[data-delete="weigh-old"]');
    if (!remove) throw new Error('Missing delete control');
    remove.click();
    await flush();
    expect(deleted).toEqual(['weigh-old']);
  });

  it('publishes Weight Tracker progress INTO the share instance and compares goals both ways', async () => {
    let rows: Array<Record<string, unknown>> = [];
    let subscriber: ((next: typeof rows) => void) | undefined;
    const create = vi.fn((_collection: string, data: Record<string, unknown>) => {
      const record = { ...data, id: `weigh-${rows.length + 1}` };
      rows = [...rows, record];
      subscriber?.(rows);
      return Promise.resolve(record);
    });
    const { handle, publish } = installStarter('weight-tracker', {
      create,
      subscribe: vi.fn((_collection: string, _filter: unknown, callback: typeof subscriber) => {
        subscriber = callback;
        callback?.(rows);
        return Promise.resolve(() => {});
      }),
      update: vi.fn(), delete: vi.fn(), query: vi.fn(() => []),
    }, { shares: [{ shareId: 'weight-share', instanceId: 'weight-instance', createdAt: '2026-08-01T00:00:00.000Z' }] });
    await flush();

    // Set a goal through the Goal card.
    document.querySelector<HTMLButtonElement>('[data-goal="edit"]')?.click();
    const goalInput = document.querySelector<HTMLInputElement>('#goal-input');
    if (!goalInput) throw new Error('Missing goal input');
    goalInput.value = '80';
    document.querySelector<HTMLButtonElement>('[data-goal="save"]')?.click();
    await flush();
    expect(document.querySelector('#goal')?.textContent).toContain('80 kg');

    // A new weigh-in publishes the snapshot (with the goal) into the share
    // instance — the third argument is what routes it into the channel at all.
    const date = document.querySelector<HTMLInputElement>('#weight-date');
    const value = document.querySelector<HTMLInputElement>('#weight-value');
    const add = document.querySelector<HTMLButtonElement>('#add-weight');
    if (!date || !value || !add) throw new Error('Missing Weight Tracker controls');
    date.value = '2026-08-20';
    value.value = '82.5';
    date.reportValidity = vi.fn(() => true);
    value.reportValidity = vi.fn(() => true);
    add.click();
    await flush();
    expect(publish).toHaveBeenCalledWith(
      'weight.history',
      expect.objectContaining({ target: 80, history: [['2026-08-20', 82.5]] }),
      { instanceId: 'weight-instance' },
    );

    // A received buddy snapshot lands as member rows and shows their goal progress.
    const receive = handle.mock.calls.find(([action]) => action === 'weight.history.receive')?.[1] as
      | ((payload: Record<string, unknown>, context: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!receive) throw new Error('Weight receive action was not registered');
    await receive(
      { memberName: 'Ada', history: [['2026-08-01', 90], ['2026-08-20', 85]], target: 80 },
      { from: { handle: 'ada-handle', displayName: 'Ada' } },
    );
    await flush();
    expect(create).toHaveBeenCalledWith('weights', expect.objectContaining({ member: 'ada-handle', date: '2026-08-01', weight: 90 }));
    expect(document.querySelector('#buddies')?.textContent).toContain('goal 80 kg (50%)');
    expect(document.querySelector('#goal')?.textContent).toContain('% to goal');
  });

  it('creates a habit from the Habit Tracker form with an optional icon', async () => {
    let habits: Array<Record<string, unknown>> = [];
    let subscriber: ((next: typeof habits) => void) | undefined;
    const create = vi.fn((_collection: string, data: Record<string, unknown>) => {
      const record = { ...data, id: 'habit-1' };
      habits = [...habits, record];
      subscriber?.(habits);
      return Promise.resolve(record);
    });
    installStarter('habit-tracker', {
      create,
      subscribe: vi.fn((collection: string, _filter: unknown, callback: (rows: unknown[]) => void) => {
        if (collection === 'habits') subscriber = callback;
        callback(collection === 'habits' ? habits : []);
        return Promise.resolve(() => {});
      }),
      update: vi.fn(), delete: vi.fn(), query: vi.fn(() => []),
    });
    await flush();
    const name = document.querySelector<HTMLInputElement>('#habit-name');
    const icon = document.querySelector<HTMLInputElement>('#habit-icon');
    const add = document.querySelector<HTMLButtonElement>('#add-habit');
    if (!name || !icon || !add) throw new Error('Missing Habit Tracker controls');
    name.value = 'Stretch';
    icon.value = '🧘';
    name.reportValidity = vi.fn(() => true);
    add.click();
    await flush();

    expect(create).toHaveBeenCalledWith('habits', expect.objectContaining({ name: 'Stretch', icon: '🧘', createdAt: new Date().toISOString().slice(0, 10) }));
    expect(document.querySelector('#habits')?.textContent).toContain('Stretch');
    expect(document.querySelector('#today-count')?.textContent).toBe('0/1 today');
  });

  it('checks a habit in for today and toggles it back off', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const habits = [{ id: 'habit-1', name: 'Stretch', createdAt: today }];
    let checkins: Array<Record<string, unknown>> = [];
    const create = vi.fn((_collection: string, data: Record<string, unknown>) => Promise.resolve({ ...data, id: 'checkin-1' }));
    const update = vi.fn((_collection: string, id: string, data: Record<string, unknown>) => {
      checkins = checkins.map((entry) => (entry.id === id ? { ...entry, ...data } : entry));
      return Promise.resolve({ ...checkins.find((entry) => entry.id === id) });
    });
    const install = (rows: Array<Record<string, unknown>>) => installStarter('habit-tracker', {
      create,
      update,
      delete: vi.fn(),
      query: vi.fn(() => []),
      subscribe: vi.fn((collection: string, _filter: unknown, callback: (rows: unknown[]) => void) => {
        callback(collection === 'habits' ? habits : rows);
        return Promise.resolve(() => {});
      }),
    });
    install(checkins);
    await flush();

    const toggle = document.querySelector<HTMLButtonElement>('[data-toggle="habit-1"]');
    if (!toggle) throw new Error('Missing habit toggle control');
    toggle.click();
    await flush();
    expect(create).toHaveBeenCalledWith('checkins', { habitId: 'habit-1', sharedKey: '', date: today, value: 1, member: '', memberName: '' });
    expect(document.querySelector('#today-count')?.textContent).toBe('1/1 today');

    checkins = [{ id: 'checkin-1', habitId: 'habit-1', date: today, value: 1, member: '' }];
    install(checkins);
    await flush();
    const undo = document.querySelector<HTMLButtonElement>('[data-toggle="habit-1"]');
    if (!undo) throw new Error('Missing habit undo control');
    expect(undo.textContent).toContain('Done');
    undo.click();
    await flush();
    expect(update).toHaveBeenCalledWith('checkins', 'checkin-1', { value: 0, sharedKey: '' });
  });

  it('quick-logs an amount, publishes progress for a shared habit, and renders the chart', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const habits = [{ id: 'habit-1', name: 'Moving', amount: 30, unit: 'min', sharedKey: 'shared-1', createdAt: today }];
    let checkins: Array<Record<string, unknown>> = [];
    const create = vi.fn((_collection: string, data: Record<string, unknown>) => {
      const record = { ...data, id: 'checkin-1' };
      checkins = [...checkins, record];
      return Promise.resolve(record);
    });
    const { publish } = installStarter('habit-tracker', {
      create, update: vi.fn(), delete: vi.fn(), query: vi.fn(() => []),
      subscribe: vi.fn((collection: string, _filter: unknown, callback: (rows: unknown[]) => void) => {
        callback(collection === 'habits' ? habits : checkins);
        return Promise.resolve(() => {});
      }),
    }, { shares: [{ shareId: 'habit-share', instanceId: 'instance-1', createdAt: today, participants: [] }] });
    await flush();

    const quick = document.querySelector<HTMLButtonElement>('[data-quick="habit-1"]');
    if (!quick) throw new Error('Missing quick log control');
    quick.click();
    await flush();

    expect(create).toHaveBeenCalledWith('checkins', { habitId: 'habit-1', sharedKey: 'shared-1', date: today, value: 30, member: '', memberName: '' });
    expect(publish).toHaveBeenCalledWith('habit.progress',
      { sharedKey: 'shared-1', date: today, value: 30, memberName: 'Owner' }, { instanceId: 'instance-1' });
    expect(document.querySelector('#chart svg')).toBeTruthy();
  });

  it('tracks a weekly habit by week total and shares a note with today\'s progress', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const habits = [{ id: 'habit-1', name: 'Runs', amount: 3, unit: '×', per: 'week', sharedKey: 'shared-1', createdAt: today }];
    const checkins = [{ id: 'checkin-0', habitId: 'habit-1', sharedKey: 'shared-1', date: today, value: 3, member: '' }];
    const update = vi.fn(() => Promise.resolve({}));
    const { publish } = installStarter('habit-tracker', {
      create: vi.fn((_collection: string, data: Record<string, unknown>) => Promise.resolve({ ...data, id: 'checkin-1' })),
      update, delete: vi.fn(), query: vi.fn(() => []),
      subscribe: vi.fn((collection: string, _filter: unknown, callback: (rows: unknown[]) => void) => {
        callback(collection === 'habits' ? habits : checkins);
        return Promise.resolve(() => {});
      }),
    }, { shares: [{ shareId: 'habit-share', instanceId: 'instance-1', createdAt: today, participants: [] }] });
    await flush();

    // The 3-per-week target is already met by today's 3 → counted as done, week progress shown.
    expect(document.querySelector('#today-count')?.textContent).toBe('1/1 today');
    expect(document.querySelector('#today-list')?.textContent).toContain('this week');
    // Single-habit metric renders the consistency heatmap under the chart.
    expect(document.querySelector('#heatmap svg')).toBeTruthy();

    document.querySelector<HTMLButtonElement>('[data-note="habit-1"]')?.click();
    await flush();
    const input = document.querySelector<HTMLInputElement>('[data-note-input="habit-1"]');
    if (!input) throw new Error('Missing note input');
    input.value = 'around the lake';
    document.querySelector<HTMLButtonElement>('[data-note-save="habit-1"]')?.click();
    await flush();

    expect(update).toHaveBeenCalledWith('checkins', 'checkin-0', { note: 'around the lake' });
    expect(publish).toHaveBeenCalledWith('habit.progress',
      { sharedKey: 'shared-1', date: today, value: 3, memberName: 'Owner', note: 'around the lake' }, { instanceId: 'instance-1' });
  });

  it('clears a Diary date selected by a removed route query', async () => {
    let queryDate: string | null = '2026-08-20';
    const { router } = installStarter('diary', {
      create: vi.fn(), query: vi.fn(() => Promise.resolve([])), update: vi.fn(), delete: vi.fn(),
      subscribe: vi.fn((_collection: string, _filter: unknown, callback: (rows: unknown[]) => void) => {
        callback([]);
        return Promise.resolve(() => {});
      }),
    }, { query: () => queryDate });
    await flush();
    const input = document.querySelector<HTMLInputElement>('#entry-date');
    expect(input?.value).toBe('2026-08-20');
    const routeCallback = router.subscribe.mock.calls[0]?.[0] as ((path: string) => void) | undefined;
    if (!routeCallback) throw new Error('Diary route subscription was not registered');

    queryDate = null;
    routeCallback('/entry');

    expect(input?.value).toBe(new Date().toISOString().slice(0, 10));
  });

  it('preserves owner-attested authorship across a three-party relay and strips hostile attachments', async () => {
    const ownerCreate = vi.fn((_collection: string, data: Record<string, unknown>) => Promise.resolve({ ...data, id: 'message-1' }));
    const activeShare = [{
      shareId: 'group-chat', instanceId: 'chat-instance', createdAt: '2026-08-21T11:00:00.000Z',
      participants: [{ status: 'active' }],
    }];
    const owner = installStarter('group-chat', {
      create: ownerCreate,
      query: vi.fn((collection: string) => Promise.resolve(collection === 'chatState' ? [{ relayOwner: true }] : [])),
      subscribe: vi.fn((_collection: string, _filter: unknown, callback: (rows: unknown[]) => void) => {
        callback([]);
        return Promise.resolve(() => {});
      }),
      update: vi.fn(), delete: vi.fn(),
    }, { shares: activeShare });
    await flush();
    const ownerReceive = owner.handle.mock.calls.find(([action]) => action === 'message.receive')?.[1] as
      | ((payload: Record<string, unknown>, context: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!ownerReceive) throw new Error('Owner chat receive action was not registered');

    await ownerReceive({
      messageId: 'remote-1', relayAuthorId: 'spoofed-global-key', relayAuthorName: 'Spoofed owner',
      text: 'Authenticated content', photoDataUrl: 'data:text/html;base64,PHNjcmlwdD4=', sentAt: '2026-08-21T12:00:00.000Z',
    }, { from: { handle: 'owner-bob-handle', displayName: 'Bob', verified: true }, instanceId: 'chat-instance' });

    const ownerStored = ownerCreate.mock.calls[0]?.[1];
    expect(ownerStored).toEqual(expect.objectContaining({ authorName: 'Bob', text: 'Authenticated content' }));
    expect(ownerStored?.authorId).toMatch(/^relay-/);
    expect(ownerStored).not.toHaveProperty('photoDataUrl');
    const relayed = owner.publish.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(relayed).toEqual(expect.objectContaining({
      relayAuthorId: ownerStored?.authorId, relayAuthorName: 'Bob', text: 'Authenticated content',
    }));
    expect(relayed).not.toHaveProperty('photoDataUrl');

    const recipientCreate = vi.fn((_collection: string, data: Record<string, unknown>) => Promise.resolve({ ...data, id: 'message-2' }));
    const recipient = installStarter('group-chat', {
      create: recipientCreate,
      query: vi.fn(() => Promise.resolve([])),
      subscribe: vi.fn((_collection: string, _filter: unknown, callback: (rows: unknown[]) => void) => {
        callback([]);
        return Promise.resolve(() => {});
      }),
      update: vi.fn(), delete: vi.fn(),
    }, { shares: activeShare });
    await flush();
    const recipientReceive = recipient.handle.mock.calls.find(([action]) => action === 'message.receive')?.[1] as
      | ((payload: Record<string, unknown>, context: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!recipientReceive) throw new Error('Recipient chat receive action was not registered');

    await recipientReceive(relayed, {
      from: { handle: 'owner-carol-handle', displayName: 'Owner', verified: true }, instanceId: 'chat-instance',
    });

    expect(recipientCreate).toHaveBeenCalledWith('messages', expect.objectContaining({
      authorId: ownerStored?.authorId, authorName: 'Bob', text: 'Authenticated content',
    }));
    expect(recipient.publish).not.toHaveBeenCalled();
  });

  it('stores received Group Chat photos in the file store and references them on the record', async () => {
    const create = vi.fn((_collection: string, data: Record<string, unknown>) => Promise.resolve({ ...data, id: 'message-3' }));
    const filesAdd = vi.fn(() => Promise.resolve({ id: 'file-1' }));
    const { handle } = installStarter('group-chat', {
      create,
      query: vi.fn(() => Promise.resolve([])),
      subscribe: vi.fn((_collection: string, _filter: unknown, callback: (rows: unknown[]) => void) => {
        callback([]);
        return Promise.resolve(() => {});
      }),
      update: vi.fn(), delete: vi.fn(),
    }, {
      shares: [{
        shareId: 'group-chat', instanceId: 'chat-instance', createdAt: '2026-08-21T11:00:00.000Z',
        participants: [{ status: 'active' }],
      }],
    });
    Object.assign(globalThis, {
      $files: {
        find: vi.fn(() => Promise.resolve(null)), add: filesAdd,
        list: vi.fn(() => Promise.resolve([])), get: vi.fn(), delete: vi.fn(),
        objectUrl: vi.fn(() => Promise.resolve(null)),
      },
    });
    await flush();
    const receive = handle.mock.calls.find(([action]) => action === 'message.receive')?.[1] as
      | ((payload: Record<string, unknown>, context: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!receive) throw new Error('Chat receive action was not registered');

    await receive({
      messageId: 'photo-1', text: 'Look at this', photoDataUrl: 'data:image/jpeg;base64,' + btoa('jpeg-bytes'),
      sentAt: '2026-08-21T12:00:00.000Z',
    }, { from: { handle: 'owner-bob-handle', displayName: 'Bob', verified: true }, instanceId: 'chat-instance' });

    expect(filesAdd).toHaveBeenCalledWith(expect.objectContaining({
      name: 'chat-photo-photo-1.jpg', mime: 'image/jpeg', data: expect.any(Uint8Array) as unknown,
    }));
    expect(create).toHaveBeenCalledWith('messages', expect.objectContaining({
      messageId: 'photo-1', photoFileId: 'file-1', photoFileName: 'chat-photo-photo-1.jpg',
    }));
  });

  it('App Studio: designs an entity, field and screen in the Studio, then saves a record through the generated editor', async () => {
    let dataState: Record<string, unknown> = {};
    let dataSubscriber: ((snapshot: Record<string, unknown>) => void) | undefined;
    Object.assign(globalThis, {
      $data: {
        set: vi.fn((key: string, value: unknown) => {
          dataState = { ...dataState, [key]: value };
          dataSubscriber?.(dataState);
          return Promise.resolve({ success: true });
        }),
        get: vi.fn(), snapshot: vi.fn(() => Promise.resolve(dataState)),
        subscribe: vi.fn((callback: typeof dataSubscriber) => {
          dataSubscriber = callback;
          callback?.(dataState);
          return Promise.resolve(() => {});
        }),
      },
      $files: {
        list: vi.fn(() => Promise.resolve([])), get: vi.fn(), delete: vi.fn(), add: vi.fn(),
        objectUrl: vi.fn(() => Promise.resolve(null)),
      },
    });
    let rows: Array<Record<string, unknown>> = [];
    const storeSubscribers = new Map<string, (next: typeof rows) => void>();
    const create = vi.fn((collectionName: string, data: Record<string, unknown>) => {
      const record = { ...data, id: 'record-1' };
      rows = [...rows, record];
      storeSubscribers.get(collectionName)?.(rows);
      return Promise.resolve(record);
    });
    const { router } = installStarter('app-studio', {
      create,
      subscribe: vi.fn((collectionName: string, _filter: unknown, callback: (next: typeof rows) => void) => {
        storeSubscribers.set(collectionName, callback);
        callback(rows);
        return Promise.resolve(() => {});
      }),
      update: vi.fn(), delete: vi.fn(), query: vi.fn(() => Promise.resolve([])),
    }, { context: { identity: { publicKey: 'owner-key' }, role: 'owner', meta: { name: 'Book Club' } } });
    await flush();
    const routeChange = router.subscribe.mock.calls[0]?.[0] as ((path: string) => void) | undefined;
    if (!routeChange) throw new Error('App Studio did not subscribe to the router');

    const type = (selector: string, value: string) => {
      const input = document.querySelector<HTMLInputElement>(selector);
      if (!input) throw new Error(`Missing control ${selector}`);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const click = (selector: string) => {
      const button = document.querySelector<HTMLButtonElement>(selector);
      if (!button) throw new Error(`Missing control ${selector}`);
      button.click();
    };

    routeChange('/studio');
    type('[data-draft="entity-name"]', 'Books');
    click('[data-action="add-entity"]');
    await flush();
    type('[data-fdraft="name"]', 'Title');
    click('[data-action="add-field"]');
    await flush();
    type('[data-sdraft="name"]', 'All books');
    click('[data-action="add-screen"]');
    await flush();

    const definition = dataState['appdef'] as {
      entities: Array<{ id: string; name: string; fields: Array<{ id: string; name: string; type: string }> }>;
      screens: Array<{ id: string; name: string; type: string; entityId: string }>;
    };
    expect(definition.entities).toHaveLength(1);
    expect(definition.entities[0].fields).toEqual([expect.objectContaining({ name: 'Title', type: 'text' })]);
    expect(definition.screens).toEqual([expect.objectContaining({ name: 'All books', type: 'list', entityId: definition.entities[0].id })]);

    routeChange('/');
    await flush();
    click('[data-action="open-add"]');
    await flush();
    type('#f_' + definition.entities[0].fields[0].id, 'Dune');
    click('[data-action="save-record"]');
    await flush();

    expect(create).toHaveBeenCalledWith('records_' + definition.entities[0].id, expect.objectContaining({
      [definition.entities[0].fields[0].id]: 'Dune',
    }));
    expect(document.querySelector('#screen-body')?.textContent).toContain('Dune');
  });
});
