# bt-gateway

Multi-tenant HTTP gateway in front of [BT Trade](https://bt-trade.ro) (Banca
Transilvania's retail trading platform). Exposes a stable REST API + web UI on
top of an otherwise IP-pinned, OTP-gated, refresh-token-hostile broker.

Runs on Cloud Run with a **static egress IP** so BT's refresh tokens survive
across invocations — the whole reason this service exists.

---

## Why this exists

BT Trade pins session refresh tokens to the IP that issued them. Ephemeral
environments (Claude Code sandboxes, Cloud Run with default egress, GitHub
Actions, your laptop on a café Wi-Fi) get a different egress IP on every run,
and BT's auth backend rejects the refresh with a terse `IP diferit`. Every
run is then forced through a fresh SMS OTP, and after a few of those in a
day BT's fraud heuristics make things unpleasant.

bt-gateway solves this for good:

- **One pinned identity**. A single always-warm Cloud Run instance
  (`min-instances=1`) with all egress forced through a Serverless VPC
  Connector → Cloud NAT → reserved static external IP. The refresh token BT
  issued two weeks ago still works today.
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
client-side error with Cloud Logging.

### Web UI (Firebase-Auth-gated, Google sign-in)

- **Dashboard** (`/`) — full audit feed for your tenant. Only mutating
  events are recorded here (sign-ins, token refreshes, credential /
  API-key changes, placed/rejected orders). Read operations are in Cloud
  Logging, not in this feed.
- **Settings** (`/settings`):
  - Per-mode BT Trade credentials (separate `demo` and `live`). Stored
    envelope-encrypted via Cloud KMS. Passwords are never logged or
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
Browser (UI) ──────► Cloud Run (Next.js: API routes + pages)
  (Firebase Auth)      │          ├── per-tenant BT client pool (in-memory)
                       │          ├── Firestore (europe-west3)
                       │          │    users/{uid}/bt_creds/{mode}    (KMS-wrapped)
                       │          │    users/{uid}/bt_session/{mode}  (token snapshot)
                       │          │    users/{uid}/api_keys/{kid}
                       │          │    users/{uid}/events/{eid}       (audit log)
                       │          │    users/{uid}/integrations/telegram
                       │          ├── Cloud KMS (envelope encryption)
                       │          └── Telegram bot (shared, sign-in alerts)
                       │
                       └── egress via VPC Connector → Cloud NAT
                            (static IP → bt-trade.ro)
                                            ▲
                                            │ ntfy.sh subscription for SMS OTP
                                            │ (your phone posts to the topic)
                                            ▼
                              https://ntfy.sh/<per-username topic>

Cloud Scheduler ────► /api/v1/session/refresh (OIDC-authed, every 45 min)
```

**Data model** — everything lives under `users/{uid}/…`. There is no
collection lookup that takes a uid as a string parameter; every read goes
through a `TenantRef` that can only be constructed from an authenticated
caller's uid. Cross-tenant access is a type error.

**Mode separation** — demo and live are fully parallel on every axis.
Different creds, different session snapshots, different API-key prefixes.
A compromised demo key cannot be replayed against live endpoints: the
server rejects mode mismatches before touching BT.

---

## Security posture

- **Passwords**: Cloud KMS envelope encryption. Random 32-byte DEK per
  encrypt, wrapped by a KMS KEK (`tenant-creds` key in `bt-gateway` ring,
  90-day rotation). `lib/kms.ts` stores `[wrappedDek][iv][gcm-body+tag]`.
  The runtime SA has `roles/cloudkms.cryptoKeyEncrypterDecrypter` on
  exactly one key.
- **API keys**: SHA-256 hashed at rest, verified in constant time
  (`timingSafeEqual`). The raw key appears in exactly one HTTP response —
  the creation response — and is never logged.
- **Tokens**: BT refresh/access tokens stay on the server. Clients never
  see them. The `onSessionChange` hook persists every rotation to
  Firestore so a Cloud Run cold start can resume without a re-login.
- **UI auth**: Firebase ID token in `Authorization: Bearer` verified by
  `firebase-admin`. `email_verified` is required unless
  `ALLOW_UNVERIFIED_EMAIL=1` (don't set that).
- **Admin**: `isAdmin` is a Firebase custom claim, set out-of-band via
  `gcloud` — users cannot self-promote.
- **Deploy identity**: GitHub Actions uses Workload Identity Federation.
  No JSON SA keys in repo secrets. The deployer SA can push images and
  update the Cloud Run service; it cannot read Firestore tenant data.
- **Network**: all egress is NATed through the reserved static IP. Inbound
  is public HTTPS; auth enforcement is in-app (API key or Firebase token).

---

## First-time setup

Prereqs on your workstation: `gcloud` authed as owner of the GCP project,
Docker, Node 20+, `gh` (optional), a Firebase project with Google sign-in
enabled in the same GCP project.

```bash
# 1. Provision GCP: VPC, NAT, static IP, Artifact Registry, SAs,
#    Workload Identity Federation, KMS keyring + key, placeholder Cloud Run.
./infra/provision-m1.sh
```

Copy the secrets it prints into this GitHub repo's Actions secrets
(`Settings → Secrets and variables → Actions`):

| Secret | Value |
|---|---|
| `GCP_PROJECT_ID` | e.g. `auto-trader-493814` |
| `GCP_REGION` | e.g. `europe-west3` |
| `GCP_WIF_PROVIDER` | full resource path printed by the script |
| `GCP_DEPLOYER_SA` | `bt-gateway-deployer@...iam.gserviceaccount.com` |
| `GCP_AR_REPO` | `bt-gateway` |
| `GCP_RUNTIME_SA` | `bt-gateway-runtime@...iam.gserviceaccount.com` |
| `GCP_CONNECTOR` | `bt-gw-connector` |
| `CLOUD_RUN_SERVICE` | `bt-gateway` |
| `FIREBASE_PROJECT_ID` | same as `GCP_PROJECT_ID` if shared |
| `FIREBASE_WEB_API_KEY` | Firebase console → Project settings → Web app |
| `FIREBASE_WEB_AUTH_DOMAIN` | `<project>.firebaseapp.com` |

Telegram is **per-user**, not server-wide — each user creates their own bot
via @BotFather and registers it in Settings. There is no `TELEGRAM_BOT_TOKEN`
GitHub secret anymore. See [docs/telegram.md](docs/telegram.md).

Push to main. GitHub Actions builds, pushes, and deploys.

```bash
git push origin main

# Smoke test: static egress IP holds across 20 calls
URL="$(gcloud run services describe bt-gateway \
        --region=europe-west3 --project="$GCP_PROJECT_ID" \
        --format='value(status.url)')"
for i in $(seq 1 20); do curl -s "$URL/api/health" | jq -r .egressIp; done | sort -u
# → exactly one line (the reserved static IP)
```

### Making yourself admin (one-time)

```bash
# Find your Firebase uid after your first sign-in (check Firebase console)
gcloud auth application-default print-access-token | \
  xargs -I{} curl -sX POST \
    "https://identitytoolkit.googleapis.com/v1/projects/$FIREBASE_PROJECT_ID/accounts:update" \
    -H 'Authorization: Bearer {}' \
    -H 'content-type: application/json' \
    -d '{"localId":"<your-uid>","customAttributes":"{\"isAdmin\":true}"}'
```

### Usage from iOS Shortcuts

Want one-tap orders / portfolio checks from your phone? See
[docs/ios-shortcuts.md](docs/ios-shortcuts.md) — walks through building
shortcuts around the `/api/v1/orders` and `/api/v1/holdings` endpoints.

### Usage from a trading script

```javascript
const KEY = process.env.BT_GATEWAY_KEY; // bvb_demo_… or bvb_live_…
const BASE = 'https://bt-gateway-xxxxx-ew.a.run.app';

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

Local dev runs against the same Firebase project (so sign-in works) but
without the static egress IP, without the Cloud NAT, and without Cloud
Scheduler. Anything that actually talks to BT Trade must be tested against
the deployed Cloud Run service — a local-ip session will get `IP diferit`
the moment you commit and push.

Useful envs for local dev:

| Env | Meaning |
|---|---|
| `FIREBASE_PROJECT_ID` | your Firebase project |
| `FIREBASE_WEB_API_KEY`, `FIREBASE_WEB_AUTH_DOMAIN` | Web SDK config |
| `KMS_PROJECT`, `KMS_LOCATION`, `KMS_KEYRING`, `KMS_KEY` | override KMS path |
| `BT_CLIENT_DEBUG=1` | verbose bt-trade logs to stdout |
| `TELEGRAM_BOT_TOKEN` | optional; empty → alerts no-op |

`GOOGLE_APPLICATION_CREDENTIALS` or `gcloud auth application-default login`
provides Firestore + KMS credentials locally.

---

## Repository layout

```
app/
  api/health/           egress-IP probe (M1 smoke test)
  api/v1/…              REST API (API-key-authed)
  api/ui/…              UI backing routes (Firebase-token-authed)
  page.tsx              Dashboard (audit feed)
  settings/page.tsx     Credentials / API keys / Telegram
components/
  auth/                 AuthProvider, AuthGate (Firebase client)
  settings/             CredsCard, ApiKeysCard, TelegramCard
  AuditFeed.tsx, Nav.tsx
lib/
  auth/                 requireApiKey, requireFirebaseUser, requireAdmin
  bt/                   client-pool.ts, portfolio-key.ts, bt-trade .d.ts
  firebase/             admin.ts (server), client.ts (browser), public-config.ts
  firestore.ts          data model + TenantRef guard
  kms.ts                envelope encryption
  rate-limit.ts         in-memory sliding window
  events.ts             audit log append
  telegram.ts           notifier
  errors.ts, route-handler.ts
infra/
  provision-m1.sh       idempotent GCP provisioning
Dockerfile              multi-stage Node 20 Alpine, standalone output
.github/workflows/
  deploy.yml            build + push + `gcloud run deploy`
```

---

## Milestones

| | Exit criterion | Status |
|---|---|---|
| **M1** — Infra foundation | `/api/health` returns the same `egressIp` 20× in a row | ✅ |
| **M2** — Auth + tenants + core gateway | curl places a demo order through the API | ✅ |
| **M3** — Web UI | Sign in, enter BT creds, create API key, see full audit | ✅ |
| **M4** — Cron + Telegram link webhook + migrate `auto-trading` | Morning routine runs end-to-end against the gateway | ⏳ |

---

## License

Private. Not open for public use.
