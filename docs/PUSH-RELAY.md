# Push relay — deployment

The blind-mailbox Web Push relay (`server/push-relay.mjs`). One instance serves every
deployment of the frontend that is built with its URL.

- Run locally: `npm run push-relay` → http://0.0.0.0:4446 (health `/health`).
- Frontend wiring: build with `VITE_PUSH_RELAY_URL=https://<host>/push` —
  unset, the whole notifications feature is hidden.
- State: `PUSH_RELAY_DATA` directory (VAPID keypair + inbox registrations,
  small JSON files). Losing it only means devices re-register and
  re-announce their inboxes; nothing user-visible breaks permanently.

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUSH_RELAY_PORT` | `4446` | Listen port. |
| `HOST` | `0.0.0.0` | Listen address. |
| `PUSH_RELAY_DATA` | `./push-relay-data` | State directory. |
| `PUSH_RELAY_SUBJECT` | `mailto:admin@localhost` | VAPID contact, e.g. `mailto:you@example.org`. |
| `PUSH_RELAY_STALE_DAYS` | `60` | Registrations not refreshed for this long are swept. |
| `PUSH_RELAY_MAX_INBOXES` | `50000` | Total inboxes; creation answers `503` when full (refreshes still work). |
| `PUSH_RELAY_MAX_NEW_INBOXES_PER_IP` | `20` | Inboxes one client address may create per 24 h (IPv6 counted by /64); over it, creation answers `429`. Legitimate devices create one inbox when push is enabled and re-register the same one afterwards. |
| `PUSH_RELAY_EXTRA_PUSH_HOSTS` | *(empty)* | Comma-separated extra push-service hosts; `*.example.org` means any subdomain. The built-in list is `fcm.googleapis.com`, `*.push.apple.com`, `*.notify.windows.com`, `updates.push.services.mozilla.com`, `*.push.services.mozilla.com`. |
| `PUSH_RELAY_TRUST_PROXY` | off | `1`/`true`: charge requests to the right-most `X-Forwarded-For` entry. Set it only when a reverse proxy in front sets that header (the nginx block below does); otherwise every request behind the proxy shares one bucket, and without a proxy clients could pick their own. |

## Example: Docker Compose + nginx

The relay is designed to sit behind the existing TLS listener on
`signal.example.com`, proxied under `/push/`. Files only — nothing
below touches live infrastructure by itself.

Container (add to the `dapp-signal` compose file):

```yaml
  dapp-push:
    image: node:22-alpine
    container_name: dapp-push
    restart: unless-stopped
    working_dir: /app
    # Repo tarred to the NAS like the keeper's build context; needs only
    # server/push-relay.mjs, package.json and the web-push dependency.
    volumes:
      - ${PATH_TO_APPDATA}/dapp-push/app:/app
      - ${PATH_TO_APPDATA}/dapp-push/data:/data
    environment:
      PUSH_RELAY_PORT: "4446"
      PUSH_RELAY_DATA: /data
      PUSH_RELAY_SUBJECT: mailto:admin@example.com
      PUSH_RELAY_TRUST_PROXY: "1"   # nginx below sets X-Forwarded-For
    command: ["node", "server/push-relay.mjs"]
```

nginx (inside the `dapp-signal-tls` server block, next to `/signaling`):

```nginx
  location /push/ {
    proxy_pass http://127.0.0.1:4446/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    access_log off;              # bodies and paths are never logged
    client_max_body_size 16k;
    limit_req zone=perip burst=20 nodelay;
  }
```

Then build the frontend with
`VITE_PUSH_RELAY_URL=https://signal.example.com/push`.

## Operational notes

- The relay stores no identities beyond what inbox owners upload: inboxes
  are random 128-bit ids with a per-inbox allowlist of contact signing
  keys. `POST /notify` requires a signed, fresh, non-replayed tickle from
  an allowlisted sender; per-IP and per-inbox rate limits back that up.
  See the plan doc's invariants before changing any of this.
- `/notify` answers every unauthenticated tickle the same way — unknown
  inbox, sender not on the allowlist, bad signature: `403 {"error":"not allowed"}`
  — so it does not reveal which inbox ids exist. The per-inbox limit
  (6/min) is charged only after a tickle authenticated, so junk from someone
  who knows an inbox id cannot use up its owner's contacts' budget.
- Subscription endpoints must be `https://` on the default port, without
  credentials, on an allowlisted push-service host, and never an IP literal
  in a private, loopback, link-local or CGNAT range: the relay cannot be
  used to POST to arbitrary or internal hosts. An inbox stored before the
  allowlist (or after `PUSH_RELAY_EXTRA_PUSH_HOSTS` was narrowed) is never
  contacted; its owner's next refresh is refused and the client registers
  anew. Hostnames added through `PUSH_RELAY_EXTRA_PUSH_HOSTS` are trusted as
  given — only list push services you know resolve to public addresses.
- Registrations are written asynchronously (debounced ~1 s, temp file +
  rename) and flushed on SIGTERM/SIGINT.
- Forwarded Web Push messages are payload-less; the service worker shows a
  constant string. There is nothing sensitive to leak even at full relay
  compromise — only wake-up timing and the uploaded allowlists.
- Dead subscriptions are deleted when the push service answers 404/410,
  and a periodic sweep drops registrations not refreshed within
  `PUSH_RELAY_STALE_DAYS` (default 60; clients re-register at every boot).
- iOS requires the PWA to be installed to the Home Screen (16.4+) before the
  permission prompt works; the Settings UI explains this to users.
