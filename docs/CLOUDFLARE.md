# €0 Cloudflare Deployment (Single Worker + Signaling DO + Optional 1 TB Free TURN)

Host Dapp Builder on **Cloudflare's Free tier** without exposing your home IP,
opening router ports, or running a VPS:

- **Static frontend + signaling in one Worker (recommended):** Cloudflare Workers
  Static Assets serves `dist/` from the edge at **€0 / 0 Worker invocations**,
  while `/signaling`, `/ice`, and `/health` route same-origin to the Worker +
  SQLite Durable Object (`cloudflare/signaling-worker/`). Zero CORS config and a
  single deploy command. (You can also host the frontend separately on Cloudflare
  Pages if you prefer a `<name>.pages.dev` URL.)
- **Signaling broker:** Cloudflare Workers Free + SQLite Durable Object with
  WebSocket Hibernation (100k req/day free; edge auto-responds to `ping` without
  waking the object)
- **STUN + optional TURN:** Defaults to `stun:stun.cloudflare.com:3478`; add
  Cloudflare Realtime TURN secrets anytime for **1,000 GB / 1 TB free per month**
  (short-lived credentials minted by `/ice` — never baked statically into JS)
- **Anonymous build toggle:** Set `VITE_ANONYMOUS_BUILD=true` during `npm run build`
  for anonymous deployments
- **Optional private gate (friends & family only):** Cloudflare Access (free up
  to 50 users, email one-time code — protects a `workers.dev` or `pages.dev` URL
  directly so no public Impressum is needed)

---

## 1. Build & Deploy as a Single Worker (App + Signaling + /ice)

Requires Node ≥ 20 and a free Cloudflare account.

```sh
VITE_ANONYMOUS_BUILD="true" \
VITE_SIGNALING_URL="wss://app.<your-subdomain>.workers.dev/signaling" \
VITE_ICE_SERVERS_URL="https://app.<your-subdomain>.workers.dev/ice" \
npm run build

cd cloudflare/signaling-worker
npx wrangler login
npx wrangler deploy
```

Wrangler uploads `../../dist` as Workers Static Assets and deploys the Worker at
`https://app.<your-subdomain>.workers.dev`.

Verify health and STUN fallback right away:

```sh
curl https://app.<your-subdomain>.workers.dev/health
# {"status":"ok","connections":0,"topics":0,"runtime":"cloudflare-do"}

curl -H "Sec-Fetch-Site: same-origin" https://app.<your-subdomain>.workers.dev/ice
# {"iceServers":[{"urls":"stun:stun.cloudflare.com:3478"}],"ttl":3600}
```

---

## 2. 1 TB/month Free TURN + 10 MB/User Quota + 950 GB Hard Kill-Switch

1. In the Cloudflare Dashboard, open **Realtime → TURN** and create a TURN key.
2. Save the secrets on your Worker (never commit them to git):

```sh
cd cloudflare/signaling-worker
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
# Read-only Cloudflare API token with "Account Analytics: Read" permission —
# lets the 15-minute Cron sync monthly egress from GraphQL callsTurnUsageAdaptiveGroups:
npx wrangler secret put CF_ANALYTICS_TOKEN
# Optional webhook URL (e.g. ntfy.sh/<secret-topic>, Discord, Slack) for 800 GB & 950 GB alerts:
npx wrangler secret put TURN_ALERT_WEBHOOK_URL
```

