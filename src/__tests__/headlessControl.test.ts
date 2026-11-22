import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createControlServer, type ControlApi } from '../headless/control.ts';
import type { RuntimeStatus } from '../headless/runtime.ts';
import type { AutomationRule } from '../types.ts';

const TOKEN = 'test-token-123';

const statusPayload: RuntimeStatus = {
  identity: { publicKey: 'ab'.repeat(32), displayName: 'Keeper', deviceId: 'device-1' },
  startedAt: '2026-08-26T00:00:00.000Z',
  signalingUrls: ['ws://localhost:4444'],
  dapps: [],
  automations: [],
  integrations: { llm: null, n8n: null },
};

function makeApi(): ControlApi & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const track = <T>(name: string, result: T) => (...args: unknown[]): T => {
    calls.push([name, args]);
    return result;
  };
  return {
    calls,
    status: track('status', statusPayload),
    join: track('join', Promise.resolve('joined-id')),
    addByCredentials: track('addByCredentials', Promise.resolve('added-id')),
    removeDapp: track('removeDapp', Promise.resolve(true)),
    decideGrant: track('decideGrant', true),
    listEntities: track('listEntities', [{ id: 'items', name: 'Items', recordCount: 2 }]),
    listRecords: track('listRecords', [{ id: 'r1' }]),
    createRecord: track('createRecord', Promise.resolve('new-record')),
    updateRecordFields: track('updateRecordFields', Promise.resolve()),
    deleteRecordById: track('deleteRecordById', Promise.resolve()),
    listRules: track('listRules', [] as AutomationRule[]),
    putRule: track('putRule', {
      schemaVersion: 1, id: 'rule-1', name: 'Rule', enabled: true,
      trigger: { kind: 'cron', schedule: '0 8 * * *' }, steps: [],
      createdAt: 'now', updatedAt: 'now',
    }),
    deleteRule: track('deleteRule', true),
    controlDappInfo: track('controlDappInfo', Promise.resolve({ dappId: 'control-1', operators: [], lobby: [] })),
    ensureControlDapp: track('ensureControlDapp', Promise.resolve({ dappId: 'control-1', operators: [], lobby: [] })),
    createInvite: track('createInvite', Promise.resolve({ uri: 'dapp://invite/app/l/p', link: null })),
    lobby: track('lobby', Promise.resolve([])),
    approveDevice: track('approveDevice', Promise.resolve({ publicKey: 'cc'.repeat(32), displayName: 'Phone', inviteId: 'inv', rejoin: false, safetyNumber: '123456' })),
  };
}

