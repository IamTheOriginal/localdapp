// Keeper Control — operator console for an always-on keeper device.
//
// Everything here talks to the keeper through two $store collections in this
// dapp ("keeper" and "commands"); the app never touches the network itself.
// Split into small named functions sharing state through one global
// namespace, the way the To-Do List starter does.
(function () {
  'use strict';

  const STALE_MS = 3 * 60 * 1000; // "keeper not reporting" threshold
  const TIMER_MS = 10 * 1000; // header re-render tick
  const TRANSIENT_MS = 2500; // how long a "Sent." status sticks around
  const MAX_COMMANDS_SHOWN = 30;

  const state = {
    identity: null, // { publicKey, displayName } | null
    keeperKey: null, // the founder of this control dapp = the keeper; only ITS records are believed
    keeper: null, // the keeper's `status` record, or null before first report
    commands: [], // last 30 commands, newest first
    isOperator: false,
    leaveConfirm: Object.create(null), // dappId -> true while awaiting confirmation
    ai: {
      targetDappId: '', // '' = "New dapp"; otherwise the id of an existing, canEdit dapp
      revertConfirm: Object.create(null), // `${dappId}:${revisionId}` -> true while awaiting confirmation
    },
  };

  const KeeperControl = { state };
  globalThis.KeeperControl = KeeperControl;

  // ---------------------------------------------------------------------
  // Small DOM helper: build an element without ever routing record text
  // through innerHTML. `attrs.text` sets textContent; other string/boolean
  // attrs are set with setAttribute; function-valued `onXxx` attrs are
  // wired with addEventListener; children are nodes or plain strings.
  // ---------------------------------------------------------------------
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'text') node.textContent = value;
        else if (key === 'className') node.className = value;
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value === true ? '' : String(value));
      }
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function replaceChildren(node, children) {
    clear(node);
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
  }

  function byId(id) {
    return document.getElementById(id);
  }

  // ---------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------
  function timeAgo(iso) {
    if (!iso) return 'never';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return 'never';
    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
  }

  function shortKey(key) {
    const value = String(key || '');
    return value.length <= 16 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
  }

  function formatSafetyNumber(value) {
    const text = String(value || '--------');
    if (text.length === 8) return `${text.slice(0, 4)} ${text.slice(4)}`;
    return text.length === 6 ? `${text.slice(0, 3)} ${text.slice(3)}` : text;
  }

  function describeError(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function setStatus(node, message, kind) {
    if (!node) return;
    node.textContent = message || '';
    node.className = kind ? `status ${kind}` : 'status';
  }

  function flashOk(node, message) {
    setStatus(node, message, 'ok');
    globalThis.setTimeout(() => {
      if (node.textContent === message) setStatus(node, '', '');
    }, TRANSIENT_MS);
  }

  // ---------------------------------------------------------------------
  // Commands: every operator action creates one `commands` record. The
  // keeper picks it up asynchronously; the command list (subscribed below)
  // shows its progress from `new` through `working` to `done`/`failed`.
  // ---------------------------------------------------------------------
  async function sendCommand(type, args, statusNode) {
    if (!state.isOperator) {
      setStatus(statusNode, 'This device is not an operator — commands from it are ignored.', 'error');
      return false;
    }
    setStatus(statusNode, 'Sending…', '');
    try {
      await $store.create('commands', { type, args, status: 'new' });
      flashOk(statusNode, 'Sent.');
      return true;
    } catch (error) {
      setStatus(statusNode, describeError(error), 'error');
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Header: keeper identity + "last update" + staleness banner
  // ---------------------------------------------------------------------
  function renderHeader() {
    const keeper = state.keeper;
    byId('keeper-name').textContent = keeper
      ? `${keeper.identity && keeper.identity.displayName ? keeper.identity.displayName : 'Keeper'} · started ${timeAgo(keeper.startedAt)}`
      : 'Waiting for keeper…';
    byId('last-update').textContent = keeper ? `last update ${timeAgo(keeper.updatedAt)}` : 'no report yet';

    const isStale = !keeper || (Date.now() - new Date(keeper.updatedAt).getTime()) > STALE_MS;
    byId('stale-banner').hidden = !keeper || !isStale;
  }

  // ---------------------------------------------------------------------
  // Dapps table
  // ---------------------------------------------------------------------
  function buildLeaveControls(dapp, statusNode) {
    if (dapp.isControl) return null;
    if (state.leaveConfirm[dapp.id]) {
      return el('span', { className: 'row' }, [
        el('button', {
          type: 'button',
          className: 'danger small',
          text: 'Confirm leave',
          disabled: !state.isOperator,
          onClick: async () => {
            delete state.leaveConfirm[dapp.id];
            await sendCommand('leave-dapp', { dappId: dapp.id, confirm: true }, statusNode);
            renderDapps();
          },
        }),
        el('button', {
          type: 'button',
          className: 'secondary small',
          text: 'Cancel',
          onClick: () => {
            delete state.leaveConfirm[dapp.id];
            renderDapps();
          },
        }),
      ]);
    }
    return el('button', {
      type: 'button',
      className: 'danger small',
      text: 'Leave',
      disabled: !state.isOperator,
      onClick: () => {
        state.leaveConfirm[dapp.id] = true;
        renderDapps();
      },
    });
  }

  function buildDappRow(dapp) {
    const statusNode = el('div', { className: 'status' });

    const nameCell = el('td', {}, el('div', { className: 'app-cell' }, [
      el('span', { text: `${dapp.icon || '🧩'} ${dapp.name || dapp.id}` }),
      dapp.isControl ? el('span', { className: 'badge badge-control', text: 'Control' }) : null,
    ]));

    const roleCell = el('td', { text: dapp.role || '—' });

    const syncBadge = dapp.hasCredentials
      ? el('span', { className: 'badge badge-synced', text: 'synced' })
      : el('span', { className: 'badge badge-waiting', text: 'waiting for approval' });
    // While the keeper waits in a lobby, show the code each owner device
    // there must display (codes are per owner device) — the operator compares
    // the approving device's code to rule out a man in the middle.
    const approvals = !dapp.hasCredentials && Array.isArray(dapp.pendingApprovals) ? dapp.pendingApprovals : [];
    const syncCell = el('td', {}, [
      syncBadge,
      ...approvals.map((approval) => el('div', { className: 'muted small-text' }, [
        el('span', { text: 'code ' }),
        el('strong', { className: 'code-frag', text: formatSafetyNumber(approval.safetyNumber) }),
        el('span', { text: ` · owner ${approval.ownerDisplayName} is in the lobby` }),
      ])),
      !dapp.hasCredentials && approvals.length === 0 && !dapp.pendingGrant
        ? el('div', { className: 'muted small-text', text: 'no owner device in the lobby yet' })
        : null,
      // Approved by a device that is not an operator of this keeper: anyone holding the invite
      // link can pose as an owner, so a person compares the code with the approving device first.
      !dapp.hasCredentials && dapp.pendingGrant
        ? el('div', { className: 'small-text' }, [
          el('div', {}, [
            el('span', { text: `approved by ${dapp.pendingGrant.approverName} — code ` }),
            el('strong', { className: 'code-frag', text: formatSafetyNumber(dapp.pendingGrant.code) }),
          ]),
          el('div', { className: 'muted', text: 'Join only if that device shows the same code for the keeper.' }),
          el('button', {
            type: 'button', className: 'small', text: 'Codes match — join', disabled: !state.isOperator,
            onClick: () => sendCommand('confirm-join', { dappId: dapp.id, accept: true }, statusNode),
          }),
          el('button', {
            type: 'button', className: 'secondary small', text: 'Refuse', disabled: !state.isOperator,
            onClick: () => sendCommand('confirm-join', { dappId: dapp.id, accept: false }, statusNode),
          }),
        ])
        : null,
    ]);

    const peersCell = el('td', { text: String(dapp.connectedPeers ?? 0) });
    const membersCell = el('td', { text: String(dapp.memberCount ?? 0) });

    const replicationCell = el('td', {}, el('button', {
      type: 'button',
      className: 'secondary small',
      text: dapp.blobReplication === 'pinAll' ? 'Pin all' : 'On demand',
      disabled: !state.isOperator,
      onClick: () => sendCommand(
        'set-replication',
        { dappId: dapp.id, mode: dapp.blobReplication === 'pinAll' ? 'onDemand' : 'pinAll' },
        statusNode,
      ),
    }));

    const actionButtons = [];
    if (dapp.role === 'owner') {
      actionButtons.push(el('button', {
        type: 'button',
        className: 'secondary small',
        text: 'Invite',
        disabled: !state.isOperator,
        onClick: async () => {
          if (await sendCommand('create-invite', { dappId: dapp.id }, statusNode)) {
            setStatus(statusNode, 'Invite requested — the link appears under this row in a moment.', 'ok');
          }
        },
      }));
    }
    const leaveControls = buildLeaveControls(dapp, statusNode);
    if (leaveControls) actionButtons.push(leaveControls);

    const actionsCell = el('td', {}, [
      el('div', { className: 'row' }, actionButtons.length ? actionButtons : [el('span', { className: 'muted', text: '—' })]),
      statusNode,
    ]);

    return el('tr', {}, [nameCell, roleCell, syncCell, peersCell, membersCell, replicationCell, actionsCell]);
  }

  function buildLobbyEntry(dapp, entry) {
    const statusNode = el('div', { className: 'status' });
    const roleSelect = el('select', { 'aria-label': `Role for ${entry.displayName || shortKey(entry.publicKey)}` }, [
      el('option', { value: 'owner', text: 'Owner' }),
      el('option', { value: 'editor', text: 'Editor', selected: true }),
      el('option', { value: 'viewer', text: 'Viewer' }),
    ]);
    roleSelect.value = 'editor';

    // A rejoin is a member that lost its copy: approval only re-sends the
    // credentials (to the key stored for that member); its role stays as it is.
    return el('div', { className: 'lobby-entry' }, [
      el('span', { text: entry.displayName || 'Unnamed device' }),
      el('span', { className: 'key-frag', text: shortKey(entry.publicKey) }),
      el('span', { className: 'pill', text: `safety ${formatSafetyNumber(entry.safetyNumber)}` }),
      entry.rejoin ? el('span', { className: 'muted small-text', text: 'already a member — asks to be let back in' }) : roleSelect,
      el('button', {
        type: 'button',
        className: 'small',
        text: entry.rejoin ? 'Let back in' : 'Approve',
        disabled: !state.isOperator,
        onClick: () => sendCommand('approve-device', {
          dappId: dapp.id,
          publicKey: entry.publicKey,
          role: roleSelect.value,
        }, statusNode),
      }),
      statusNode,
    ]);
  }

  /** Newest finished command that produced an invite for this dapp (create-invite or create-dapp). */
  function latestInviteFor(dapp) {
    return state.commands.find((command) => {
      if (command.status !== 'done' || !command.result || !command.result.uri) return false;
      const target = (command.args && command.args.dappId) || command.result.dappId;
      return target === dapp.id;
    }) || null;
  }

  function buildInviteRow(dapp) {
    const command = latestInviteFor(dapp);
    if (!command) return null;
    return el('tr', { className: 'lobby-row' }, el('td', { colspan: '7' }, [
      el('div', { className: 'muted', text: `Latest invite (${timeAgo(command.finishedAt || command.createdAt)}) — open it on the device that should join:` }),
      buildInviteResult(command.result),
    ]));
  }

  function buildLobbyRow(dapp) {
    if (!dapp.lobby || dapp.lobby.length === 0) return null;
    return el('tr', { className: 'lobby-row' }, el('td', { colspan: '7' }, [
      el('div', { className: 'muted', text: 'Waiting to join:' }),
      ...dapp.lobby.map((entry) => buildLobbyEntry(dapp, entry)),
    ]));
  }

  function renderDapps() {
    const dapps = (state.keeper && state.keeper.dapps) || [];
    byId('dapps-empty').hidden = dapps.length > 0;
    byId('dapps-table').hidden = dapps.length === 0;
    const body = byId('dapps-body');
    const rows = [];
    for (const dapp of dapps) {
      rows.push(buildDappRow(dapp));
      const inviteRow = buildInviteRow(dapp);
      if (inviteRow) rows.push(inviteRow);
      const lobbyRow = buildLobbyRow(dapp);
      if (lobbyRow) rows.push(lobbyRow);
    }
    replaceChildren(body, rows);
  }

  // ---------------------------------------------------------------------
  // AI card — model selection plus create/update/revert-dapp commands
  // ---------------------------------------------------------------------
  function buildRevisionRow(dapp, revision) {
    const statusNode = el('div', { className: 'status' });
    const confirmKey = `${dapp.id}:${revision.id}`;

    const revertControl = state.ai.revertConfirm[confirmKey]
      ? el('span', { className: 'row' }, [
        el('button', {
          type: 'button',
          className: 'danger small',
          text: 'Confirm revert',
          disabled: !state.isOperator,
          onClick: async () => {
            delete state.ai.revertConfirm[confirmKey];
            await sendCommand('revert-dapp', { dappId: dapp.id, revision: revision.id }, statusNode);
            renderAi();
          },
        }),
        el('button', {
          type: 'button',
          className: 'secondary small',
          text: 'Cancel',
          onClick: () => {
            delete state.ai.revertConfirm[confirmKey];
            renderAi();
          },
        }),
      ])
      : el('button', {
        type: 'button',
        className: 'secondary small',
        text: 'Revert',
        disabled: !state.isOperator,
        onClick: () => {
          state.ai.revertConfirm[confirmKey] = true;
          renderAi();
        },
      });

    return el('div', { className: 'revision-row' }, [
      el('div', { className: 'revision-info' }, [
        el('div', { text: timeAgo(revision.at) }),
        el('div', { className: 'muted', text: revision.note || '' }),
      ]),
      revertControl,
      statusNode,
    ]);
  }

  function renderAiModel(llm) {
    const select = byId('ai-model-select');
    const useButton = byId('ai-use-model-btn');
    const meta = byId('ai-model-meta');

    const models = (llm && llm.models) || [];
    const current = (llm && llm.model) || '';
    const optionValues = models.slice();
    if (current && !optionValues.includes(current)) optionValues.push(current);

    replaceChildren(select, optionValues.map((name) => el('option', { value: name, text: name })));
    select.value = current;
    select.disabled = optionValues.length === 0;
    useButton.disabled = !state.isOperator || optionValues.length === 0;

    if (optionValues.length === 0) {
      meta.textContent = (llm && llm.modelsError) || 'no models reported by the gateway';
    } else {
      meta.textContent = llm && llm.baseUrl ? `base ${llm.baseUrl}` : '';
    }
  }

  function renderAiTarget() {
    const dapps = (state.keeper && state.keeper.dapps) || [];
    const editable = dapps.filter((dapp) => dapp.canEdit);
    if (state.ai.targetDappId && !editable.some((dapp) => dapp.id === state.ai.targetDappId)) {
      state.ai.targetDappId = '';
    }

    const select = byId('ai-target-select');
    replaceChildren(select, [el('option', { value: '', text: 'New dapp' })].concat(
      editable.map((dapp) => el('option', { value: dapp.id, text: `${dapp.icon || '🧩'} ${dapp.name || dapp.id}` })),
    ));
    select.value = state.ai.targetDappId;

    const targetDapp = editable.find((dapp) => dapp.id === state.ai.targetDappId) || null;
    byId('ai-new-dapp-fields').hidden = Boolean(targetDapp);
    byId('ai-submit-btn').textContent = targetDapp ? 'Apply change' : 'Generate';
    byId('ai-submit-btn').disabled = !state.isOperator;

    const revisionsWrap = byId('ai-revisions-wrap');
    revisionsWrap.hidden = !targetDapp;
    if (targetDapp) {
      const revisions = targetDapp.revisions || [];
      byId('ai-revisions-empty').hidden = revisions.length > 0;
      replaceChildren(byId('ai-revisions-list'), revisions.map((revision) => buildRevisionRow(targetDapp, revision)));
    }
  }

  function renderAi() {
    const llm = (state.keeper && state.keeper.integrations && state.keeper.integrations.llm) || null;
    renderAiModel(llm);
    renderAiTarget();
  }

  async function handleAiSubmit() {
    const promptNode = byId('ai-prompt');
    const statusNode = byId('ai-status');
    const prompt = promptNode.value.trim();
    if (!prompt) {
      setStatus(statusNode, 'Describe what you want first.', 'error');
      promptNode.focus();
      return;
    }

    const targetDappId = state.ai.targetDappId;
    let ok;
    if (targetDappId) {
      ok = await sendCommand('update-dapp', { dappId: targetDappId, prompt }, statusNode);
    } else {
      const args = { prompt };
      const name = byId('ai-new-name').value.trim();
      const icon = byId('ai-new-icon').value.trim();
      const color = byId('ai-new-color').value.trim();
      if (name) args.name = name;
      if (icon) args.icon = icon;
      if (color) args.color = color;
      ok = await sendCommand('create-dapp', args, statusNode);
    }
    if (ok) {
      setStatus(statusNode, 'Sent — generation takes a few minutes; watch the Commands card.', 'ok');
    }
  }

  // ---------------------------------------------------------------------
  // Automations
  // ---------------------------------------------------------------------
  function buildAutomationRow(rule) {
    const statusNode = el('div', { className: 'status' });
    return el('div', { className: 'automation-row' }, [
      el('div', { className: 'automation-info' }, [
        el('div', { className: 'name', text: `${rule.name}${rule.enabled ? '' : ' (disabled)'}` }),
        el('div', { className: 'muted', text: `Cron: ${(rule.trigger && rule.trigger.schedule) || '—'}` }),
        el('div', { className: 'muted', text: `Last run: ${rule.lastRunAt ? timeAgo(rule.lastRunAt) : 'never'}` }),
        rule.lastError ? el('div', { className: 'command-error', text: `Last error: ${rule.lastError}` }) : null,
        statusNode,
      ]),
      el('div', { className: 'automation-actions' }, [
        el('button', {
          type: 'button',
          className: 'secondary small',
          text: 'Run',
          disabled: !state.isOperator,
          onClick: () => sendCommand('run-rule', { ruleId: rule.id }, statusNode),
        }),
        el('button', {
          type: 'button',
          className: 'danger small',
          text: 'Delete',
          disabled: !state.isOperator,
          onClick: () => sendCommand('delete-rule', { ruleId: rule.id }, statusNode),
        }),
      ]),
    ]);
  }

  function renderAutomations() {
    const automations = (state.keeper && state.keeper.automations) || [];
    byId('automations-empty').hidden = automations.length > 0;
    replaceChildren(byId('automations-list'), automations.map(buildAutomationRow));

    const putButton = byId('put-rule-btn');
    putButton.disabled = !state.isOperator;
  }

  const EXAMPLE_RULE = {
    id: 'morning-report',
    name: 'Morning report',
    enabled: true,
    trigger: { kind: 'cron', schedule: '0 8 * * *' },
    steps: [
      {
        kind: 'create-record',
        dappId: 'REPLACE-WITH-DAPP-ID',
        collection: 'reports',
        data: { title: 'Morning report', createdAt: '{{now.iso}}' },
      },
    ],
  };

  function handlePutRule() {
    const textarea = byId('rule-json');
    const statusNode = byId('rule-status');
    let parsed;
    try {
      parsed = JSON.parse(textarea.value);
    } catch (error) {
      setStatus(statusNode, `Invalid JSON: ${describeError(error)}`, 'error');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || typeof parsed.id !== 'string' || !parsed.id.trim()
      || typeof parsed.name !== 'string' || !parsed.name.trim()) {
      setStatus(statusNode, 'The rule needs at least string "id" and "name" fields.', 'error');
      return;
    }
    sendCommand('put-rule', { rule: parsed }, statusNode);
  }

  // ---------------------------------------------------------------------
  // Integrations
  // ---------------------------------------------------------------------
  function buildLlmSection(llm) {
    if (!llm) return el('div', { className: 'muted', text: 'LLM integration not configured.' });
    const modelCount = (llm.models || []).length;
    const modelLabel = `${modelCount} model${modelCount === 1 ? '' : 's'} available`;
    return el('div', { className: 'stack' }, [
      el('div', {}, [el('strong', { text: 'LLM: ' }), el('span', { text: llm.baseUrl || '—' })]),
      el('div', { className: 'muted', text: `${llm.model || 'No model selected'} · ${modelLabel}` }),
      el('div', { className: 'muted', text: `Key ${llm.keyConfigured ? 'configured' : 'not configured'}` }),
    ]);
  }

  function buildN8nSection(n8n) {
    if (!n8n) return el('div', { className: 'muted', text: 'n8n integration not configured.' });
    return el('div', { className: 'stack' }, [
      el('div', {}, [el('strong', { text: 'n8n: ' }), el('span', { text: n8n.url || '—' })]),
      el('div', { className: 'muted', text: `Delivered ${n8n.delivered ?? 0} · Queued ${n8n.queued ?? 0} · Dropped ${n8n.dropped ?? 0}` }),
      el('div', { className: 'muted', text: `Last delivered: ${n8n.lastDeliveredAt ? timeAgo(n8n.lastDeliveredAt) : 'never'}` }),
      n8n.lastError ? el('div', { className: 'command-error', text: `Last error: ${n8n.lastError}` }) : null,
    ]);
  }

  function renderIntegrations() {
    const integrations = (state.keeper && state.keeper.integrations) || null;
    replaceChildren(byId('integrations-list'), [
      buildLlmSection(integrations && integrations.llm),
      buildN8nSection(integrations && integrations.n8n),
    ]);
  }

  // ---------------------------------------------------------------------
  // Operators
  // ---------------------------------------------------------------------
  function renderOperators() {
    const operators = (state.keeper && state.keeper.operators) || [];
    byId('operators-empty').hidden = operators.length > 0;
    replaceChildren(byId('operators-list'), operators.map((operator) => el('li', {}, [
      el('span', { text: operator.name || 'Unnamed device' }),
      el('span', { className: 'key-frag', text: shortKey(operator.publicKey) }),
    ])));

    byId('operator-notice').hidden = state.isOperator;
    byId('operator-banner').hidden = state.isOperator;
  }

  // ---------------------------------------------------------------------
  // Commands list
  // ---------------------------------------------------------------------
  function summarizeArgs(command) {
    const args = command.args || {};
    switch (command.type) {
      case 'join-invite': return String(args.invite || '');
      case 'leave-dapp': return `dapp ${shortKey(args.dappId)}`;
      case 'set-replication': return `${shortKey(args.dappId)} → ${args.mode}`;
      case 'create-invite': return `dapp ${shortKey(args.dappId)}${args.uses ? ` · ${args.uses} uses` : ''}`;
      case 'approve-device': return `${shortKey(args.dappId)} · ${shortKey(args.publicKey)} as ${args.role}`;
      case 'put-rule': return (args.rule && (args.rule.name || args.rule.id)) || '';
      case 'delete-rule':
      case 'run-rule': return `rule ${args.ruleId || ''}`;
      case 'set-model': return args.model || '';
      case 'create-dapp': return [args.name, args.prompt].filter(Boolean).join(' — ');
      case 'update-dapp': return `${shortKey(args.dappId)}: ${args.prompt || ''}`;
      case 'revert-dapp': return `${shortKey(args.dappId)} → revision ${args.revision || ''}`;
      default: {
        try { return JSON.stringify(args); } catch { return ''; }
      }
    }
  }

  function buildInviteResult(result) {
    const uriRow = el('div', { className: 'invite-row' }, [
      el('span', { className: 'invite-uri', text: result.uri || '' }),
    ]);
    if (result.uri) {
      const copyStatus = el('span', { className: 'status' });
      uriRow.appendChild(el('button', {
        type: 'button',
        className: 'secondary small',
        text: 'Copy',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(result.uri);
            flashOk(copyStatus, 'Copied.');
          } catch (error) {
            setStatus(copyStatus, describeError(error), 'error');
          }
        },
      }));
      uriRow.appendChild(copyStatus);
    }
    const children = [uriRow];
    if (typeof result.link === 'string' && /^https?:\/\//i.test(result.link)) {
      children.unshift(el('div', { className: 'invite-row' }, el('a', { href: result.link, text: result.link })));
    }
    return el('div', { className: 'invite-box' }, children);
  }

  function buildCommandResult(command) {
    if (command.status === 'failed') {
      return el('div', { className: 'command-error', text: command.error || 'Failed.' });
    }
    if (command.status === 'done' && command.result) {
      const result = command.result;
      const extras = [];
      if (command.type === 'create-invite' && typeof result.uri === 'string') {
        extras.push(buildInviteResult(result));
      } else if (typeof result.inviteLink === 'string') {
        extras.push(buildInviteResult({ uri: result.inviteUri, link: result.inviteLink }));
      }
      if (Array.isArray(result.changedFiles) && result.changedFiles.length > 0) {
        extras.push(el('div', { className: 'muted small-text', text: result.changedFiles.join(', ') }));
      }
      let pretty = '';
      try { pretty = JSON.stringify(result, null, 2); } catch { pretty = String(result); }
      extras.push(el('details', {}, [
        el('summary', { text: 'Result' }),
        el('pre', { text: pretty }),
      ]));
      return el('div', { className: 'command-result' }, extras);
    }
    return null;
  }

  function buildCommandRow(command) {
    const metaParts = [`Created ${timeAgo(command.createdAt)}`];
    if (command.finishedAt) metaParts.push(`finished ${timeAgo(command.finishedAt)}`);

    return el('div', { className: 'command-row' }, [
      el('div', { className: 'command-head' }, [
        el('span', { className: 'command-type', text: command.type }),
        el('span', { className: `badge badge-${command.status}`, text: command.status }),
      ]),
      el('div', { className: 'command-args', text: summarizeArgs(command) }),
      el('div', { className: 'command-meta', text: metaParts.join(' · ') }),
      buildCommandResult(command),
    ]);
  }

  function renderCommands() {
    byId('commands-empty').hidden = state.commands.length > 0;
    replaceChildren(byId('commands-list'), state.commands.map(buildCommandRow));
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  function recomputeOperatorStatus() {
    const operators = (state.keeper && state.keeper.operators) || [];
    state.isOperator = Boolean(
      state.identity
      && operators.some((operator) => operator.publicKey === state.identity.publicKey),
    );
  }

  function renderAll() {
    renderHeader();
    recomputeOperatorStatus();
    renderAi();
    renderDapps();
    renderAutomations();
    renderIntegrations();
    renderOperators();
    renderCommands();

    const joinButton = byId('join-btn');
    joinButton.disabled = !state.isOperator;
  }

  function wireStaticControls() {
    byId('join-btn').addEventListener('click', () => {
      const input = byId('invite-input');
      if (!input.reportValidity()) return;
      const value = input.value.trim();
      if (!value) return;
      sendCommand('join-invite', { invite: value }, byId('join-status')).then((ok) => {
        if (ok) input.value = '';
      });
    });

    byId('put-rule-btn').addEventListener('click', handlePutRule);
    byId('rule-json').value = JSON.stringify(EXAMPLE_RULE, null, 2);

    byId('ai-use-model-btn').addEventListener('click', () => {
      const model = byId('ai-model-select').value;
      sendCommand('set-model', { model }, byId('ai-model-status'));
    });
    byId('ai-target-select').addEventListener('change', (event) => {
      state.ai.targetDappId = event.target.value;
      renderAi();
    });
    byId('ai-submit-btn').addEventListener('click', handleAiSubmit);
  }

  // Every editor of this dapp can write into both collections. What the keeper "said" — its
  // status (approval codes!) and command results (links, invites) — is only believed when the
  // keeper's key signed the record; a command still waiting ('new') is the operator's own.
  function fromKeeper(record) {
    return Boolean(state.keeperKey) && Boolean(record) && record._signedBy === state.keeperKey;
  }

  function trustedCommand(command) {
    if (command.status === 'new' || fromKeeper(command)) return command;
    return Object.assign({}, command, { status: 'failed', result: null, error: 'Ignored: this result was not written by the keeper.' });
  }

  Dapp.onReady(async (context) => {
    state.identity = context.identity || null;
    state.keeperKey = (context.meta && context.meta.createdBy) || null;
    wireStaticControls();
    renderAll();

    await $store.subscribe('keeper', {}, (records) => {
      state.keeper = records.find((record) => record.id === 'status' && fromKeeper(record)) || null;
      renderAll();
    });

    await $store.subscribe('commands', {}, (records) => {
      state.commands = records
        .map(trustedCommand)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        .slice(0, MAX_COMMANDS_SHOWN);
      renderCommands();
      renderDapps();
    });

    globalThis.setInterval(renderHeader, TIMER_MS);
  });
})();
