import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AutomationRule, MemberRole, RecordData } from '../types.ts';
import type { RuntimeStatus } from './runtime.ts';
import type { ControlDappInfo, InviteResult } from './controlDapp.ts';
import type { LobbyPeer } from './controlStore.ts';

/**
 * HTTP control surface for the headless runtime: a small token-guarded JSON
 * API (for people, agents, and scripts) plus a static status dashboard.
 * Binds loopback by default; anything wider is an explicit deployment
 * decision (put TLS + real auth in front — see docs/HEADLESS.md).
 *
 * Deliberately NOT here: any way to mint access the user didn't initiate.
 * Joining a dapp still runs the normal invite/lobby flow — the owner device
 * must approve this node (safety number and all) before it gets credentials.
 */

export interface ControlApi {
  status(): RuntimeStatus;
  join(inviteUri: string): Promise<string>;
  addByCredentials(roomId: string, roomPassword: string): Promise<string>;
  removeDapp(dappId: string, options?: { dropFounded?: boolean }): Promise<boolean>;
  listEntities(dappId: string): Array<{ id: string; name: string; recordCount: number }>;
  listRecords(dappId: string, entityId: string): RecordData[] | undefined;
  createRecord(dappId: string, entityId: string, data: Record<string, unknown>): Promise<string>;
  updateRecordFields(dappId: string, entityId: string, recordId: string, data: Record<string, unknown>): Promise<void>;
  deleteRecordById(dappId: string, entityId: string, recordId: string): Promise<void>;
  listRules(): AutomationRule[];
  putRule(rule: Omit<AutomationRule, 'schemaVersion' | 'createdAt' | 'updatedAt'>): AutomationRule;
  deleteRule(id: string): boolean;
  /** Null until the control dapp has been created. */
  controlDappInfo(): Promise<ControlDappInfo | null>;
  ensureControlDapp(): Promise<ControlDappInfo>;
  createInvite(dappId: string, uses: number): Promise<InviteResult>;
  lobby(dappId: string): Promise<LobbyPeer[]>;
  approveDevice(dappId: string, publicKey: string, role: MemberRole): Promise<LobbyPeer>;
  /** Use or refuse an approval the keeper holds for a dapp it is joining (status: `pendingGrant`). */
  decideGrant(dappId: string, accept: boolean): boolean;
}

const MAX_BODY_BYTES = 1024 * 1024;

function tokenMatches(provided: string, expected: string): boolean {
  const providedBytes = new TextEncoder().encode(provided);
  const expectedBytes = new TextEncoder().encode(expected);
  if (providedBytes.byteLength !== expectedBytes.byteLength) return false;
  return timingSafeEqual(providedBytes, expectedBytes);
}

