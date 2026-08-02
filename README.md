# bt-gateway

Multi-tenant HTTP gateway in front of [BT Trade](https://bt-trade.ro) (Banca
Transilvania's retail trading platform). Exposes a stable REST API + web UI on
top of an otherwise IP-pinned, OTP-gated, refresh-token-hostile broker.

Runs as a single always-warm container on a self-hosted Raspberry Pi, behind
one stable egress IP so BT's refresh tokens survive across restarts — the
whole reason this service exists.

---

## Why this exists

BT Trade pins session refresh tokens to the IP that issued them. Ephemeral
environments (Claude Code sandboxes, serverless platforms with default
egress, GitHub Actions, your laptop on a café Wi-Fi) get a different egress
IP on every run,
and BT's auth backend rejects the refresh with a terse `IP diferit`. Every
run is then forced through a fresh SMS OTP, and after a few of those in a
day BT's fraud heuristics make things unpleasant.

bt-gateway solves this for good:

- **One pinned identity**. A single always-warm container on the Pi, so
  every call to BT leaves from the same home broadband address. The refresh
  token BT issued two weeks ago still works today. (This used to be a Cloud
  Run service pinned behind a reserved static IP via VPC Connector + Cloud
  NAT; the Pi gets the same property for free by not moving.)
- **One sign-in per account, per day at most**. The access token rotates
  silently every ~10 min; the refresh token rotates every ~30 min; the
  service keeps the chain alive. An SMS OTP is only needed when BT
  invalidates the refresh token (rare).
- **Automatic OTP pickup**. When a login IS needed, the service subscribes
  to a per-user `ntfy.sh` topic and a phone-side Shortcut/Tasker flow posts
  the SMS body verbatim; bt-gateway extracts the code and finishes login.
- **Your trading code stops caring**. Your bots, notebooks, and `curl` one-
  liners hit `bt-gateway` with an API key. They never touch BT credentials,
  OTPs, refresh tokens, or `IP diferit` retries.

---

## What it does

### REST API (`/api/v1/*`)

Authenticated with API keys (`Authorization: Bearer bvb_<mode>_<24 chars>`).
Mode (`demo` | `live`) is baked into the key prefix and enforced on every
request — a `bvb_demo_…` key physically cannot place a real-money order.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/cash` | GET | Available cash on the default portfolio |
| `/api/v1/holdings` | GET | Current positions (`?market=`, `?endDate=`) |
| `/api/v1/markets` | GET | Markets available to this session |
| `/api/v1/instruments/:symbol` | GET | Tick details (price, bid/ask) (`?marketId=`) |
| `/api/v1/orders/preview` | POST | Fees + net value; does NOT place |
| `/api/v1/orders` | POST | Place an order (audited, Telegrammed) |
| `/api/v1/orders` | GET | List orders (`?statuses=`, `?side=`, `?symbol=`, date range) |
| `/api/v1/orders/:id` | GET | Order details + history + allowed actions |
| `/api/v1/session/refresh` | POST | Force a refresh cycle (for the cron) |

All responses follow a single error envelope on failure:

```json
{ "error": { "code": "UNAUTHORIZED", "message": "…", "requestId": "…" } }
```

Rate limit: 60 req/min per API key (in-memory sliding window). The
`requestId` echoes in the `x-request-id` header so you can correlate a
client-side error with the container logs.

### Web UI (Firebase-Auth-gated, Google sign-in)

- **Dashboard** (`/`) — full audit feed for your tenant. Only mutating
  events are recorded here (sign-ins, token refreshes, credential /
  API-key changes, placed/rejected orders). Read operations are in the
  container logs, not in this feed.
- **Settings** (`/settings`):
  - Per-mode BT Trade credentials (separate `demo` and `live`). Stored
    envelope-encrypted under the app's master key. Passwords are never logged or
    returned; the username is shown redacted (`ab…XY`).
  - API keys. Create, label, see last-used, revoke. The raw key is shown
    exactly once at creation — we store only its SHA-256.
  - ntfy topic for each mode's SMS OTP forwarding — copy it into your phone
    Shortcut.
  - Telegram link (optional). Receives sign-in / sign-in-failure alerts.
    Routine 45-min refreshes do **not** ping Telegram.

---

## Architecture

```
Trading routines ──────┐
                       │  API key (bvb_demo_… / bvb_live_…)
                       ▼
Browser (UI) ──────► static SPA on the platform's frontend host (no container)
  (Firebase Auth)      │        └─ /api/* forwarded ─► bt-gateway container on the Pi
                       │          ├── per-tenant BT client pool (in-memory)
                       │          ├── Postgres (the app's own database)
                       │          │    users                (tenant profile)
                       │          │    bt_creds             (master-key wrapped)
                       │          │    bt_sessions          (token snapshot)
                       │          │    api_keys             (sha256 + filters)
                       │          │    events               (audit log)
                       │          │    telegram_links / telegram_bots
                       │          │    journal / fills / considered / snapshots
                       │          ├── MASTER_KEY (envelope encryption)
                       │          └── per-user Telegram bots (sign-in alerts)
                       │
                       └── egress via the Pi's home connection → bt-trade.ro
                                            ▲
                                            │ ntfy.sh subscription for SMS OTP
                                            │ (your phone posts to the topic)
                                            ▼
                              https://ntfy.sh/<per-username topic>

Platform cron ──────► /api/internal/cron/refresh (shared secret, every 45 min)
```

**Data model** — every table is keyed by `uid`, and mode-scoped tables carry
`mode` in their primary key. There is no query that takes a uid as a string
parameter; every read goes through a `TenantRef` that can only be constructed
from an authenticated caller's uid. Cross-tenant access is a type error.

**Mode separation** — demo and live are fully parallel on every axis.
Different creds, different session snapshots, different API-key prefixes.
A compromised demo key cannot be replayed against live endpoints: the
server rejects mode mismatches before touching BT.

---

## Security posture

- **Passwords**: envelope encryption under `MASTER_KEY`. Random 32-byte DEK
  per encrypt, wrapped by the master key with AES-256-GCM; `lib/secret-box.ts`
  stores `[version][ivDek][wrappedDek][ivBody][gcm-body+tag]`. Rotate by
  moving the old key to `MASTER_KEY_PREVIOUS` and re-saving each credential.
  Note the trade against the old KMS setup: the key now sits in the app's
  environment, so anyone who can read the container's env can decrypt the
  database. On a single self-hosted box that is not much of a downgrade —
  an attacker with the container already has the database — but `MASTER_KEY`
  is the crown jewel and should be treated as such.
- **API keys**: SHA-256 hashed at rest, verified in constant time
  (`timingSafeEqual`). The raw key appears in exactly one HTTP response —
  the creation response — and is never logged.
- **Tokens**: BT refresh/access tokens stay on the server. Clients never
  see them. The `onSessionChange` hook persists every rotation to Postgres
  so a container restart can resume without a re-login.
- **UI auth**: Firebase ID token in `Authorization: Bearer` verified by
  `firebase-admin`. `email_verified` is required unless
  `ALLOW_UNVERIFIED_EMAIL=1` (don't set that).
- **Admin**: `isAdmin` is a Firebase custom claim, set out-of-band — users
  cannot self-promote.
- **Deploy identity**: GitHub Actions holds one secret, `PAAS_KEY`, scoped to
  this app alone. It can trigger a redeploy of `bt-gateway` and nothing else;
  it cannot read the database.
- **Network**: egress leaves via the Pi's home connection. Inbound is public
  HTTPS terminated at the edge proxy; auth enforcement is in-app (API key or
  Firebase token). The database listens only on the internal Docker network —
  there is no exposed port.

---

## Deployment

The service runs at **https://bt-gateway-coolify.bogdanripa.com** as one
container on the Pi, with a Postgres database attached on the same internal
Docker network.

Deploys are automatic: push to `main`, and `.github/workflows/deploy.yml`
builds a `linux/arm64` image, pushes it to
`ghcr.io/bogdanripa/bt-gateway:latest`, calls the app's `/refresh` hook, and
then waits for `/api/health` to answer 2xx before going green. The workflow
is generated by the platform — if something about it needs to change (the
branch, the repo name), regenerate it rather than hand-editing, because the
image tag scheme, the arm64 flag and the redeploy call all have to match what
the platform expects.

The one repository secret is `PAAS_KEY`, this app's scoped deploy key.

### App configuration

Set on the app itself (not in the repo, not in GitHub secrets):

| Env | Value |
|---|---|
| `MASTER_KEY` | 32 bytes base64 (`openssl rand -base64 32`). **Losing this makes every stored credential unrecoverable.** |
| `MASTER_KEY_PREVIOUS` | optional, comma-separated; decrypt-only, for rotation |
| `INTERNAL_CRON_SECRET` | shared secret for `/api/internal/cron/refresh` |
| `BT_GATEWAY_PUBLIC_URL` | `https://bt-gateway-coolify.bogdanripa.com` — canonical origin for OAuth metadata and Telegram webhook registration |
| `FIREBASE_PROJECT_ID` | `auto-trader-493814` |
| `FIREBASE_WEB_API_KEY` | Firebase console → Project settings → Web app |
| `FIREBASE_WEB_AUTH_DOMAIN` | `auto-trader-493814.firebaseapp.com` |
| `DATABASE_URL` | injected automatically on every deploy — never set by hand |

The schema is applied by the app itself on first query (`lib/db.ts`), so
there is no migration step in the pipeline.

The 45-minute refresh is a platform cron calling `POST
/api/internal/cron/refresh` with `{"secret": "<INTERNAL_CRON_SECRET>"}` in the
body — the scheduler cannot set headers, so the route accepts the secret in
the body as well as in an `Authorization` header.

`sleep_when_idle` must stay **off**. The BT client pool and the sign-in
single-login guard are both in-memory, so a container that scales to zero
loses its warm sessions and re-logs in on the next request.

Telegram is **per-user**, not server-wide — each user creates their own bot
via @BotFather and registers it in Settings. See
[docs/telegram.md](docs/telegram.md).

### Smoke test

```bash
BASE=https://bt-gateway-coolify.bogdanripa.com
curl -s "$BASE/api/health" | jq

# Egress IP should be stable across calls — it is the identity BT pins
# refresh tokens to.
for i in $(seq 1 20); do curl -s "$BASE/api/health" | jq -r .egressIp; done | sort -u
# → exactly one line
```

### Making yourself admin (one-time)

`isAdmin` is a Firebase custom claim. Set it with the Firebase Admin SDK
against project `auto-trader-493814` using any credential that can write
custom claims — it is not something the gateway itself exposes.

### Usage from iOS Shortcuts

Want one-tap orders / portfolio checks from your phone? See
[docs/ios-shortcuts.md](docs/ios-shortcuts.md) — walks through building
shortcuts around the `/api/v1/orders` and `/api/v1/holdings` endpoints.

### Usage from a trading script

```javascript
const KEY = process.env.BT_GATEWAY_KEY; // bvb_demo_… or bvb_live_…
const BASE = 'https://bt-gateway-coolify.bogdanripa.com';

const res = await fetch(`${BASE}/api/v1/orders`, {
  method: 'POST',
  headers: { 'authorization': `Bearer ${KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    symbol: 'TVBETETF',
    quantity: 10,
    price: 12.5,
    side: 'buy',
    type: 'limit',
    valability: 'day',
  }),
});
console.log(await res.json());
```

---

## Local development

```bash
npm install
npm run dev
open http://localhost:3000
```

Local dev needs its own Postgres — the deployed database is reachable only
from inside the app's container network on the Pi, with no exposed port and
no tunnel. Point `DATABASE_URL` at a local instance and the app will create
its schema on first query.

```bash
docker run -d --name bt-gw-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16
export DATABASE_URL=postgresql://postgres:dev@localhost:5432/postgres
export MASTER_KEY=$(openssl rand -base64 32)
npm run dev
```

Local dev runs against the same Firebase project (so sign-in works) but from
your own IP. Anything that actually talks to BT Trade must be tested against
the deployed service — a local-IP session gets `IP diferit` immediately.

Useful envs for local dev:

| Env | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string (required) |
| `MASTER_KEY` | 32 bytes base64; required to read or write credentials |
| `FIREBASE_PROJECT_ID` | your Firebase project |
| `FIREBASE_WEB_API_KEY`, `FIREBASE_WEB_AUTH_DOMAIN` | Web SDK config |
| `BT_CLIENT_DEBUG=1` | verbose bt-trade logs to stdout |
| `INTERNAL_CRON_SECRET` | required to exercise the cron route |

Use a throwaway `MASTER_KEY` locally. Pointing a local instance at the
production key buys nothing, since the production database is unreachable
from your machine anyway.

---

## Repository layout

```
app/
  api/health/           liveness + egress-IP probe (also the health_path)
  api/v1/…              REST API (API-key-authed)
  api/ui/…              UI backing routes (Firebase-token-authed)
  page.tsx              Dashboard (audit feed)
  settings/page.tsx     Credentials / API keys / Telegram
components/
  auth/                 AuthProvider, AuthGate (Firebase client)
  settings/             CredsCard, ApiKeysCard, TelegramCard
  AuditFeed.tsx, Nav.tsx
server/
  index.ts              entrypoint; node:http, no framework
  http.ts               IncomingMessage <-> Request/Response bridge
  router.ts             :param matcher, static beats dynamic
  registry.ts           the route table
  routes/               38 handlers, one file per endpoint
web/
  src/App.tsx           SPA route table
  src/components/       ported unchanged from the Next tree
  src/pages/            marketing + console pages
lib/
  auth/                 requireApiKey, requireFirebaseUser, requireAdmin
  bt/                   client-pool.ts, portfolio-key.ts, bt-trade .d.ts
  firebase/             admin.ts (server), client.ts (browser), public-config.ts
  db.ts                 Postgres pool + schema bootstrap
  store.ts              data model + typed accessors + TenantRef guard
  secret-box.ts         envelope encryption under MASTER_KEY
  rate-limit.ts         in-memory sliding window
  events.ts             audit log append
  telegram.ts           notifier
  errors.ts, route-handler.ts
scripts/
  migrate-to-postgres.mjs   one-shot Firestore/KMS -> Postgres export
Dockerfile              multi-stage Node 20 Alpine, arm64, API server only
.github/workflows/
  deploy.yml            build arm64 image + push to ghcr + redeploy on the Pi
```

---

## Milestones

| | Exit criterion | Status |
|---|---|---|
| **M1** — Infra foundation | `/api/health` returns the same `egressIp` 20× in a row | ✅ |
| **M2** — Auth + tenants + core gateway | curl places a demo order through the API | ✅ |
| **M3** — Web UI | Sign in, enter BT creds, create API key, see full audit | ✅ |
| **M4** — Cron + Telegram link webhook + migrate `auto-trading` | Morning routine runs end-to-end against the gateway | ⏳ |
| **M5** — Move off GCP onto the Pi | Gateway serves from `bt-gateway-coolify.bogdanripa.com` on Postgres, no GCP runtime dependency but Firebase Auth | ⏳ |

---

## License

Private. Not open for public use.
