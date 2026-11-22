# Deployment

Dapp Builder is a static frontend plus one tiny stateless service: a WebRTC
**signaling broker**. There is no application backend and no database — all
data lives in the users' browsers (IndexedDB) and syncs peer-to-peer.

## 1. Frontend (static hosting)

```sh
VITE_SIGNALING_URL=wss://signal.example.com npm run build
```

Deploy `dist/` to any static host. Build-time environment:

| Variable | Required | Meaning |
| --- | --- | --- |
| `VITE_SIGNALING_URL` | yes, unless the host proxies `/signaling` | One or more signaling WebSocket URLs (comma/whitespace separated). Invite and lobby rooms (y-webrtc) race them and use whichever connects first; the member mesh that carries dapp data holds a socket to **all of them at the same time** and finds peers through whichever is up, so the order does not matter and one unreachable entry costs nothing. Each browser tab or keeper holds one member-mesh socket per signaling URL (shared by all its dapps) plus one for y-webrtc's invite rooms, so a reverse proxy's per-IP connection limit must cover every device and tab that shares a public IP — keep the list short. This is only the **default**; each device may point itself somewhere else (see § 2.1). When unset, the app uses same-origin `wss://<host>/signaling` — only correct if your host proxies that path to a broker (the dev server does). |
| `VITE_ICE_SERVERS` | strongly recommended | JSON `RTCIceServer[]` array with your STUN/TURN servers. Without a TURN relay, users behind symmetric NAT (many mobile carriers, corporate networks) **cannot connect to each other at all**. |
| `VITE_ICE_SERVERS_URL` | optional | HTTPS URL returning short-lived `{ iceServers, ttl }` JSON (e.g. the `/ice` endpoint of the €0 Cloudflare Worker in `docs/CLOUDFLARE.md`). Preferred over static `VITE_ICE_SERVERS` on public sites so TURN credentials cannot be scraped from the bundle. |

Example:

```sh
VITE_SIGNALING_URL="wss://signal.example.com" \
VITE_ICE_SERVERS='[{"urls":"stun:stun.example.com:3478"},{"urls":"turn:turn.example.com:3478","username":"dapp","credential":"…"}]' \
npm run build
```

The app must be served over **HTTPS** (WebCrypto and non-extractable keys
require a secure context).

## 2. Signaling broker

