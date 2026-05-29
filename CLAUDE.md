# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this service is

Multi-tenant HTTP gateway in front of [BT Trade](https://bt-trade.ro) (Banca Transilvania's retail trading platform). The whole reason it exists: BT pins session refresh tokens to the IP that issued them, so the service runs on Cloud Run with a **static egress IP** (VPC Connector → Cloud NAT → reserved static external IP) and `min-instances=1` / `max-instances=1` so exactly one long-lived identity keeps refresh tokens alive. The single-instance pin is **load-bearing**: the BT sign-in single-login guard (`loginInProgress` in `lib/bt/client-pool.ts`) is in-memory, so running more than one instance would let two logins fire at once and email the user duplicate, mutually-invalidating OTP codes. Two-sided product:

- **`/api/v1/*`** — REST API authenticated by API keys (`Authorization: Bearer bvb_<mode>_<24 chars>`) for trading bots, scripts, iOS Shortcuts.
- **`/api/ui/*` + pages** — Next.js web UI authenticated by Firebase ID tokens (Google sign-in) for managing credentials, API keys, Telegram, and viewing the audit feed.

## Commands

```bash
npm install
npm run dev          # next dev at http://localhost:3000
npm run build        # next build (produces .next/standalone)
npm run start        # next start -p ${PORT:-8080}
npm run lint         # next lint (eslint-config-next)
npm run typecheck    # tsc --noEmit
```

Node 20+ is required (`engines.node >=20.0.0`). There is **no test runner** wired up — no `jest`/`vitest`/`npm test`. Functions ending in `_reset…` / exports under `_internals` exist for future tests but no harness runs them yet.

Local dev shares the real Firebase project (so sign-in works) but runs without the static egress IP, Cloud NAT, or Cloud Scheduler. **Anything that actually talks to BT Trade must be tested against the deployed Cloud Run service** — a local-IP session gets `IP diferit` the moment you push.

Deploys happen automatically via `.github/workflows/deploy.yml` on push to `main` (Workload Identity Federation, build image, `gcloud run deploy`). Keep the flags in `deploy.yml` in sync with `infra/provision-m1.sh` — both define the same security/network posture.

## High-level architecture

### Request flow

```
API client (bvb_... key)  ──► /api/v1/*  ──► requireApiKey ──► BTTradeClient (pooled) ──► bt-trade.ro
Browser (Firebase ID tok) ──► /api/ui/*  ──► requireFirebaseUser ──► Firestore / KMS / BTTradeClient
Cloud Scheduler (OIDC)    ──► /api/internal/cron/refresh ──► refreshAllTenants
Telegram (webhook)        ──► /api/v1/telegram/webhook/:secret ──► findTelegramBotByWebhookSecret
```

Every `/api/v1/*` handler is wrapped in `withRoute` (`lib/route-handler.ts`), which assigns a `requestId`, emits one structured access log per request, turns thrown `ApiError`s into the canonical JSON envelope `{ error: { code, message, requestId } }`, and echoes the request ID in `x-request-id`. Non-`ApiError` throws are flattened to `INTERNAL` and real details go to logs only. Route handlers should **throw `ApiError`** rather than returning error responses.

Use `export const runtime = 'nodejs'` and `export const dynamic = 'force-dynamic'` on route files that need server-only APIs (KMS, Firestore admin). Import path alias is `@/*` → repo root.

### Tenant isolation (load-bearing)

All persistent state lives under `users/{uid}/…` in Firestore (europe-west3). There is **no Firestore helper that takes a raw uid string** — they all take a `TenantRef` (`lib/firestore.ts`), and the only legitimate constructor is `tenantFromAuthedUid(uid)` called from one of the auth helpers. This makes cross-tenant access a type error.

Auth helpers live in `lib/auth/`:
- `requireApiKey(req)` — walks `collectionGroup('api_keys')`, verifies SHA-256 of the bearer key with `timingSafeEqual`, enforces mode from the key prefix, applies a 60 req/min sliding-window rate limit per key, fire-and-forgets `touchApiKey` to update `lastUsedAt`, returns `{ tenant, mode, keyId }`.
- `requireFirebaseUser(req)` — verifies the Firebase ID token via `firebase-admin`, rejects unverified emails unless `ALLOW_UNVERIFIED_EMAIL=1`, returns `{ tenant, email, isAdmin }`. `requireAdmin` layers a check on the `isAdmin` custom claim.

### Mode axis (demo vs live)

`demo` and `live` are fully parallel on every axis: separate `bt_creds/{mode}` docs, separate `bt_session/{mode}` snapshots, separate `trading_state/{mode}` subtrees, and separate API-key prefixes (`bvb_demo_…` / `bvb_live_…`). Mode is derived from the API-key prefix inside `authenticateApiKey`; there is **no body param to pick a mode** — a compromised demo key physically cannot hit live endpoints.

**UI mode is global.** The browser side has a single `ModeProvider` (`components/mode/ModeProvider.tsx`) mounted in `app/layout.tsx` between `AuthProvider` and the page. The selected mode is rendered as a toggle in the header (`Nav.tsx`) and persisted to `localStorage`. Every dashboard / settings widget reads from `useMode()` and filters its data accordingly: `AccountSnapshot`, `SessionStatus`, `AuditFeed` (mode-less events still pass through), `ApiKeysCard` (also filters its rows by mode), `CredsCard` (the settings page mounts a single instance keyed on mode so it remounts on switch). Do not introduce per-component mode state — wire new mode-scoped widgets to the context instead.

When adding a new `/api/v1/*` route that touches BT, the pattern is always:

```ts
const caller = await requireApiKey(req);
const client = await getBtClient(caller.tenant, caller.mode);
const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);
```

### BT client pool (`lib/bt/client-pool.ts`)

One `BTTradeClient` per `(uid, mode)` kept in a process-local `Map` on the always-warm instance, guarded by a per-key in-flight promise so concurrent first-requests share one build. Lifecycle:

1. Read encrypted `BtCredsDoc`, KMS-decrypt username+password.
2. Try to `restore()` from the persisted `BtSessionDoc` snapshot — skips OTP.
3. If there's no snapshot (or restore throws), call `login()` — blocks up to 5 min waiting for an OTP posted to the user's ntfy topic via `defaultNtfyTopic(username)`.
4. `onSessionChange` hook persists every token rotation back to `bt_session/{mode}`.
5. `onExpired` hook audits `signin.failure`, sends Telegram alert, evicts from pool.

**Telegram notification policy**: sign-in success/failure and refresh failure alert. Routine `refresh.success` does NOT Telegram (user rule: "don't message me every 45 minutes") — only the audit feed records it. The 45-min Cloud Scheduler job hits `/api/internal/cron/refresh`, walks `listActiveTenantUids()` × `['demo','live']`, runs `refreshTenantMode` which uses a throwaway client and `client.auth.refresh()` — it never prompts for OTP. On refresh failure the snapshot is deleted and the pool entry evicted so the next user-initiated call triggers a fresh login.

`getPortfolioKey` is separately cached in-memory per `(uid, mode)` — it calls `client.accounts.list()` and picks `selected` → `allowTrading` → first.

### Secrets at rest (`lib/kms.ts`)

Envelope encryption using Cloud KMS (`bt-gateway` keyring, `tenant-creds` key, 90-day rotation). Per encrypt: random 32-byte DEK → KMS-wraps it → AES-256-GCM the plaintext under the DEK. Stored blob is base64 of `[2-byte wrappedDekLen BE][wrappedDek][12-byte iv][aes-gcm body+16-byte tag]`. Every decrypt calls KMS (no DEK caching yet). **Never log or return** decrypted credentials, tokens, or bot tokens.

API keys are SHA-256 hashed at rest; the raw key is shown to the user exactly once, in the creation response, and never logged. `prefix` (first 12 chars) is stored plain for UI identification.

### Audit log (`lib/events.ts`)

Only **mutating** events land in `users/{uid}/events/{eid}`: sign-ins, refreshes, order placed/cancelled/rejected, creds updated, API key created/revoked, Telegram linked/unlinked. Reads (cash, holdings, orders list) are **not** audited — they live in Cloud Logging only via the `route.access` JSON line emitted by `withRoute`. Every `audit()` call also mirrors to stdout as structured JSON so you can correlate the feed with Cloud Logging by `requestId`.

### Telegram (per-user bots)

There is **no service-wide Telegram bot token**. Each tenant creates their own bot via @BotFather; the token is envelope-encrypted and stored at `users/{uid}/integrations/bot`. The webhook path segment `/api/v1/telegram/webhook/:secret` IS the lookup key — inbound updates resolve sender → uid via a `collectionGroup('integrations').where('_type', '==', 'telegram_bot').where('webhookSecret', '==', …)` query. Linking uses a short-lived `telegram_pending` doc with a `/start <code>` handshake (TTL `PENDING_TELEGRAM_LINK_TTL_MS` = 10 min).

Outbound is `notifyTenant(tenant, text)` in `lib/telegram.ts` — silent no-op if the user hasn't configured a bot or linked a chat, and it never throws (a failed alert must not turn into a 500 for the caller).

### Trading state helpers

`users/{uid}/trading_state/{mode}/{portfolio|journal|fills|considered|snapshots}` holds data the `auto-trading` client project used to write directly to Firestore. It now goes through the gateway API (see `/api/v1/state/portfolio`, `/api/v1/journal`, `/api/v1/fills`, `/api/v1/considered`, `/api/v1/snapshots`) and the helpers in `lib/firestore.ts` enforce the same `TenantRef` + mode isolation.

## Conventions to follow

- **Server-only modules**: every file under `lib/` that touches Firestore, KMS, or `firebase-admin` starts with `import 'server-only'`. Do not import these into `'use client'` components — use `lib/ui-client.ts` (`uiFetch`) for browser → `/api/ui/*` calls, which auto-attaches the Firebase ID token.
- **Errors**: throw `ApiError(code, message, { context })` — contexts are logged, not returned. The canonical codes live in `lib/errors.ts` (`BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, `CONFLICT`, `UPSTREAM_UNAVAILABLE`, `INTERNAL`). Use `UPSTREAM_UNAVAILABLE` (502) whenever BT returns an error or network fails.
- **Validation**: use `zod` schemas at handler boundaries (see `app/api/v1/orders/route.ts`). On failure throw `ApiError('BAD_REQUEST', '...', { context: { issues: parsed.error.issues } })`.
- **Logging**: structured JSON to stdout (`severity`, `msg`, `requestId`, then specific fields) — Cloud Logging parses this. Do not use `console.log` for plain strings in request paths.
- **Keep demo/live fully separated**. When you add anything tenant-scoped, it must also be mode-scoped; never write a helper that forgets the `mode` parameter.
- **`deploy.yml` and `infra/provision-m1.sh` must stay in sync** for Cloud Run flags (`--min-instances=1`, `--max-instances=1` (load-bearing — see above), `--vpc-connector`, `--vpc-egress=all-traffic`, SAs, env vars, secrets).
- The root layout (`app/layout.tsx`) is `export const dynamic = 'force-dynamic'` on purpose — it inlines Firebase Web config from Cloud Run env into the HTML. Don't make it static.

## Useful env vars for local dev

| Env | Meaning |
|---|---|
| `FIREBASE_PROJECT_ID` | your Firebase project |
| `FIREBASE_WEB_API_KEY`, `FIREBASE_WEB_AUTH_DOMAIN` | Web SDK config, inlined at render time |
| `KMS_PROJECT`, `KMS_LOCATION`, `KMS_KEYRING`, `KMS_KEY` | override KMS path |
| `BT_CLIENT_DEBUG=1` | verbose bt-trade logs to stdout |
| `INTERNAL_CRON_SECRET` | required for `/api/internal/cron/refresh`; in prod mounted from Secret Manager |
| `ALLOW_UNVERIFIED_EMAIL=1` | only for local debugging; never set in prod |
| `GOOGLE_APPLICATION_CREDENTIALS` or `gcloud auth application-default login` | Firestore + KMS credentials |

## Where to look first

- New API endpoint → copy the shape of `app/api/v1/orders/route.ts`.
- New UI-backed endpoint → copy `app/api/ui/keys/route.ts` (auth via `requireFirebaseUser`).
- New persisted data type → add the `Doc` interface + typed accessors in `lib/firestore.ts`; never access collections ad-hoc.
- Cron job expansion → extend `lib/bt/refresh.ts` and the single cron route in `app/api/internal/cron/refresh/route.ts`.
- Docs: `docs/telegram.md` (per-user bot setup), `docs/ios-shortcuts.md` (client examples). Infra entrypoint is `infra/provision-m1.sh`.