function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('request body must be a JSON object'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"${key}" (string) is required`);
  return value.trim();
}

function requireObject(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`"${key}" (object) is required`);
  return value as Record<string, unknown>;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MEMBER_ROLES: readonly MemberRole[] = ['owner', 'editor', 'viewer'];

function requireId(segment: string | undefined, label: string): string {
  if (!segment || !ID_PATTERN.test(segment)) throw new Error(`invalid ${label}`);
  return segment;
}

function requireRole(body: Record<string, unknown>): MemberRole {
  const role = body.role ?? 'editor';
  if (typeof role !== 'string' || !MEMBER_ROLES.includes(role as MemberRole)) throw new Error('"role" must be owner, editor or viewer');
  return role as MemberRole;
}

async function handleApi(
  api: ControlApi,
  method: string,
  segments: string[],
  request: http.IncomingMessage,
): Promise<{ statusCode: number; payload: unknown }> {
  // segments: path after /api, e.g. ['dapps', '<id>', 'records', '<entity>']
  const [head, second, third, fourth, fifth] = segments;

  if (head === 'status' && method === 'GET') {
    return { statusCode: 200, payload: api.status() };
  }

  if (head === 'control-dapp') {
    if (segments.length === 1 && method === 'GET') {
      return { statusCode: 200, payload: await api.controlDappInfo() };
    }
    if (segments.length === 1 && method === 'POST') {
      return { statusCode: 200, payload: await api.ensureControlDapp() };
    }
  }

  if (head === 'dapps') {
    if (segments.length === 1 && method === 'POST') {
      const body = await readBody(request);
      const id = await api.addByCredentials(requireString(body, 'roomId'), requireString(body, 'roomPassword'));
      return { statusCode: 201, payload: { id } };
    }
    if (second === 'join' && segments.length === 2 && method === 'POST') {
      const body = await readBody(request);
      const id = await api.join(requireString(body, 'invite'));
      return { statusCode: 201, payload: { id } };
    }
    const dappId = requireId(second, 'dapp id');
    if (segments.length === 2 && method === 'DELETE') {
      // A dapp the keeper founded is only dropped on purpose: DELETE …?dropFounded=true
      const dropFounded = new URL(request.url ?? '/', 'http://keeper.local').searchParams.get('dropFounded') === 'true';
      const removed = await api.removeDapp(dappId, { dropFounded });
      return removed
        ? { statusCode: 200, payload: { removed: true } }
        : { statusCode: 404, payload: { error: 'unknown dapp' } };
    }
    if (third === 'grant' && segments.length === 3 && method === 'POST') {
      const body = await readBody(request);
      if (typeof body.accept !== 'boolean') throw new Error('"accept" (true or false) is required');
      return api.decideGrant(dappId, body.accept)
        ? { statusCode: 200, payload: { dappId, joined: body.accept } }
        : { statusCode: 404, payload: { error: 'the keeper holds no approval for this dapp' } };
    }
    if (third === 'entities' && segments.length === 3 && method === 'GET') {
      return { statusCode: 200, payload: api.listEntities(dappId) };
    }
    if (third === 'invites' && segments.length === 3 && method === 'POST') {
      const body = await readBody(request);
      const uses = typeof body.uses === 'number' && Number.isFinite(body.uses) ? body.uses : 1;
      return { statusCode: 201, payload: await api.createInvite(dappId, uses) };
    }
    if (third === 'lobby') {
      if (segments.length === 3 && method === 'GET') {
        return { statusCode: 200, payload: await api.lobby(dappId) };
      }
      if (segments.length === 5 && fifth === 'approve' && method === 'POST') {
        const publicKey = requireId(fourth, 'device key');
        const body = await readBody(request);
        const peer = await api.approveDevice(dappId, publicKey, requireRole(body));
        return { statusCode: 200, payload: { approved: peer.publicKey, displayName: peer.displayName } };
      }
    }
    if (third === 'records') {
      const entityId = requireId(fourth, 'entity id');
      if (segments.length === 4 && method === 'GET') {
        return { statusCode: 200, payload: api.listRecords(dappId, entityId) ?? [] };
      }
      if (segments.length === 4 && method === 'POST') {
        const body = await readBody(request);
        const id = await api.createRecord(dappId, entityId, requireObject(body, 'data'));
        return { statusCode: 201, payload: { id } };
      }
      const recordId = requireId(fifth, 'record id');
      if (segments.length === 5 && method === 'PATCH') {
        const body = await readBody(request);
        await api.updateRecordFields(dappId, entityId, recordId, requireObject(body, 'data'));
        return { statusCode: 200, payload: { updated: true } };
      }
      if (segments.length === 5 && method === 'DELETE') {
        await api.deleteRecordById(dappId, entityId, recordId);
        return { statusCode: 200, payload: { deleted: true } };
      }
    }
  }

  if (head === 'automations') {
    if (segments.length === 1 && method === 'GET') {
      return { statusCode: 200, payload: api.listRules() };
    }
    const ruleId = requireId(second, 'rule id');
    if (segments.length === 2 && method === 'PUT') {
      const body = await readBody(request);
      const rule = api.putRule({
        id: ruleId,
        name: requireString(body, 'name'),
        enabled: body.enabled !== false,
        trigger: requireObject(body, 'trigger') as unknown as AutomationRule['trigger'],
        steps: (Array.isArray(body.steps) ? body.steps : []) as AutomationRule['steps'],
      });
      return { statusCode: 200, payload: rule };
    }
    if (segments.length === 2 && method === 'DELETE') {
      return api.deleteRule(ruleId)
        ? { statusCode: 200, payload: { deleted: true } }
        : { statusCode: 404, payload: { error: 'unknown rule' } };
    }
  }

  return { statusCode: 404, payload: { error: 'not found' } };
}

export function createControlServer(api: ControlApi, options: { token: string }): http.Server {
  return http.createServer((request, response) => {
    try {
      handleRequest(api, options.token, request, response);
    } catch {
      // Parsing attacker-controlled input throws synchronously (`new URL('//', …)`,
      // `decodeURIComponent('%E0%A4%A')`). Before this guard a single
      // unauthenticated request killed the keeper process.
      if (!response.headersSent) sendJson(response, 400, { error: 'malformed request' });
      else response.end();
    }
  });
}

function handleRequest(api: ControlApi, token: string, request: http.IncomingMessage, response: http.ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const method = request.method ?? 'GET';

  if (url.pathname === '/' && method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(DASHBOARD_HTML);
    return;
  }
  if (url.pathname === '/healthz' && method === 'GET') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }
  if (!url.pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'not found' });
    return;
  }

  const authorization = request.headers.authorization ?? '';
  const provided = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  if (!provided || !tokenMatches(provided, token)) {
    sendJson(response, 401, { error: 'missing or invalid bearer token' });
    return;
  }

  const segments = url.pathname.slice('/api/'.length).split('/').filter(Boolean).map(decodeURIComponent);
  handleApi(api, method, segments, request)
    .then(({ statusCode, payload }) => sendJson(response, statusCode, payload))
    .catch((error: unknown) => {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'request failed' });
    });
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dapp Keeper</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 2rem auto; max-width: 60rem; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
  input, button { font: inherit; padding: .35rem .6rem; }
  input { min-width: 16rem; }
  code { font-size: .85em; }
  .muted { opacity: .65; }
  #error { color: #c0392b; }
</style>
</head>
<body>
<h1>🛰️ Dapp Keeper</h1>
<p>
  <label>Access token <input id="token" type="password" placeholder="control token"></label>
  <button id="connect">Connect</button>
  <span id="error"></span>
</p>
<div id="content" hidden>
  <p id="identity" class="muted"></p>
  <p id="integrations" class="muted"></p>
  <h2>Control dapp</h2>
  <div id="control" class="muted">creating…</div>
  <p>
    <button id="new-invite">New single-use invite</button>
    <span class="muted">Open the link on the device that should control the keeper, then approve it below.</span>
  </p>
  <div id="invite" hidden></div>
  <table id="lobby"><thead><tr>
    <th>Waiting device</th><th>Safety number</th><th>Key</th><th></th>
  </tr></thead><tbody></tbody></table>
  <h2>Dapps</h2>
  <table id="dapps"><thead><tr>
    <th>Name</th><th>Role</th><th>Peers</th><th>Members</th><th>Blob mesh</th><th>Status</th>
  </tr></thead><tbody></tbody></table>
  <p>
    <input id="join-invite" placeholder="invite link or dapp://invite/… code">
    <button id="join">Join via invite</button>
  </p>
  <h2>Automations</h2>
  <table id="rules"><thead><tr>
    <th>Name</th><th>Enabled</th><th>Trigger</th><th>Last run</th><th>Last error</th>
  </tr></thead><tbody></tbody></table>
  <p class="muted">Rules are managed via the JSON API (<code>PUT /api/automations/&lt;id&gt;</code>) — see docs/HEADLESS.md.</p>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  let token = '';
  async function call(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || ('HTTP ' + response.status));
    return payload;
  }
  function cell(text) { const td = document.createElement('td'); td.textContent = text; return td; }
  let controlDappId = null;
  async function refreshControl() {
    const info = await call('/api/control-dapp', { method: 'POST' });
    controlDappId = info.dappId;
    const operators = info.operators.length
      ? info.operators.map((device) => device.name + ' (' + device.publicKey.slice(0, 12) + '…)').join(', ')
      : 'none yet — invite your device';
    $('control').textContent = 'Dapp ' + info.dappId + ' · operators: ' + operators;
    const lobby = $('lobby').querySelector('tbody');
    lobby.replaceChildren(...info.lobby.map((peer) => {
      const tr = document.createElement('tr');
      const approve = document.createElement('button');
      approve.textContent = 'Approve as owner';
      approve.addEventListener('click', () => {
        call('/api/dapps/' + info.dappId + '/lobby/' + peer.publicKey + '/approve', { method: 'POST', body: JSON.stringify({ role: 'owner' }) })
          .then(refresh)
          .catch((error) => { $('error').textContent = error.message; });
      });
      const action = document.createElement('td');
      action.append(approve);
      tr.append(cell(peer.displayName), cell(peer.safetyNumber), cell(peer.publicKey.slice(0, 16) + '…'), action);
      return tr;
    }));
  }
  async function refresh() {
    await refreshControl();
    const status = await call('/api/status');
    $('identity').textContent = status.identity.displayName + ' — device key ' + status.identity.publicKey.slice(0, 16) + '… — up since ' + status.startedAt;
    const llm = status.integrations.llm ? status.integrations.llm.model + ' @ ' + status.integrations.llm.baseUrl : 'not configured';
    const n8n = status.integrations.n8n
      ? status.integrations.n8n.url + ' — ' + status.integrations.n8n.delivered + ' delivered, ' + status.integrations.n8n.queued + ' queued'
        + (status.integrations.n8n.lastError ? ', last error: ' + status.integrations.n8n.lastError : '')
      : 'not configured';
    $('integrations').textContent = 'LLM: ' + llm + ' · n8n events: ' + n8n;
    const dapps = $('dapps').querySelector('tbody');
    dapps.replaceChildren(...status.dapps.map((dapp) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(dapp.icon + ' ' + dapp.name),
        cell(dapp.role || '—'),
        cell(String(dapp.connectedPeers)),
        cell(String(dapp.memberCount)),
        cell(dapp.blob.active ? (dapp.blob.peers.length + ' peer(s)') : 'off'),
      );
      const state = cell(dapp.hasCredentials ? 'synced' : dapp.pendingGrant ? '' : 'waiting for owner approval');
      if (!dapp.hasCredentials && dapp.pendingGrant) {
        // Approved by a device that is not an operator: compare the code with that device first.
        const code = String(dapp.pendingGrant.code).replace(/^(\\d{4})(\\d{4})$/, '$1 $2');
        const note = document.createElement('div');
        note.textContent = 'approved by ' + dapp.pendingGrant.approverName + ' — code ' + code + '. Join only if that device shows the same code.';
        const decide = (accept) => () => call('/api/dapps/' + dapp.id + '/grant', { method: 'POST', body: JSON.stringify({ accept }) })
          .then(refresh)
          .catch((error) => { $('error').textContent = error.message; });
        const join = document.createElement('button');
        join.textContent = 'Codes match — join';
        join.addEventListener('click', decide(true));
        const refuse = document.createElement('button');
        refuse.textContent = 'Refuse';
        refuse.addEventListener('click', decide(false));
        state.append(note, join, refuse);
      }
      tr.append(state);
      return tr;
    }));
    const rules = $('rules').querySelector('tbody');
    rules.replaceChildren(...status.automations.map((rule) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(rule.name),
        cell(rule.enabled ? 'yes' : 'no'),
        cell('cron ' + rule.trigger.schedule),
        cell(rule.lastRunAt || '—'),
        cell(rule.lastError || '—'),
      );
      return tr;
    }));
    $('content').hidden = false;
    $('error').textContent = '';
  }
  $('connect').addEventListener('click', () => {
    token = $('token').value.trim();
    refresh().catch((error) => { $('error').textContent = error.message; });
  });
  $('new-invite').addEventListener('click', () => {
    if (!controlDappId) return;
    call('/api/dapps/' + controlDappId + '/invites', { method: 'POST', body: JSON.stringify({ uses: 1 }) })
      .then((invite) => {
        const box = $('invite');
        box.replaceChildren();
        if (invite.link) {
          const a = document.createElement('a');
          a.href = invite.link;
          a.textContent = invite.link;
          a.target = '_blank';
          box.append('Link: ', a, document.createElement('br'));
        }
        const code = document.createElement('code');
        code.textContent = invite.uri;
        box.append('Code: ', code);
        box.hidden = false;
      })
      .catch((error) => { $('error').textContent = error.message; });
  });
  $('join').addEventListener('click', () => {
    const invite = $('join-invite').value.trim();
    if (!invite) return;
    call('/api/dapps/join', { method: 'POST', body: JSON.stringify({ invite }) })
      .then(() => { $('join-invite').value = ''; return refresh(); })
      .catch((error) => { $('error').textContent = error.message; });
  });
  setInterval(() => { if (token) refresh().catch(() => undefined); }, 10000);
</script>
</body>
</html>
`;
