# Headless runtime ("keeper node")

An always-on dapp peer without a UI: `npm run headless` (or the Docker image)
starts a Node process that joins your dapps exactly like another browser device
— same member mesh and documents, same Ed25519 identity and signing, same
auth/rekey observers — and stays online so your data and files are
available even when all your interactive devices are asleep.

What it gives you:

- **Data availability** — every joined dapp's main + source docs are kept
  synced and durably persisted to disk; peers that come online later can pull
  state from the keeper (including the chunked doc-sync path for large docs).
- **File availability** — the blob mesh runs with pin-all replication by
  default: the keeper fetches and pins every indexed file, and serves chunks
  to members (after the usual Ed25519 membership handshake).
- **Cron automations** — the first wired execution path for the automation
  engine (`src/automations/`): cron-triggered rules that create/update signed
  records run on the keeper on schedule.
- **An API for agents and scripts** — a token-guarded JSON control surface for
  status, joining/removing dapps, record CRUD (as a normal signed member
  write), and automation rule management, plus a small status dashboard.

Requires **Node ≥ 23.6** (the launcher runs the TypeScript sources in
`src/headless/` via native type stripping — no build step).

## Quick start (local)

```sh
npm run signaling      # broker on ws://127.0.0.1:4444 (or use your deployed one)
npm run headless
```

First boot creates `./headless-data/` with the device identity and a control
token, prints both, and serves the control surface on `http://127.0.0.1:8788/`.
The token is printed on that first boot only (so it does not pile up in
`docker logs`); afterwards read `controlToken` from `headless-data/config.json`.

