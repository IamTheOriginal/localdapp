# Code Apps

Code Apps are dapps whose UI is supplied by a synchronized `index.html` rather than by the visual screen renderer.

Writing an app with a coding agent? Hand it [AGENT-INSTRUCTIONS.md](./AGENT-INSTRUCTIONS.md) (published verbatim at https://app.localdapp.workers.dev/agent-instructions.md and /llms.txt by `scripts/copy-agent-guide.mjs` on every build) — a self-contained contract (constraints, manifest schema, runtime API, checklist, minimal example) meant to be dropped into an agent's instructions.

## Documents

A Code App uses two Yjs documents:

1. **Dapp document** — metadata, members, optional visual schema, entity records, and generic Code App data.
2. **Source document** — the Code App file map, currently edited through `index.html`.

The source document has its own IndexedDB database and its own y-webrtc room. Its room credentials are deterministically derived from the main dapp room credentials, so approved members can discover it without adding another secret to an invite.

Switching between Visual App and Code App mode does not delete either representation.

## Runtime

`index.html` runs in a sandboxed iframe with scripts and native browser dialogs enabled, but without same-origin access. The host injects a nonce-protected bridge before the app's inline scripts execute. External scripts, network connections, nested frames, forms, and objects are blocked by the runtime Content Security Policy.

**Who can change the app.** Only owners. Every save is signed by the saving owner's device; members' devices run only source that carries a valid owner signature. If the synced source is changed without one, members keep running the last signed version, and an owner device (or a keeper) puts the signed version back. A device that loads such a changed source fresh shows "This app is not running" until an owner device is online.

Code App anchors may point to absolute HTTP or HTTPS destinations. The iframe can navigate neither the top-level tab nor open popups: a click on such a link (static or created by script) is handed to the host, which shows the full address, asks for confirmation and then opens it in a **new tab** (`noopener`). Script can request the same with `await $ui.openLink('https://…')` → `{ opened }`; addresses with embedded credentials are refused. Relative links are stripped — use `$router.navigate()` for in-app routes. `javascript:`, `data:`, `mailto:`, and other schemes are stripped. WebRTC is blocked by the sandbox CSP (`webrtc 'block'`, enforced by Chromium-based browsers). Native `alert()`, `confirm()`, and `prompt()` dialogs are allowed.

The runtime provides these globals:

### `Dapp`

```js
Dapp.onReady((context) => {
  console.log(context.meta, context.role, context.identity)
})
```

The context contains dapp metadata, the current framework role and identity, the optional visual-schema entities, the manifest's declared app roles, the caller's resolved app role (`context.roles`, `context.appRole` — see [App roles](#app-roles) below), and the permissions the manifest granted, normalized (`context.permissions.network.connect` / `.images` are always arrays, `context.permissions.host` and `.device` are objects — see [Network permissions](#network-permissions)).

### `$data`

Generic JSON state in the main dapp data document:

```js
await $data.set('count', 1)
const count = await $data.get('count')
const snapshot = await $data.snapshot()

const unsubscribe = await $data.subscribe((state) => {
  console.log(state)
})
```

Keys are limited to 128 characters. Each value must be JSON serializable and no larger than 256 KB.

### `$store`

Yjs-backed per-record collections. A Code App can use an arbitrary collection name without first declaring a visual-schema entity; existing visual entity names and UUIDs remain compatible:

```js
const tasks = await $store.query('Tasks', { status: 'open' })
const task = await $store.create('Tasks', { title: 'Test' })
await $store.update('Tasks', task.id, { status: 'done' })
await $store.delete('Tasks', task.id)

const unsubscribe = await $store.subscribe('Tasks', { status: 'open' }, (records) => {
  console.log(records)
})
```

Collection names, visual entity names, or visual entity UUIDs are accepted. New collection names are created lazily on the first write. A collection id (1–128 characters, no control characters) must not contain `:` — the host keys records as `collection:recordId`, so such a name is rejected by `$store` and an `entities` id with a `:` makes the manifest invalid. A display name with a `:` still resolves when its entity id is clean. Writes require an owner or editor role; viewers retain read/query/subscribe access. The iframe receives this role-enforcing façade rather than the raw `Y.Doc`, so Code App code cannot mutate members, credentials, configuration, or authorization metadata. Code source editing is owner-only in the Builder UI.

### `$router`

Host-synchronized navigation declared by `manifest.yaml`:

```js
const currentPath = $router.current()
const currentSearch = $router.search()
const selectedTaskId = $router.query('task')
await $router.navigate('/tasks')

const unsubscribe = $router.subscribe((path) => {
  document.querySelectorAll('[data-view]').forEach((view) => {
    view.hidden = view.dataset.view !== path
  })
})
```

`search()` returns the host URL query string (including the leading `?`) and `query(name)` returns one decoded query value or `null`. Route subscribers also run when only the host query string changes, allowing stable record deep links while manifest routes remain path-only.

`navigate()` only accepts routes declared in the manifest — including hidden ones (see [Manifest and routes](#manifest-and-routes)). Builder-sidebar navigation, browser back/forward, reloads, shared links, and in-app navigation all update the same route without recreating the iframe.

```js
const mode = $router.chrome()          // 'standard' | 'fullscreen'
await $router.setChrome('fullscreen')
```

`chrome()`/`setChrome()` read and change whether the framework sidebar is shown — see [App display and chrome](#app-display-and-chrome). Switching chrome never recreates the iframe or changes the current route.

### `$events` and `$actions`

Declared, typed local dapp-to-dapp wiring, approved per pair in **Settings → Direct Code App bindings**:

```js
await $events.publish('game.move', { from: 'e2', to: 'e4' })

const unregister = await $actions.handle('game.move.apply', async (payload, { deliveryId }) => {
  console.log(payload, deliveryId)
})
```

`$events.publish` only accepts an event id declared under `manifest.bindings.events`; it resolves once the payload has been queued for every approved, unblocked binding. `$actions.handle` only accepts an action id declared under `manifest.bindings.actions`; the handler receives the delivered payload already validated (and, if the source declared a payload schema, projected) against the action's own declared payload schema. An action write still requires editor or owner role regardless of any app role (see below).

### `$roles`

```js
const mine = $roles.current()          // { id, label, extends } | null
const declared = $roles.list()         // this dapp's manifest.roles
const assignments = await $roles.assignments()   // owner/editor only
await $roles.assign(publicKey, 'player')          // owner only
```

See [App roles](#app-roles).

### `$ui`

```js
const { opened } = await $ui.openCodeEditor({ file: 'index.html' })  // owner only
const { opened } = await $ui.openSettings({ section: 'sharing' })
```

Opens a **host-owned** framework modal — the code editor or the Settings workspace — over the Code App. Each call requires the matching `permissions.host` flag in the manifest (see below) and resolves once the modal *closes*, so the app can refresh afterward. `opened: false` (not a rejection) means the request was declined non-fatally: another host modal was already open, or a second call arrived within 500ms of the last one. `openCodeEditor` additionally requires the owner role. There is no way for a Code App to close, resize, or otherwise reach into a host modal once it's open — control returns to the framework entirely for that duration.

### `$files`

```js
const records = await $files.list()                       // FileRecord[] (metadata + thumbnails)
const { record, bytes } = await $files.get(fileId)        // bytes: ArrayBuffer, hash-verified
const url = await $files.objectUrl(fileId)                // blob: URL usable in <img>/<video>
const added = await $files.add({ name, mime, data })      // data: ArrayBuffer | Uint8Array | Blob
await $files.delete(fileId)
```

Access to the dapp's peer-to-peer file store (see `docs/plans/2026-08-24-blob-store.md`). Requires `permissions.host.files: true` in the manifest. Metadata lives as signed records in the dapp document; content is content-addressed (SHA-256), stored on member devices, and fetched from connected members on demand — `$files.get` may take up to two minutes when the content has to come over the wire, and fails when no connected member holds a copy. `add`/`delete` require editor or owner role. Bytes cross the bridge as ArrayBuffers; `objectUrl` wraps them in a `blob:` URL (allowed by the sandbox CSP for images and media).

### `$db`

```js
const page = await $db.query('recipes', {
  index: 'calories', range: { lte: 400 }, direction: 'asc', limit: 60,
  match: [{ field: 'category', op: 'eq', value: 'Suppen' }],
})                                        // { rows, cursor } — pass cursor back for the next page
const row = await $db.get('recipes', id)
const total = await $db.count('recipes')
const unsubscribe = await $db.subscribe('recipes', () => rerunCurrentQuery())
```

Read-only, sorted and paginated access to the collection through a host-side in-memory index (docs/plans/2026-08-24-read-model.md). Declare sortable fields in the manifest (`"db": { "indexes": [{ "collection": "recipes", "field": "calories" }] }`); `range` works on the named index (rows without a string or number value in that field are absent from it), `match` filters host-side (`eq | contains | gte | lte`, `contains` case-insensitive) without shipping rows. Subscriptions deliver **invalidation signals**, not data — re-run your current query. Consistency contract: the index contains only signature-verified records and may trail `$store` writes by well under a second. Writes still go through `$store`; after your own write, keep the value you just wrote for immediate display rather than re-reading `$db`.

### `$i18n`

```js
const label = $i18n.t('New game')                 // or the $t shorthand
const greeting = $t('Hello {name}', { name: 'Ada' })
const language = $i18n.language()                 // e.g. 'de' — the host shell's active language
const available = $i18n.available()               // e.g. ['de', 'en']
const unsubscribe = $i18n.subscribe((language) => rerender())
```

Translations come from the app's own source files — see [Translations](#translations-i18n). Lookup order for `t(key)`: the active language's dictionary, then its base language (`de-at` → `de`), then the `en` dictionary (for apps that use abstract keys), then the key itself — so when keys are the English source strings (the same convention the host shell uses), an app needs only the non-English files. `{name}` placeholders are replaced from the optional params object. The active language follows the host shell's language setting and updates live: `subscribe` fires (and a `dapp:language-changed` CustomEvent dispatches) when the user switches languages, without recreating the iframe. `Dapp.context.language` carries the value at boot; `$i18n.language()` is the live source.

### Bridge limits

Every write is signed, stored in the shared dapp document and sent to every member, so the bridge throttles each running app (per iframe runtime) instead of letting a loop bloat the dapp for everyone:

| Limit | Default | Applies to |
| --- | --- | --- |
| Write calls | burst 50, then 10 per second | `$data.set/delete`, `$store.create/update/delete`, `$files.add/delete`, `$events.publish`, `$share.open/close/leave`, `$roles.assign` |
| Other calls | burst 1000, then 200 per second | everything else (reads, subscriptions, navigation, UI) — a separate bucket, so reads never starve writes or vice versa |
| Write volume | 8 MiB of JSON per minute | the serialized payload of `$data.set`, `$store.create/update` and `$events.publish` |
| `$files.add` | 512 MiB per dapp per page session | file content; reopening the app does not reset it, reloading the page does. A failed add is not counted. Individual files stay limited to 256 MiB. |

A call over a limit is not dropped: its promise rejects with an `Error` whose `code` is `'rate_limited'` (retry after `error.retryAfterMs` milliseconds) or `'quota_exceeded'` (the call cannot succeed as is — a single payload larger than the per-minute budget, or the `$files` session budget is used up). The host logs one console warning per runtime. Batch writes where possible and back off on `rate_limited`:

```js
try {
  await $store.create('tasks', task)
} catch (error) {
  if (error.code === 'rate_limited') setTimeout(retry, error.retryAfterMs)
  else throw error
}
```

The defaults live in `CODE_APP_BRIDGE_LIMITS` (`src/services/codeAppRuntime.ts`).

## Manifest and routes

New Code Apps contain a synchronized `manifest.yaml` alongside `index.html`:

```yaml
# YAML 1.2 (a superset of JSON, so JSON syntax also parses). Comments allowed.
name: Task Manager     # display identity: what the catalog, sidebar and
icon: ✅               # settings show for this app. Editing these here is
color: '#6755e7'       # the one way to rename or re-icon an app.
routes:
  - path: /
    label: Overview
    icon: home
  - path: /tasks
    label: Tasks
    icon: list
  - path: /settings
    label: Settings
    icon: settings
```

Rules:

- `name` (≤ 80 chars), `icon` (an emoji, ≤ 16 chars) and `color` (hex, `#rgb`/`#rrggbb`) are optional and are the app's display identity. The host copies them into the dapp document's `config.meta` on install and on every manifest save, so the catalog card, Builder sidebar and settings header follow for every member. There is no separate rename UI — the manifest is the only place to change them.
- One to 32 unique routes are required.
- Paths use URL-safe segments, begin with `/`, and cannot contain query strings, hashes, or `..`.
- Labels are required. Icons are optional; supported built-in names are `code`, `home`, `list`, `dashboard`, and `settings`. Unknown names use the Code App icon.
- A route may set `"hidden": true` to omit it from the Builder sidebar. This is presentation only, never access control — a hidden route stays directly reachable by URL and by `$router.navigate()`.
- Host URLs use `/dapp/:id/app` for `/` and `/dapp/:id/app/<path>` for other routes (or `/dapp/:id/full...` in fullscreen chrome — see below).
- Code Apps without a manifest retain the legacy single **Code App** navigation entry.
- Invalid manifests show an error in the Builder sidebar and safely fall back to the legacy root route.

Routes are source-owned metadata. They do not create visual-schema screens and the host never inspects or manipulates the Code App DOM.

## App roles

A manifest may declare app-specific roles for the Code App's own logic to branch on — `player`/`spectator`, `admin`/`member`, whatever the app's domain calls for:

```json
{
  "roles": [
    { "id": "player",    "label": "Player",    "extends": "editor", "description": "Can move" },
    { "id": "spectator", "label": "Spectator", "extends": "viewer" }
  ]
}
```

Up to 16 roles. Each `id` follows the same pattern as a binding id (lowercase, starts with a letter) and cannot collide with the three framework roles. `extends` is required and is one of `owner`, `editor`, or `viewer` — it is a **ceiling**, not a grant: a `player` role extending `viewer` still cannot write, no matter what the app's own logic does with `$roles.current()`. Enforcement of reads and writes always uses the caller's real framework role; an app role is a label the app can use to shape its own UI and logic, never a bypass.

The dapp owner assigns app roles per member with `$roles.assign(publicKey, roleId)`; assignments are Ed25519-signed by the owner and stored in the dapp document, verified the same way member profile changes are — an unsigned or wrongly-signed assignment is reverted automatically on every peer. If a role is later removed from the manifest, any existing assignment to it silently resolves to no app role rather than keeping a stale grant.

## App display and chrome

A Code App normally runs inside the framework's sidebar/chrome (`/dapp/:id/app...`). It can also run **fullscreen** — no sidebar, only the app's own in-app navigation — either by URL or by manifest default:

```json
{ "display": { "chrome": "fullscreen" } }
```

- `/dapp/:id/full` and `/dapp/:id/full/<path>` always render without chrome.
- `/dapp/:id/app` and `/dapp/:id/app/<path>` always render with chrome.
- The URL family wins over `display.chrome` — `display.chrome: "fullscreen"` only changes where a bare `/dapp/:id` link lands by default; an explicit `/app` URL still shows chrome, and an explicit `/full` URL still hides it.

A host-rendered corner button (`aria-label="Show app framework"`) appears in fullscreen chrome by default and returns to the equivalent `/app` URL. It lives outside the sandboxed iframe, so the Code App's own DOM/CSS can never hide or remove it. A manifest can opt out with `display.frameButton: false` — the `/app` URL family and `$router.setChrome('standard')` keep working, only the button disappears:

```json
{ "display": { "chrome": "fullscreen", "frameButton": false } }
``` Toggling chrome — by URL, or at runtime via `$router.setChrome()` — never recreates the iframe or resets in-app JavaScript state; only the route and chrome mode update.

## Receiving OS shares (share target)

The host is registered as a Web Share Target: content shared to Dapp Builder from other apps lands on the host's `/share-target` picker. A dapp appears in that picker only if its manifest opts in:

```yaml
shareTarget:
  accepts: [text, url, files]   # each entry: text | url | files
permissions:
  host:
    files: true                 # required for `files` — shared files arrive through $files
```

When the user picks the dapp, the share is appended to the reserved `$data` key `incoming-shares` — a newest-first array (capped at 20) of `{ id, receivedAt, title?, text?, url?, files? }` — and the app opens. Shared files (images, video, audio, PDF, text; at most 20 per share) are first stored in the dapp's file store, so `files` is a list of `{ fileId, name, mime, size }` and the bytes come from `$files.get(fileId)`. Consume it like any `$data` value:

```js
const shares = (await $data.get('incoming-shares')) || []
// handle entries, then clear what you consumed:
await $data.set('incoming-shares', [])
```

`$data.subscribe` fires when a share arrives while the app is open. Delivery is an ordinary editor-gated `$data` write (plus editor-gated file records) from the picking member's device — viewers cannot deliver and nothing is broadcast to other dapps. A share that carries files counts as a `files` share even when a caption or link rides along; the text fields are still delivered on the same entry.

## Host permissions

A manifest opts into calling `$ui.*` by declaring which host surfaces it may open:

```json
{ "permissions": { "host": { "codeEditor": true, "settings": true, "contacts": true, "sharing": true } } }
```

`codeEditor` and `settings` authorize `$ui.*`. `contacts` authorizes `$contacts.pick()`, which returns only host-selected opaque contact handles. `sharing` authorizes `$share.open()`, which always opens a host-owned consent surface before creating isolated relationship channels. Calling any host capability without its matching manifest flag fails closed. The Builder surfaces declared host permissions in both the Code App editor and dapp settings.

## Network permissions

The sandbox CSP blocks all network access by default. A manifest can open exact HTTPS origins:

```yaml
permissions:
  network:
    connect: [https://recipes.example]   # fetch() / XHR / WebSocket → connect-src
    images:  [https://recipes.example]   # <img src> → img-src
```

Entries must be exact `https://host[:port]` origins — no paths, wildcards, credentials, or `http:` — and at most 32 per list. The host also lets the resource bundler resolve `<img>` sources from `images` origins. Apps read what they were granted from `Dapp.context.permissions`, so a manifest-declared origin is the single place to configure an external data source (the Recipe Book starter's Catalog tab works this way). The remote server must answer CORS requests from the opaque sandbox origin (`Access-Control-Allow-Origin: *`).

## Device permissions

Code Apps use the **host camera bridge** for live preview and image analysis. Declare:

```yaml
permissions:
  device:
    camera: true
```

Then call `$camera.start({ facingMode: 'environment' })` from a button click (`'user'` selects the front camera). It resolves to `{width, height}` once the host has a video frame. The browser controls camera permission; HTTPS or `localhost` is required. Native `navigator.mediaDevices.getUserMedia()` cannot work in the opaque-origin sandbox — `allow="camera"` alone does not fix `SecurityError: Invalid security origin`.

For a **live view**, repeatedly await `$camera.frame()`, which returns `{bytes: ArrayBuffer, mime: 'image/jpeg', width, height}`. Decode with `createImageBitmap(new Blob([frame.bytes], {type: frame.mime}))` (or an `Image` with an object URL), draw to the app's canvas, then run the detector and draw its overlays. Close the bitmap / revoke the object URL after drawing. There is one request in flight at a time, up to 15 frames/s, and the longest image edge is capped at 1280 px. This is a continuous live feed, not a photo-picker interaction; actual frame rate depends on the device and the app's processing time.

`$camera.stop()` releases the device. Call it when paused or leaving the camera route. Hiding the host page, closing/reloading the Code App, or losing camera permission also stops capture; handle start/frame rejections and let the person restart. Error names such as `NotAllowedError`, `NotFoundError`, and `NotReadableError` are preserved across the bridge. The host stores or synchronizes no frames and never captures audio.

## Definition export, import, and share installation

An owner can export a Code App as a signed `.dapp` definition file from dapp settings (`src/services/dappFile.ts`; the older `.dapp.json` name is the same format and still imports). A definition contains display metadata and source files only—never records, `$data`/`appData`, members, room credentials, or sharing credentials. Home-page import verifies the Ed25519 signature and source fingerprint before showing a mandatory capability preview; installation creates a fresh local dapp with fresh credentials and empty data. The installed PWA registers as the OS handler for `.dapp` files (`file_handlers` in `manifest.webmanifest`, MIME `application/vnd.dapp-builder+json`): opening one launches `/open-file`, which reads the file from `window.launchQueue` and shows the same preview. Browsers without the File Handling API (Firefox, Safari) get a manual picker on that page.

An owner may alternatively create a **source-share link** in dapp settings. It is a reusable 24-hour capability for a temporary WebRTC transfer room, not a dapp invitation: opening it receives one signed definition and never adds the recipient as a member or reveals the source dapp's data, room credentials, members, files, or channels. The device that created the link must remain online; removing it stops the room immediately. The recipient must review the same source/permission preview, then can either install an independent fresh dapp or (only as owner) deliberately replace the code and manifest of an existing dapp. Replacement keeps that target's records, members, credentials, and file store.

Owner-originated `$share.open()` offers may carry a source-identical definition with a fresh relationship-specific signature inside the encrypted, signed relationship-control envelope. This preserves package verification without exposing one stable author key across unrelated contacts. The recipient inbox keeps it inert until the user chooses **Review attached app** and **Install app & accept share**. The preview is re-derived from the original signed offer, and acceptance requires that exact reviewed signature before installation. Acceptance checks the bundled manifest against the signed share contract, creates a fresh local dapp, and only then binds the accepted channel to that local ID. The consent request remains open for up to ten minutes; signed late responses are recovered after reload so they cannot block the directional control-message chain. Editor/viewer senders do not attach exportable source.

## Adding a dapp from GitHub

**New Dapp → Add from GitHub** copies a Code App out of a *public* GitHub
repository. Paste the repository link, or the link of the folder that holds the
app (`https://github.com/<owner>/<repo>/tree/<branch>/<folder>`; a link to its
`index.html` works too). The folder must contain `index.html` and
`manifest.yaml`. Text sources (`.html .css .js .json .yaml .yml .svg .txt`) are
copied; binary files, dot-paths and `node_modules` are skipped and listed in
the preview. The normal Code App limits apply (64 files, 1 MB per file, 4 MB in
total) and the result passes the same validation as any other install. Name,
icon and color come from the manifest (the repository name is the fallback).

How it works: two plain `fetch` calls against `api.github.com` resolve the
branch to one commit and list its tree, the files are then downloaded from
`raw.githubusercontent.com` **at that commit** and each one is re-hashed as a
git blob and compared with the listing. Nothing is installed before the preview
is confirmed. The dapp remembers its origin (repository, branch, folder,
installed commit, fingerprint of the copied files) in the source document, so
every member has it — but only owners ever act on it.

Updates are never automatic:

- While an **owner** has the dapp open, their browser asks GitHub at most once
  every six hours whether the tracked folder changed (one API request; changes
  elsewhere in the repository do not count). Non-owners never ask.
- A change shows up as a **red dot on “Dapp settings”** — for owners only.
- Dapp settings → **GitHub source → Review update** downloads and verifies the
  new revision without installing it and shows changed / new / removed files,
  the manifest's permissions and a link to the diff on GitHub. Only
  **Update dapp** replaces the sources (for all members, through the normal
  owner-only source write). Edits made in the code editor are overwritten.
- **Keeper nodes never check GitHub and never update a dapp.** The check lives
  in the browser UI only (`src/hooks/useGithubUpdate.ts`); a test guards that
  `src/headless/`, the store layer and the automation engine do not import it.
- **Disconnect from GitHub** stops the tracking and keeps the installed files.

Unauthenticated GitHub API calls are limited to 60 per hour and network; a
rate-limited check simply shows no result and is retried later. Private
repositories are not supported (no tokens are stored anywhere).

## First-party starters

The Home gallery ships four editable Code App definitions. Creating one calls asynchronous `createStarterDapp(starterId)`, which validates its source and manifest before creating a fresh dapp, seeds only optional visual-schema metadata, replaces the default source, and opens the live app. Failed installation rolls back the catalog entry and local resources. Starter creation seeds no records, so each dapp begins with empty app data and independent credentials. On first runtime boot, Shared Expenses creates the local “Me” participant and materializes active channel contacts as local selectable participants.

- **To-Do List** demonstrates arbitrary `$store` collections, CRUD subscriptions, routes, and a typed `task.completed` event. It is also the reference **multi-file** starter: vanilla JS split into `styles.css` and `app/*.js` (state, view, wiring) — see [Multiple files](#multiple-files).
- **Shared Expenses** computes balances locally and shares only the bilateral debt slice relevant to one contact. Wire payloads use sender/recipient roles rather than device-local member IDs, and the receiver resolves those roles to its own records. It never transfers the complete expenses collection. Owners or contacts assigned the `settle-up` app role can mark liabilities settled.
- **Diary** stores compressed photos only after downscaling to 800 px and enforcing a 200 KB local limit. Entry-channel payloads include photos only at or below 48 KB, and received attachments are accepted only as size-bounded JPEG data URLs. Its fullscreen reader always includes an in-app exit control.
- **Group Chat** opens channels for 1–16 selected contacts, orders messages by `sentAt`, deduplicates relayed messages by `messageId`, and compresses optional photos below 45 KB before publication. Shared payloads contain no global identity key. The chat creator derives direct authors from authenticated channel context, assigns chat-local random relay identities, and attests that metadata when relaying to other participants; recipients trust only the creator’s authenticated channel.

Starter source is first-party content and is not wrapped in a definition signature at creation. If an owner later shares the installed app with a contact, the normal encrypted Phase 5 channel protocol and Phase 6 signed definition install flow apply. Starter app roles are declarative ceilings; selecting a contact for a channel does not silently grant that contact a global dapp role.

All starter controls have 44 px minimum touch targets, responsive single-column behavior below 560 px, safe-area padding, and an explicit `[hidden]` rule so route-specific surfaces remain inert when not selected. Mutation controls use explicit `type="button"` click handlers instead of implicit form submission, and call `reportValidity()` before bridge writes so actions work reliably inside opaque-origin sandboxed iframes.

## Multiple files

A Code App's source is a file map (up to 64 files / 4 MB, subdirectories allowed), not one HTML file. `index.html` is the only entry point, but at boot the runtime resolves every **local** reference and inlines it into the sandbox document, so nothing is ever fetched:

- `<script src="app/main.js">` → the file's content, inlined as a nonce-protected classic script (document order preserved)
- `<link rel="stylesheet" href="styles.css">` → inlined `<style>` (`url(...)` references to local SVGs are resolved too)
- `<img src="icons/logo.svg">` → a data URL

References are resolved relative to the referencing file; absolute paths, `..` above the root, query strings and any URL scheme are rejected and the element is dropped. Constraints that follow from the sandbox:

- **No ES modules.** `<script type="module">` is removed, so files cannot `import`/`export` each other. Split files are classic scripts that share code through a global namespace (`globalThis.MyApp = { ... }`), in `<script>` order.
- **No external scripts, no build step, no `eval`.** Libraries must be vendored into the file map as plain files (`vendor/…`), and the file map is what runs — JSX or TypeScript need an external bundler (e.g. `esbuild --bundle --format=iife`) whose output is committed as a file. React 19 ships no UMD build; if a framework is wanted, Preact + `htm` (tagged-template JSX, no compiler, ~13 KB) is the practical no-build choice — but the shipped starters stay framework-free.
- **One HTML file.** Other `.html` files are inert; multiple "pages" are `$router` routes rendering different views inside the one runtime.

## Translations (i18n)

A Code App is translated by adding dictionary files to its source file map, one per language:

```
i18n/de.json    { "New game": "Neues Spiel", "Hello {name}": "Hallo {name}" }
i18n/fr.json    { "New game": "Nouvelle partie" }
```

- The file name is the language code (`i18n/<language>.json`, BCP-47-ish: `de`, `pt-br`); the content is one flat JSON object mapping source strings (or stable keys) to translated texts.
- Dictionaries are ordinary source files: owners add and edit them in the code editor, they sync to members with the rest of the source, and they travel inside definition exports and share installations. Adding a language is creating one file — no manifest change, no host support needed.
- At boot the runtime embeds every dictionary into the sandbox document; apps read them through [`$i18n` / `$t`](#i18n). The active language is the host shell's language setting.
- Validation fails closed at save/install time: a malformed `i18n/*.json` (broken JSON, non-string values, an implausible language name) is rejected with the reason, so typos surface in the editor. Limits: 24 languages, 5000 entries per language, keys ≤ 256 chars, values ≤ 4096 chars.
- The Game Score Keeper starter ships `i18n/de.json` as the reference implementation: static texts carry `data-i18n` attributes applied on boot and on language change, dynamic strings go through `$t()` in render functions.

## Current scope

The runtime boots a single `index.html`; routes select views inside that persistent runtime. Version hashes and Pear-like app distribution can be added later without combining source history with runtime data history.