3. How the €0 quota guard works:
   - Devices sign `/ice` requests with their existing **Ed25519 device key** (zero accounts).
   - Every minted credential has a short **30-minute TTL** (`TURN_TTL_SECONDS = "1800"`) and is
     tagged with an opaque `customIdentifier` (`u_<sha256(pubKey)>`).
   - Every 15 minutes (`*/15 * * * *`), the Worker Cron queries Cloudflare's GraphQL TURN
     Analytics API:
     - **10 MB/user/month** (`TURN_USER_MONTHLY_LIMIT_BYTES`) and **25 MB/IP-prefix/month**
       (`TURN_IP_MONTHLY_LIMIT_BYTES`) — users over quota have active credentials immediately
       revoked and fall back to direct P2P / STUN-only, with a prompt in **Settings → Signaling**
       to plug in their own TURN server.
     - **800 GB warning** (`TURN_ACCOUNT_WARN_BYTES`) — fires `TURN_ALERT_WEBHOOK_URL` once/month.
     - **950 GB hard kill-switch** (`TURN_ACCOUNT_HARD_CAP_BYTES`) — trips the DO SQLite
       kill-switch, revokes all active credentials, and switches `/ice` to STUN-only until the
       1st of the next UTC month.
   - Users who need more than 10 MB/month can enter their own STUN/TURN server (device-local,
     never synced) under **Settings → Signaling → Relay servers (TURN / ICE)**.

### Lock `/ice` to your own app (+ optional Keeper token)

`ALLOWED_ORIGINS` in `cloudflare/signaling-worker/wrangler.toml` restricts `/ice` to your
frontend origin (including same-origin `Sec-Fetch-Site: same-origin` requests).

If you also run a headless Keeper node, set a random bearer token so it can
fetch `/ice` without a browser `Origin` header:

```sh
npx wrangler secret put ICE_ACCESS_TOKEN
npx wrangler deploy
```

---

## 3. Deploy the Frontend to Cloudflare Pages

Build with your Worker's signaling and ICE endpoints:

```sh
VITE_SIGNALING_URL="wss://dapp-signaling.<your-subdomain>.workers.dev/signaling" \
VITE_ICE_SERVERS_URL="https://dapp-signaling.<your-subdomain>.workers.dev/ice" \
npm run build
```

Deploy `dist/` directly via Wrangler (no public GitHub repo needed):

```sh
npx wrangler pages deploy dist --project-name your-app-name
```

Or connect your private repo in **Cloudflare Dashboard → Workers & Pages →
Create → Pages**, set the build command `npm run build`, output directory
`dist`, and add `VITE_SIGNALING_URL` and `VITE_ICE_SERVERS_URL` under
**Settings → Environment variables**.

`public/_redirects` and `public/_headers` are already included so SPA routes
(`/invite`, `/people`, `/dapp/:id/…`) return HTTP 200 and hashed `/assets/*`
cache immutably while `/sw.js` and `/starters/*` always revalidate.

---

## 4. Optional: Keep It Strictly Private for Friends & Family (€0)

In **Cloudflare Zero Trust → Access → Applications**:
1. Add a **Self-hosted** application for `your-app-name.pages.dev` (or your
   custom domain).
2. Add an **Allow** policy listing your and your family/friends' email addresses
   (One-Time PIN — no passwords or accounts required).

---

## 5. Point Your Home Keeper Outbound & Close Home Router Ports

Your home NAS/server Keeper never needs inbound ports anymore. Update its env:

```env
SIGNALING_URLS=wss://dapp-signaling.<your-subdomain>.workers.dev/signaling
ICE_SERVERS_URL=https://dapp-signaling.<your-subdomain>.workers.dev/ice
ICE_ACCESS_TOKEN=<same token set in step 2, if ALLOWED_ORIGINS is enabled>
HEADLESS_APP_URL=https://your-app-name.pages.dev
```

Once your devices and Keeper are syncing through the Worker, you can remove the
signaling port forwards (`80` and `4444`) on your router — your home IP
is no longer exposed anywhere.

---

## Moving Existing Devices Without Splitting

Because the member mesh holds all configured signaling servers at the same time:
1. Add `wss://dapp-signaling.<your-subdomain>.workers.dev/signaling` under
   **Settings → Signaling** (or list old + new comma-separated in
   `VITE_SIGNALING_URL` and `SIGNALING_URLS` during the cutover).
2. Once every device is on the new build, drop the old signaling URL.