Environment variables (all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `HEADLESS_DATA_DIR` | `./headless-data` | Data directory (identity, config, docs, blob chunks) |
| `SIGNALING_URLS` | `ws://127.0.0.1:4444` | Signaling broker endpoint(s), comma/space separated |
| `HEADLESS_HOST` / `HEADLESS_PORT` | `127.0.0.1` / `8788` | Control surface bind address |
| `HEADLESS_TOKEN` | generated | Control API bearer token |
| `HEADLESS_DISPLAY_NAME` | `Headless Keeper` | Device display name shown to peers |
| `HEADLESS_REPLICATE_FILES` | `true` | `false` disables pin-all blob replication |
| `ICE_SERVERS` | unset | `RTCIceServer[]` JSON (STUN/TURN), same format as `VITE_ICE_SERVERS` |
| `ICE_SERVERS_URL` / `ICE_ACCESS_TOKEN` | unset | Dynamic HTTPS endpoint returning ephemeral `{ iceServers, ttl }` JSON (e.g. Cloudflare Worker `/ice`, see `docs/CLOUDFLARE.md`) and optional bearer token |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | unset | OpenAI-compatible chat endpoint (base URL incl. `/v1`), key, and the model that seeds the first boot — see [LLM endpoint](#llm-endpoint) |
| `N8N_WEBHOOK_URL` / `N8N_WEBHOOK_SECRET` | unset | Webhook that receives every record event — see [Events → n8n](#events--n8n) |
| `HEADLESS_APP_URL` | unset | Web app origin (e.g. `https://dapp.example`) used to render clickable invite links; without it only `dapp://` codes are shown |

Values persist in `<dataDir>/config.json`; env vars override and are written
back, so the file always shows the effective configuration.

## Joining dapps

The keeper is a **device like any other** — it cannot grant itself access.

1. **Invite flow (recommended):** create an invite in the dapp
   (Settings → invite), paste it into the dashboard (or `POST /api/dapps/join`)
   — either the clickable `https://…/invite#code=…` link the browser UI shares
   or the raw `dapp://invite/app/…` code works. The keeper waits in the lobby;
   approve it from an owner device (verify the safety number as usual) and pick
   its role. Status shows "waiting for owner approval" until then. Contact
   pairing invites (`dapp://invite/pair/…`) are rejected — pairing is a
   browser-device flow.
   **Who approved?** Anyone holding the invite link can pose as an owner in
   the lobby, so a joining device only uses an approval once somebody
   confirmed the approving device. The keeper uses an approval signed by one
   of its **operators** (owners of the control dapp) at once — invite it from
   an operator device and nothing changes. An approval by any other device is
   held: status and the control dapp show `pendingGrant` ("approved by X —
   code N"); compare the code with the one that device shows for the keeper,
   then send `confirm-join` (control dapp) or `POST /api/dapps/:id/grant`.
2. **Direct credentials (agents/tooling):** `POST /api/dapps` with
   `{roomId, roomPassword}` from a device you own. Credentials alone no longer
   sync anything: dapp data travels only between devices that prove a member
   key, so the keeper stays empty until an owner has added its key as a member
   (the invite flow above does both in one step — prefer it).

An **owner keeper** also acts as the always-online approver for 1-step
(auto-approve) invites: devices that show up in such an invite's lobby are
admitted automatically even when no browser device is open. Regular invites
still require a person to verify the safety number.

Removing the keeper from a dapp works like removing any member: every other
device refuses its connections and drops open ones as soon as the removal has
synced, so its cached credentials stop granting read access going forward.

## Control API

All `/api` routes require `Authorization: Bearer <token>`. The dashboard at
`/` is a thin client of the same API.

| Route | Meaning |
| --- | --- |
| `GET /api/status` | Identity, per-dapp sync/blob/role status, automation rules |
| `POST /api/dapps/join` `{invite}` | Join via invite link or `dapp://invite/app/…` code |
| `POST /api/dapps` `{roomId, roomPassword}` | Direct add with known credentials |
| `DELETE /api/dapps/:id` | Leave a dapp (signed departure, so the others stop listing the keeper) and purge its local state. Refused for a dapp the keeper founded — the founding owner cannot leave; `?dropFounded=true` drops the local copy anyway (the keeper then stays a member that holds nothing until an owner lets it back in through an invite) |
| `GET /api/dapps/:id/entities` | Schema entities with record counts |
| `GET /api/dapps/:id/records/:entity` | List records (canonical `$store` read) |
| `POST /api/dapps/:id/records/:entity` `{data}` | Create a signed record (requires editor role) |
| `PATCH /api/dapps/:id/records/:entity/:recordId` `{data}` | Update a record |
| `DELETE /api/dapps/:id/records/:entity/:recordId` | Delete (signed tombstone) |
| `GET /api/control-dapp` | Control dapp info (`null` until created): id, operator devices, devices waiting in its lobby |
| `POST /api/control-dapp` | Create the control dapp if missing (idempotent), then the same info |
| `POST /api/dapps/:id/invites` `{uses?}` | Create an invite for a dapp the keeper owns → `{uri, link}` |
| `GET /api/dapps/:id/lobby` | Devices waiting in that dapp's invite lobbies, with safety numbers |
| `POST /api/dapps/:id/lobby/:publicKey/approve` `{role?}` | Admit a waiting device (default editor) |
| `POST /api/dapps/:id/grant` `{accept}` | Use (`true`) or refuse (`false`) an approval the keeper holds for a dapp it is joining — see "Who approved?" above; 404 when it holds none |
| `GET /api/automations` | List rules |
| `PUT /api/automations/:id` `{name, trigger, steps, enabled?}` | Create/replace a rule |
| `DELETE /api/automations/:id` | Delete a rule |

Automation rule example — a daily 08:00 record:

```sh
curl -X PUT http://127.0.0.1:8788/api/automations/daily-checkin \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "Daily check-in",
    "trigger": { "kind": "cron", "schedule": "0 8 * * *" },
    "steps": [{
      "kind": "create-record", "dappId": "<dappId>", "collection": "entries",
      "data": { "title": "Check-in {{now.date}}", "createdAtTime": "{{now.time}}" }
    }]
  }'
```

Steps support `{{trigger.*}}` / `{{now.iso|date|time}}` templates
(`src/automations/engine.ts`). Only cron triggers and record steps exist;
event triggers and `publish-event` steps were removed until a headless Code
App host exists to run them.

## Control dapp

Opening the dashboard creates the **Keeper Control** dapp (once; its id is
kept in `config.json`) with the keeper as founding owner and the Code App from
`src/headless/controlDapp/` as its source. The dashboard then offers a
single-use invite: open it on the device that should steer the keeper, and
approve that device **as owner** in the dashboard's lobby table (the safety
number is shown for comparison; the token-guarded dashboard is what makes
this click trustworthy). From then on the dapp is the operator console and
the dashboard is a fallback.

- **Operators** are the control dapp's owner devices other than the keeper.
  Only commands whose *verified signer* (`_signedBy`, set by the auth
  observer — not the writer-claimed `createdBy`) is an operator are executed;
  editors and viewers of the control dapp can read everything but the keeper
  ignores their commands.
- **Auto-owner:** when an operator device shows up in the invite lobby of any
  *other* dapp the keeper owns, the keeper admits it as owner without a
  safety-number ceremony (the key was verified once, in the dashboard). No
  other device is ever admitted automatically; the link-based `autoApprove`
  invite flag stays capped at editor.
- **Collections** (all written through the normal signed record path):
  `keeper` — one record `status` the keeper refreshes every 30 s (identity,
  operators, per-dapp role/peers/replication + waiting lobby devices,
  automation rules, integrations — and, for a dapp the keeper joined but is
  not yet approved in, `pendingApprovals` = one connection code per owner
  device in the lobby (each owner device shows its own), so the operator can
  rule out a man in the middle before admitting the keeper there); `commands` — `{type, args, status}`
  records operators create with `status: 'new'`; the keeper moves them to
  `working` and then `done` (`result`) or `failed` (`error`). Types:
  `join-invite {invite}`, `leave-dapp {dappId, confirm: true}` (refused for a
  dapp the keeper founded unless `dropFounded: true` is sent too),
  `set-replication {dappId, mode}`, `create-invite {dappId, uses?}` (keeper-
  owned dapps only), `approve-device {dappId, publicKey, role}`,
  `confirm-join {dappId, accept?}` (use or refuse an approval the keeper
  holds from a non-operator device),
  `put-rule {rule}`, `delete-rule {ruleId}`, `run-rule {ruleId}`, and the AI
  commands below. A `working` command found after a keeper restart is marked
  `failed`. A command runs **once** and only while it is fresh: the keeper
  remembers the ids it started (`executed-commands.json`) and refuses commands
  whose `createdAt` is more than 10 minutes away from its own clock — a copy
  of an old, validly signed command that somebody puts back is answered with
  `failed`. Commands sent while the keeper was offline for longer have to be
  sent again; keep the clocks of the keeper and the operator devices in sync.
- The shipped bundle in `src/headless/controlDapp/` is the dapp's source of
  truth: on every boot the keeper replaces the dapp's source when the files
  differ, so a keeper upgrade updates the app. Edits made in the code editor
  are therefore overwritten; fork the bundle instead.
- The control dapp is excluded from the n8n event feed (it is keeper-internal
  chatter). `set-replication onDemand` lasts until the next boot while
  `HEADLESS_REPLICATE_FILES` is `true`, which re-pins every dapp.

## AI dapp creation and editing

With an LLM endpoint configured, the control dapp's AI card drives four more
commands. Everything the model produces passes the same validation as an
imported `.dapp` file (file map + manifest parse) before anything is written;
one repair round feeds the validation error back to the model.

- `set-model {model}` — pick one of the names the gateway lists
  (`GET <LLM_BASE_URL>/models`, refreshed every 5 min into the status record).
  Persisted in `config.json`; `LLM_MODEL` only seeds a missing choice.
- `create-dapp {prompt, name?, icon?, color?}` — the keeper creates a new
  dapp it owns from the generated file map and answers with a single-use
  invite per operator device; operators are admitted as owner on arrival.
- `update-dapp {dappId, prompt}` — stateless edit of a dapp the keeper owns:
  the current source is the context, the model returns the complete new file
  map, the manifest's entities and identity are re-synced like an editor save.
- `revert-dapp {dappId, revision}` — restore a snapshot.

Snapshots (`<dataDir>/revisions/<dappId>/<timestamp>.json`) are taken before
every edit and revert and listed per dapp in the status record. The system
prompt is `docs/code-apps/README.md` + `AGENT-INSTRUCTIONS.md`, read from the
`docs/` directory next to `src/` (the Docker image copies it). The control
dapp itself is never AI-edited — its source is the shipped bundle.

## Events → n8n

With `N8N_WEBHOOK_URL` set, the keeper POSTs one JSON envelope per verified
record change in every dapp it has credentials for:

```json
{ "type": "record-created" | "record-updated" | "record-deleted",
  "at": "<keeper clock, ISO>", "dappId": "…", "dappName": "…",
  "collection": "<entity id>", "record": { … }, "previous": { … } }
```

`previous` is present for updates and deletions the keeper watched happen.
`Authorization: Bearer <N8N_WEBHOOK_SECRET>` is sent when a secret is set;
check it in the n8n Webhook node (Header Auth). Only records the auth
observer accepted are reported — never raw doc state.

- The keeper does **no** filtering or routing: every dapp, every collection,
  including its own writes (`createdBy` tells them apart). Route in n8n
  (Switch on `dappId` / `collection` / `type`). A workflow that writes back
  into the collection it listens to will see its own writes come around.
- Delivery is one in-order queue with exponential backoff (1 s → 5 min);
  an event that could not be delivered for 24 h is dropped with a log line.
  The queue is kept in `event-queue.json`, so a keeper restart during an n8n
  outage loses nothing. An event n8n answers with a 4xx (other than 408 / 429)
  is dropped after 5 attempts instead of holding up everything behind it, and
  the queue holds at most 5,000 events (the oldest are dropped first).
  `GET /api/status` → `integrations.n8n` shows queued/delivered/dropped and
  the last error; the dashboard prints the same line.
- Restarts: `events.json` in the data dir keeps, per dapp, the newest record
  timestamp already handled. After a boot the observer's first scan re-emits
  everything, and only records created/updated after that cursor are
  delivered. A dapp the keeper sees for the first time is *not* replayed —
  its existing records are the baseline; events start with the next change.
  The cursor never moves past the keeper's own clock: record timestamps are
  written by the members' devices, and one future-dated record would otherwise
  hide every later change after a restart (such a record is delivered again
  after each restart until its date has passed).
- Set `N8N_WEBHOOK_URL=` (empty) to switch delivery off again; the setting is
  persisted in `config.json` like every other one.

## LLM endpoint

`LLM_BASE_URL` + `LLM_MODEL` (+ `LLM_API_KEY`) point the keeper at one
OpenAI-compatible `chat/completions` endpoint — a LiteLLM gateway, OpenRouter,
Ollama, or a vendor's own compatible URL. That single call over `fetch`
(`src/headless/llm.ts`) is the keeper's entire model integration: vendor
choice, real provider keys and routing live in the gateway, the keeper holds
only a URL, a model name and a revocable key. Requests always stream (SSE,
aggregated in the client): generation runs for minutes, and some gateway
bridges — LiteLLM's ChatGPT-subscription provider among them — only answer
correctly when streaming. Nothing calls it yet; the
control dapp's `create-dapp` command (docs/plans/2026-09-09-keeper-control-dapp.md)
is the first consumer. `GET /api/status` → `integrations.llm` reports URL and
model, never the key.

## Docker

```sh
docker build -f Dockerfile.headless -t dapp-keeper .
docker run -d --name keeper -p 127.0.0.1:8788:8788 -v keeper-data:/data \
  -e SIGNALING_URLS=wss://signal.example.com dapp-keeper
docker exec keeper cat /data/config.json   # control token
```

The process runs as the image's unprivileged `node` user (uid 1000). A named
volume as above is created for it; a **bind mount keeps the host's ownership**,
so hand it over once when coming from an older image that ran as root:
`chown -R 1000:1000 <data dir>`.

The container binds `0.0.0.0` internally, which is only as open as the port you
publish — `-p 127.0.0.1:8788:8788` keeps it on the host. **With
`network_mode: host` nothing is published**, so bind the control surface itself
to loopback (`HEADLESS_HOST=127.0.0.1`) and put TLS in front of it: the bearer
token travels in clear text over plain http, and the API can do everything the
keeper can do. For example, bind the keeper to `127.0.0.1:8790` and place a TLS-terminating nginx reverse proxy in front of it.

## Data directory & security notes

```
headless-data/
├── identity.json   # device keypair — SECRET, chmod 600; back it up
├── config.json     # settings incl. control token — SECRET
├── executed-commands.json  # ids of control-dapp commands already started (replay protection)
├── events.json     # n8n delivery cursor per dapp
├── event-queue.json  # events n8n has not accepted yet
├── cron-state.json # last minute the cron ticker handled (a short restart still fires a due rule)
├── device-state.json  # device-local keys a browser keeps in localStorage: founder pin,
│                    # verified member baseline (Node's localStorage is volatile — src/headless/deviceStateFile.ts)
├── docs/           # file-persisted Yjs docs (root catalog, per-dapp, per-dapp source)
└── blobs/          # content-addressed file chunks (sha256-named)
```

- The whole directory is the keeper's device state; back it up cold, and never
  share `identity.json` — it *is* the device.
- Losing `identity.json` orphans the keeper's memberships (re-invite a fresh
  identity); the runtime refuses to regenerate over a malformed file for this
  reason. The same goes for `config.json` (a regenerated one would forget the
  control dapp and change the token) and for the root doc's `snapshot.bin`
  (every credential and rule): the keeper stops with a clear message instead of
  starting empty. State files are replaced atomically (tmp file, fsync,
  rename), so this only happens after real disk damage — restore the file from
  a backup, or move it away deliberately to start over.
- A dapp's `snapshot.bin` that does not decode is kept as
  `snapshot.bin.corrupt-<timestamp>` and the dapp is re-synced from its peers.
- `device-state.json` is not critical: a lost or unreadable one costs the keeper
  its founder pins and its verified member baselines, so the next boot trusts
  each dapp's member list as it finds it — first sight again, never a deletion.
  Back it up with the rest of the directory all the same.
- The control token gates everything the keeper can do; treat it like a
  password — and keep it off the wire: plain http exposes it to everyone on the
  network path (see Docker above). The API deliberately has no way to mint dapp access on its own —
  membership always comes from an owner device's approval.
- Blob *metadata* (pin flags, completeness) is in-memory per session; after a
  restart the keeper re-registers blobs from the synced file index and re-pins
  (chunk files on disk make this cheap — no re-download of present chunks).
- Like any device, a keeper that is offline while a credential rotation
  happens misses the rekey and needs a re-invite (docs/security/THREAT_MODEL.md).