describe('control server', () => {
  let server: http.Server;
  let api: ReturnType<typeof makeApi>;
  let base: string;

  beforeAll(async () => {
    api = makeApi();
    server = createControlServer(api, { token: TOKEN });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const call = (path: string, options: RequestInit = {}, token: string | null = TOKEN) =>
    fetch(`${base}${path}`, {
      ...options,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
    });

  it('serves the dashboard and health check without auth', async () => {
    const home = await call('/', {}, null);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('Dapp Keeper');
    const health = await call('/healthz', {}, null);
    expect(health.status).toBe(200);
  });

  it('gives every dashboard element its own id (a shared id broke the join button)', async () => {
    const html = await (await call('/', {}, null)).text();
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(5);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    // Every id the script looks up exists in the markup.
    const looked = [...html.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
    expect(looked.filter((id) => !ids.includes(id))).toEqual([]);
  });

  it('answers 400 to requests whose path cannot be parsed instead of crashing the keeper', async () => {
    // Raw requests: these paths must reach the server byte for byte.
    const raw = (path: string, token: string | null) => new Promise<number>((resolve, reject) => {
      const { port } = server.address() as AddressInfo;
      const request = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {} }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('error', reject);
      request.end();
    });

    // `new URL('//', base)` throws — and it used to run before any guard, unauthenticated.
    expect(await raw('//', null)).toBe(400);
    // A broken percent escape throws in decodeURIComponent (behind the token check).
    expect(await raw('/api/dapps/%E0%A4%A', TOKEN)).toBe(400);
    // The process and the server survived.
    expect((await call('/healthz', {}, null)).status).toBe(200);
  });

  it('rejects API calls without or with a wrong token', async () => {
    expect((await call('/api/status', {}, null)).status).toBe(401);
    expect((await call('/api/status', {}, 'wrong')).status).toBe(401);
  });

  it('returns runtime status with a valid token', async () => {
    const response = await call('/api/status');
    expect(response.status).toBe(200);
    const payload = await response.json() as RuntimeStatus;
    expect(payload.identity.displayName).toBe('Keeper');
  });

  it('joins by invite and by direct credentials', async () => {
    const invite = await call('/api/dapps/join', { method: 'POST', body: JSON.stringify({ invite: 'dapp://invite/app/x/y' }) });
    expect(invite.status).toBe(201);
    expect(await invite.json()).toEqual({ id: 'joined-id' });

    const direct = await call('/api/dapps', { method: 'POST', body: JSON.stringify({ roomId: 'dapp-abc', roomPassword: 'deadbeef' }) });
    expect(direct.status).toBe(201);
    expect(await direct.json()).toEqual({ id: 'added-id' });
  });

  it('rejects malformed bodies with 400', async () => {
    const missing = await call('/api/dapps/join', { method: 'POST', body: JSON.stringify({}) });
    expect(missing.status).toBe(400);
    const notJson = await call('/api/dapps/join', { method: 'POST', body: 'not-json' });
    expect(notJson.status).toBe(400);
  });

  it('routes record CRUD', async () => {
    const list = await call('/api/dapps/d1/records/items');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([{ id: 'r1' }]);

    const created = await call('/api/dapps/d1/records/items', { method: 'POST', body: JSON.stringify({ data: { title: 'x' } }) });
    expect(created.status).toBe(201);

    const updated = await call('/api/dapps/d1/records/items/r1', { method: 'PATCH', body: JSON.stringify({ data: { title: 'y' } }) });
    expect(updated.status).toBe(200);

    const deleted = await call('/api/dapps/d1/records/items/r1', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(api.calls.some(([name]) => name === 'deleteRecordById')).toBe(true);
  });

  it('rejects path segments that are not well-formed ids', async () => {
    const response = await call('/api/dapps/..%2Fetc/records/items');
    expect(response.status).toBe(400);
  });

  it('manages automation rules', async () => {
    const put = await call('/api/automations/rule-1', {
      method: 'PUT',
      body: JSON.stringify({ name: 'Rule', trigger: { kind: 'cron', schedule: '0 8 * * *' }, steps: [] }),
    });
    expect(put.status).toBe(200);
    const removed = await call('/api/automations/rule-1', { method: 'DELETE' });
    expect(removed.status).toBe(200);
  });

  it('propagates api errors as 400 with the message', async () => {
    api.join = vi.fn(() => Promise.reject(new Error('Invalid invite string')));
    const response = await call('/api/dapps/join', { method: 'POST', body: JSON.stringify({ invite: 'nope' }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid invite string' });
  });

  it('serves the control-dapp, invite, and lobby routes', async () => {
    const before = api.calls.length;
    expect(await (await call('/api/control-dapp')).json()).toEqual({ dappId: 'control-1', operators: [], lobby: [] });
    expect((await call('/api/control-dapp', { method: 'POST' })).status).toBe(200);
    const invite = await call('/api/dapps/control-1/invites', { method: 'POST', body: JSON.stringify({ uses: 3 }) });
    expect(invite.status).toBe(201);
    expect(await invite.json()).toEqual({ uri: 'dapp://invite/app/l/p', link: null });
    expect(await (await call('/api/dapps/control-1/lobby')).json()).toEqual([]);
    const approve = await call('/api/dapps/control-1/lobby/' + 'cc'.repeat(32) + '/approve', { method: 'POST', body: JSON.stringify({ role: 'owner' }) });
    expect(approve.status).toBe(200);
    expect(await approve.json()).toEqual({ approved: 'cc'.repeat(32), displayName: 'Phone' });
    const badRole = await call('/api/dapps/control-1/lobby/' + 'cc'.repeat(32) + '/approve', { method: 'POST', body: JSON.stringify({ role: 'god' }) });
    expect(badRole.status).toBe(400);
    // An approval the keeper holds (signed by a non-operator) is used or refused explicitly.
    const joined = await call('/api/dapps/pending-1/grant', { method: 'POST', body: JSON.stringify({ accept: true }) });
    expect(joined.status).toBe(200);
    expect(await joined.json()).toEqual({ dappId: 'pending-1', joined: true });
    expect((await call('/api/dapps/pending-1/grant', { method: 'POST', body: JSON.stringify({}) })).status).toBe(400);
    expect(api.calls.slice(before).map(([name, args]) => [name, args])).toEqual([
      ['controlDappInfo', []],
      ['ensureControlDapp', []],
      ['createInvite', ['control-1', 3]],
      ['lobby', ['control-1']],
      ['approveDevice', ['control-1', 'cc'.repeat(32), 'owner']],
      ['decideGrant', ['pending-1', true]],
    ]);
  });
});