`server/signaling.mjs` is a production-ready y-webrtc signaling server
(drop-in protocol-compatible with y-webrtc's demo server) with:

- `GET /health` → `{"status":"ok","connections":N,"topics":N,"uptimeSeconds":N}` for load-balancer checks,
- abuse limits (below) and dead-peer eviction (30 s ping).

Run it with Node ≥ 20 (`ws` is the only dependency):

```sh
PORT=4444 node server/signaling.mjs
```

Environment (all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `4444` / `0.0.0.0` | Listen address. |
| `MAX_TOPICS_PER_CONNECTION` | `512` | Topics one socket may subscribe; further topics are ignored (the socket stays up — the member mesh puts every dapp of a device on one socket per endpoint, so a person with very many dapps must not be cut off entirely). Keep it well above the number of dapps one device holds. |
| `MAX_MESSAGE_BYTES` | `131072` (128 KiB) | Largest message; a bigger one closes the socket (code 1009). Signaling envelopes are a few KiB. |
| `MAX_MESSAGES_PER_SECOND` | `100` | Sustained message rate per socket (token bucket). |
| `MESSAGE_BURST` | `1000` | Bucket size: what a device may send at once, e.g. one announce per dapp at boot. A socket that empties the bucket is closed (code 1008); the client reconnects with backoff. |
| `TRUST_PROXY` | off | `1`/`true`: take the client address from the right-most `X-Forwarded-For` entry. Only with a proxy in front that sets it (see below) — otherwise clients could choose their own address. |
| `MAX_CONNECTIONS_PER_IP` | `128` with `TRUST_PROXY`, else `0` (off) | Open sockets per client address (IPv6 counted by /64); more are refused with HTTP 429 at the upgrade. |

**Per-IP connection limit — pick one place.** Behind a reverse proxy the
broker sees every socket coming from the proxy, so without `TRUST_PROXY` a
broker-side per-IP cap would be one global bucket; that is why it is off by
default. Either let the proxy enforce it (`limit_conn`, below) or set
`TRUST_PROXY=1` with `X-Forwarded-For` and let the broker do it — not a tight
limit in both. Size it for every device *and tab* behind one public address:
each tab holds one member-mesh socket per signaling URL plus one for invite
rooms (§ 1), so a household or office behind one NAT needs dozens.

Put it behind a TLS-terminating reverse proxy so clients connect via `wss://`.
nginx example:

```nginx
# Optional proxy-side per-IP socket cap (http block); skip it if the broker
# enforces MAX_CONNECTIONS_PER_IP with TRUST_PROXY=1 instead.
limit_conn_zone $binary_remote_addr zone=signal_perip:10m;

server {
  listen 443 ssl;
  server_name signal.example.com;
  # ssl_certificate …; ssl_certificate_key …;

  location /health { proxy_pass http://127.0.0.1:4444/health; }
  location / {
    proxy_pass http://127.0.0.1:4444;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;  # read only with TRUST_PROXY=1
    proxy_read_timeout 120s;
    limit_conn signal_perip 128;
  }
}
```

Privacy properties: the broker only relays small signaling envelopes
(SDP offers/answers, ICE candidates) addressed by room name — and for the
member mesh those envelopes are themselves encrypted with a key derived from
the dapp's room credentials. Document data is sent over direct WebRTC data
channels (DTLS-encrypted), and dapp data only to devices that proved a member
key first; the broker never sees content and stores nothing. What it does see
is metadata: which addresses are online for which topic and when. It is safe to
run multiple brokers — list them all in `VITE_SIGNALING_URL`; devices connect
to every one of them at once and are found through whichever is reachable.

**Two devices only meet if they share at least one broker.** A broker relays
only between its own subscribers, so a device on `signal.example.com` alone and
a device on `broker.club.example` alone never see each other, however good the
invite is. Overlapping lists are what makes a move between brokers safe: list
old and new for a while, then drop the old one.

Do **not** rely on the public `y-webrtc` demo servers for production; they are
best-effort and frequently down.

## 2.1 Self-hosting a broker for your own device (no rebuild)

A person who opened somebody else's deployment (say `app.localdapp.workers.dev`) can
point **their device** at their own broker under **Settings → Signaling**,
without rebuilding or rehosting anything:

1. Run `server/signaling.mjs` somewhere both devices reach, behind TLS
   (§ 2). `ws://` is accepted by the setting but the page must be served over
   HTTPS, so browsers will refuse a plain `ws://` endpoint from an HTTPS page —
   use `wss://` for anything but a local test.
2. Open Settings → Signaling and add the address (`wss://…`). The entry is
   added **next to** the deployment's default; the device then looks for peers
   on both and a green dot shows which ones are reachable.
3. Everyone who should meet over your broker adds the same address on their
   device. Sharing at least one broker is the whole requirement — the invite,
   the room credentials and the member handshake are unchanged.

Properties of this setting:

- **Device-local.** It lives in this browser's `localStorage`, survives a
  reload, is never synced, and is part of no document and no invite link. Every
  device of a dapp is configured separately (a broker list that belongs to a
  *dapp* — carried in the invite and owner-signed in the document — is a later
  step, see `TODO.md`).
- **Validated.** `ws://` or `wss://` only, length-capped, duplicates removed,
  at most 8 entries; an empty list means "use the build default".
- **Takes effect immediately.** The member mesh drops the sockets that are gone,
  dials the new ones and keeps the rest — no reload, no peer connection is torn
  down for it. Invite lobbies and pairing rooms that are *already open* keep the
  server they were created with until they are closed and reopened.
- **Removing the default cuts this device off** from everyone still on it. The
  panel says so; adding is the safe operation.
- The keeper ignores the setting: it takes its endpoints from `SIGNALING_URLS`
  (`docs/HEADLESS.md`), which still wins over everything.

## 3. TURN relay

Any standard TURN server works ([coturn](https://github.com/coturn/coturn) is
the usual choice). Minimal coturn setup:

```sh
turnserver --realm=example.com --user=dapp:SECRET \
  --lt-cred-mech --fingerprint --no-multicast-peers \
  --listening-port 3478
```

Then reference it in `VITE_ICE_SERVERS` (see above). TURN relays encrypted
WebRTC payloads only — it also never sees plaintext document data.

## 4. Dev setup

`npm run dev` runs Vite (which proxies `/signaling` → `ws://127.0.0.1:4444`)
and the same `server/signaling.mjs` side by side — dev and production run the
identical broker. `npm run signaling` starts the broker alone.
