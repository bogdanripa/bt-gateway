# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this service is

Multi-tenant HTTP gateway in front of [BT Trade](https://bt-trade.ro) (Banca Transilvania's retail trading platform). The whole reason it exists: BT pins session refresh tokens to the IP that issued them, so the service needs one long-lived identity with a stable egress address to keep refresh tokens alive.

It runs as a container on a self-hosted Raspberry Pi (Coolify, managed through the Pironman tooling), served at **https://bt-gateway-coolify.bogdanripa.com**, with a Postgres database attached on the same internal Docker network.

**The container is disposable.** `sleep_when_idle` is on: it scales to zero when idle and the first request afterwards waits a few seconds while it starts. Nothing of consequence lives in the process. Every BT session snapshot is written to `bt_sessions` on each token rotation (`onSessionChange`) and restored on the next build (`client.restore`), so a cold start resumes the session rather than prompting for an OTP. There is no refresh cron — sessions are re-authenticated on demand, driven by the transport's 401-retry, and a session BT has genuinely expired surfaces as `SESSION_EXPIRED` (503) for the user to re-auth.

Everything else held in a module-level `Map` — the BT client pool, `getPortfolioKey`, the markets and evaluation-currency caches, the rate-limit buckets — is a **cache over the database or over BT**, and is expected to be lost. Losing it costs one extra upstream call, never correctness. The one exception worth knowing is the rate limiter: its window resets whenever the container starts, which is intended (it exists to stop a runaway loop hammering BT, not to enforce a quota).

Still true: only **one instance at a time**. The sign-in single-login guard (`loginInProgress` in `lib/bt/client-pool.ts`) is a process-local `Set`, so two concurrent instances would each fire their own 2FA and email the user colliding OTP codes. Scale-to-zero is safe because the platform runs one container; horizontal scaling would not be.

Two-sided product:

- **`/api/v1/*`** — REST API authenticated by API keys (`Authorization: Bearer bvb_<mode>_<24 chars>`) for trading bots, scripts, iOS Shortcuts.
- **`/api/ui/*`** — the same server, authenticated by Firebase ID tokens (Google sign-in), backing the console UI.

**The two halves deploy separately.** The container (`server/`) is a plain Node HTTP server that only ever emits JSON — no framework, no HTML, ~144 kB bundled. The UI (`web/`) is a Vite + React SPA uploaded to the platform's static frontend host, which serves any path present in the bundle and forwards everything else to the container. That rule is the whole routing contract: **`/api/*` must never exist in the bundle.**

This replaced Next.js, which was shipping a React SSR runtime to serve what is, on the server side, only JSON. A marketing copy change is now a ~1 s upload instead of an arm64 image rebuild under QEMU.

### What is still on GCP

Only **Firebase Auth**, and only for verifying ID tokens. `lib/firebase/admin.ts` calls `verifyIdToken`, which checks the signature against Google's public certs — it needs the project ID, not a service-account credential, so the container holds no GCP keys. Firestore, Cloud KMS, Cloud Run, Cloud NAT, Cloud Scheduler, Secret Manager and Artifact Registry are all gone.

## Commands

```bash
npm install
npm run build        # esbuild -> dist/server.js (one ESM file)
npm run start        # node dist/server.js
npm run typecheck    # tsc --noEmit  (scoped to lib/ + server/)

cd web && npm run dev     # Vite at :3000, proxies /api to :8080
cd web && npm run build   # -> web/dist, the bundle CI uploads
```

The server bundles with esbuild rather than plain `tsc` because `@bogdanripa/bt-trade` is ESM-only while `firebase-admin` and `pg` are CommonJS: the output has to be ESM, and ESM would otherwise demand explicit `.js` extensions on every relative import across ~60 files. `packages: 'external'` keeps node_modules out of the bundle — firebase-admin's dynamic requires do not survive bundling.

Node 20+ is required (`engines.node >=20.0.0`). There is **no test runner** wired up — no `jest`/`vitest`/`npm test`. Functions ending in `_reset…` / exports under `_internals` exist for future tests but no harness runs them yet. `npm run lint` is not usable either — it prompts for interactive ESLint setup that this repo has never done. **`npm run typecheck` is the real check**; run it before you commit.

Local dev needs its own Postgres and its own `MASTER_KEY`; the deployed database has no exposed port and is unreachable from anywhere but the app's own container. Point `DATABASE_URL` at a local instance and the app creates its schema on first query. Local dev shares the real Firebase project so sign-in works, but **anything that actually talks to BT Trade must be tested against the deployed service** — a local-IP session gets `IP diferit` immediately.

Deploys happen automatically via `.github/workflows/deploy.yml` on push to `main`: build a `linux/arm64` image, push to `ghcr.io/bogdanripa/bt-gateway`, call the app's `/refresh` hook, wait for `/api/health`. That workflow is **generated by the platform** — if it needs to change (branch, repo name), regenerate it via the deploy-workflow tool rather than hand-editing, because the tag scheme, the arm64 flag and the redeploy call all have to match what the platform expects.

## High-level architecture

### Request flow

```
API client (bvb_... key)  ──► /api/v1/*  ──► requireApiKey ──► BTTradeClient (pooled) ──► bt-trade.ro
Browser (Firebase ID tok) ──► /api/ui/*  ──► requireFirebaseUser ──► Postgres / secret-box / BTTradeClient
Telegram (webhook)        ──► /api/v1/telegram/webhook/:secret ──► findTelegramBotByWebhookSecret
```

Every `/api/v1/*` handler is wrapped in `withRoute` (`lib/route-handler.ts`), which assigns a `requestId`, emits one structured access log per request, turns thrown `ApiError`s into the canonical JSON envelope `{ error: { code, message, requestId } }`, and echoes the request ID in `x-request-id`. Non-`ApiError` throws are flattened to `INTERNAL` and real details go to logs only. Route handlers should **throw `ApiError`** rather than returning error responses.

Handlers are Web-standard: they take a `Request` and return a `Response` (Node 20 ships both). There is no framework and no per-file config — a route exists because it is in the table in `server/registry.ts`, which maps `:param` paths to the exported `GET`/`POST`/… of a module under `server/routes/`. Static segments outrank dynamic ones at equal depth, which is what keeps `/api/v1/orders/preview` from being swallowed by `/api/v1/orders/:id`. Import path alias is `@/*` → repo root.

### Storage (`lib/db.ts`, `lib/store.ts`)

`lib/db.ts` owns the `pg` pool and the schema. The DDL is entirely `IF NOT EXISTS` and is applied once per process, guarded by a module-level promise that every query awaits — so a deploy stays one moving part, not two. `DATABASE_URL` is injected by the platform on every deploy; never hardcode it.

**Timestamps are ISO-8601 `text`, deliberately.** The Firestore layer this replaced stored them as ISO strings and compared them with plain `>=`, relying on ISO-8601 in UTC sorting correctly as a string. Keeping `text` means the ported queries have byte-identical ordering and range semantics. Do not "improve" a column to `timestamptz` without checking every comparison that reads it.

`lib/store.ts` is the only module that writes SQL. Add new persisted data types there as typed accessors — never query a table ad-hoc from a route.

### Tenant isolation (load-bearing)

Every table is keyed by `uid`, and mode-scoped tables carry `mode` in their primary key. There is **no store helper that takes a raw uid string** — they all take a `TenantRef` (`lib/store.ts`), and the only legitimate constructor is `tenantFromAuthedUid(uid)` called from one of the auth helpers. This makes cross-tenant access a type error.

Auth helpers live in `lib/auth/`:
- `requireApiKey(req)` — one indexed point-read on the UNIQUE `api_keys.hash` column, verifies the SHA-256 of the bearer with `timingSafeEqual`, enforces that the mode in the key prefix matches the mode on the row, applies a 60 req/min sliding-window rate limit per key, fire-and-forgets `touchApiKey` to update `lastUsedAt`, returns `{ tenant, mode, keyId, filters, access }`.
- `requireFirebaseUser(req)` — verifies the Firebase ID token via `firebase-admin`, rejects unverified emails unless `ALLOW_UNVERIFIED_EMAIL=1`, returns `{ tenant, email, isAdmin }`. `requireAdmin` layers a check on the `isAdmin` custom claim.

### Mode axis (demo vs live)

`demo` and `live` are fully parallel on every axis: separate `bt_creds` rows, separate `bt_sessions` snapshots, separate trading-state rows, and separate API-key prefixes (`bvb_demo_…` / `bvb_live_…`). Mode is derived from the API-key prefix inside `authenticateApiKey`; there is **no body param to pick a mode** — a compromised demo key physically cannot hit live endpoints.

**UI mode is global.** The browser side has a single `ModeProvider` (`components/mode/ModeProvider.tsx`) mounted in `app/layout.tsx` between `AuthProvider` and the page. The selected mode is rendered as a toggle in the header (`Nav.tsx`) and persisted to `localStorage`. Every dashboard / settings widget reads from `useMode()` and filters its data accordingly: `AccountSnapshot`, `SessionStatus`, `AuditFeed` (mode-less events still pass through), `ApiKeysCard` (also filters its rows by mode), `CredsCard` (the settings page mounts a single instance keyed on mode so it remounts on switch). Do not introduce per-component mode state — wire new mode-scoped widgets to the context instead.

When adding a new `/api/v1/*` route that touches BT, the pattern is always:

```ts
const caller = await requireApiKey(req);
const client = await getBtClient(caller.tenant, caller.mode);
const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);
```

### BT client pool (`lib/bt/client-pool.ts`)

One `BTTradeClient` per `(uid, mode)` kept in a process-local `Map`, guarded by a per-key in-flight promise so concurrent first-requests share one build. The `Map` is a cache: the authoritative session lives in `bt_sessions`, so an empty pool after a cold start costs a `restore()`, not a login. Lifecycle:

1. Read encrypted `BtCredsDoc`, decrypt username+password.
2. Try to `restore()` from the persisted `BtSessionDoc` snapshot — skips OTP.
3. If there's no snapshot (or restore throws), call `login()` — blocks up to 5 min waiting for an OTP posted to the user's ntfy topic via `defaultNtfyTopic(username)`.
4. `onSessionChange` hook persists every token rotation back to `bt_sessions`.
5. `onExpired` hook audits `signin.failure`, sends Telegram alert, evicts from pool.

**Telegram notification policy**: sign-in success/failure and refresh failure alert. Routine `refresh.success` does NOT Telegram (user rule: "don't message me every 45 minutes") — only the audit feed records it.

**There is no refresh cron.** It was removed along with `lib/bt/refresh.ts` and `/api/internal/cron/refresh`: with the container scaling to zero there is nothing to keep warm between requests, and a scheduled sweep would only defeat the point by waking it every half hour. Tokens are refreshed lazily by the transport's 401-retry and by `POST /api/v1/session/refresh`; when BT has genuinely expired the session, `onExpired` deletes the snapshot, evicts the pool entry and alerts over Telegram, and the next user-initiated call performs a full OTP login.

`getPortfolioKey` is separately cached in-memory per `(uid, mode)` — it calls `client.accounts.list()` and picks `selected` → `allowTrading` → first.

### Secrets at rest (`lib/secret-box.ts`)

Envelope encryption under a 32-byte `MASTER_KEY` from the app's environment. Per encrypt: random 32-byte DEK → AES-256-GCM-wrapped by the master key → AES-256-GCM the plaintext under the DEK. Stored blob is base64 of `[1-byte version][12-byte ivDek][48-byte wrappedDek][12-byte ivBody][body+16-byte tag]`.

Rotation: move the old key into `MASTER_KEY_PREVIOUS` (comma-separated, decrypt-only), put the new one in `MASTER_KEY`, redeploy, re-save each credential. Decrypt tries the primary then each previous key in turn; AES-GCM authenticates, so a wrong key fails the tag check rather than returning garbage.

**Losing `MASTER_KEY` makes every stored credential and bot token permanently unrecoverable.** The key lives in the container's environment, so anyone who can read that env can decrypt the database — a real downgrade from KMS in principle, and an accepted one here because an attacker with the container already has the database.

**Never log or return** decrypted credentials, tokens, or bot tokens.

API keys are SHA-256 hashed at rest; the raw key is shown to the user exactly once, in the creation response, and never logged. `prefix` (first 12 chars) is stored plain for UI identification.

### Audit log (`lib/events.ts`)

Only **mutating** events land in the `events` table: sign-ins, refreshes, order placed/cancelled/rejected, creds updated, API key created/revoked, Telegram linked/unlinked. Reads (cash, holdings, orders list) are **not** audited — they live in the container logs only via the `route.access` JSON line emitted by `withRoute`. Every `audit()` call also mirrors to stdout as structured JSON so you can correlate the feed with the container logs by `requestId`.

### Telegram (per-user bots)

There is **no service-wide Telegram bot token**. Each tenant creates their own bot via @BotFather; the token is envelope-encrypted and stored in `telegram_bots`. The webhook path segment `/api/v1/telegram/webhook/:secret` IS the lookup key — inbound updates resolve sender → uid via the UNIQUE `webhook_secret` column. Linking uses a short-lived `telegram_pending` row with a `/start <code>` handshake (TTL `PENDING_TELEGRAM_LINK_TTL_MS` = 10 min).

Outbound is `notifyTenant(tenant, text)` in `lib/telegram.ts` — silent no-op if the user hasn't configured a bot or linked a chat, and it never throws (a failed alert must not turn into a 500 for the caller).

### Trading state helpers

The `portfolio_state`, `journal`, `fills`, `considered` and `snapshots` tables hold data the `auto-trading` client project used to write directly to Firestore. It now goes through the gateway API (see `/api/v1/state/portfolio`, `/api/v1/journal`, `/api/v1/fills`, `/api/v1/considered`, `/api/v1/snapshots`) and the helpers in `lib/store.ts` enforce the same `TenantRef` + mode isolation.

The three record streams sort on a value extracted from the JSON payload into a stored generated column (`journal.ts`, `fills.filled_at`, `considered.logged_at`). Listings filter `IS NOT NULL` on that column, which mirrors Firestore: a document missing the `orderBy` field simply did not appear in the query.

## Conventions to follow

- **Server-only modules**: every file under `lib/` that touches Postgres, crypto, or `firebase-admin` starts with `import 'server-only'`. Do not import these into `'use client'` components — use `lib/ui-client.ts` (`uiFetch`) for browser → `/api/ui/*` calls, which auto-attaches the Firebase ID token.
- **Errors**: throw `ApiError(code, message, { context })` — contexts are logged, not returned. The canonical codes live in `lib/errors.ts` (`BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, `CONFLICT`, `UPSTREAM_UNAVAILABLE`, `INTERNAL`). Use `UPSTREAM_UNAVAILABLE` (502) whenever BT returns an error or network fails.
- **Validation**: use `zod` schemas at handler boundaries (see `app/api/v1/orders/route.ts`). On failure throw `ApiError('BAD_REQUEST', '...', { context: { issues: parsed.error.issues } })`.
- **Logging**: structured JSON to stdout (`severity`, `msg`, `requestId`, then specific fields). Do not use `console.log` for plain strings in request paths.
- **Keep demo/live fully separated**. When you add anything tenant-scoped, it must also be mode-scoped; never write a helper that forgets the `mode` parameter.
- **All SQL lives in `lib/store.ts`.** Routes call typed accessors. If you need a new query, add a named helper next to its siblings.
- **`/api/health` must not depend on the database.** It is the container healthcheck and the deploy's readiness gate; making it touch Postgres turns a transient database blip into a rolled-back deploy.
- **The SPA must not claim `/api/*`.** The static host serves any path in the bundle and forwards the rest to the container, so a bundled `/api` path would shadow the API. `web/src/App.tsx` routes only UI paths; its catch-all redirects home rather than rendering a 404, because genuinely unknown paths never reach the SPA.
- **Firebase web config is build-time** (`web/.env.production`, `VITE_FIREBASE_*`). It is public by design — `apiKey` is a quota identifier, not a credential — which is why it can be committed. This is what removed the need for a server-rendered config `<script>`, and with it the last reason the UI needed a server.
- **Dockerfile invariants** (documented at the top of that file, all four load-bearing): port 80, dual-stack `HOST="::"`, no `USER` line, and a `HEALTHCHECK` on `/api/health` with curl installed. Breaking any of them fails the deploy in a way that looks unrelated to the change.

## Useful env vars

| Env | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string; injected by the platform on deploy |
| `MASTER_KEY` | 32 bytes base64 — envelope-encryption key for creds and bot tokens |
| `MASTER_KEY_PREVIOUS` | optional, comma-separated, decrypt-only (rotation) |
| `FIREBASE_PROJECT_ID` | Firebase project (`auto-trader-493814`) |
| `BT_GATEWAY_COMMIT` | git SHA, passed as a build arg by CI; surfaced by `/api/health` |
| `BT_CLIENT_DEBUG=1` | verbose bt-trade logs to stdout |
| `BT_GATEWAY_PUBLIC_URL` | canonical public origin; used for OAuth metadata + the Telegram webhook URL. Set it in prod rather than trusting proxy headers |
| `ALLOW_UNVERIFIED_EMAIL=1` | only for local debugging; never set in prod |

## Where to look first

- New API endpoint → copy `server/routes/api.v1.orders.ts`, then add the path to `server/registry.ts` by hand (that table is no longer generated).
- New UI-backed endpoint → copy `server/routes/api.ui.keys.ts` (auth via `requireFirebaseUser`).
- New UI page → add a route in `web/src/App.tsx`; components live in `web/src/components/`.
- New persisted data type → add the `Doc` interface + typed accessors in `lib/store.ts`, and the table in the `SCHEMA` constant in `lib/db.ts`; never access tables ad-hoc.
- Reading production logs → `/check-logs`.
- Docs: `docs/telegram.md` (per-user bot setup), `docs/ios-shortcuts.md` (client examples).
- The one-shot GCP export lives in `scripts/migrate-to-postgres.mjs`; it is historical and should not need running again.
