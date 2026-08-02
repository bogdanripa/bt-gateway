---
name: check-logs
description: Read bt-gateway's container logs the same way every time, from anywhere — laptop, routine, or Claude Code on phone. Reads the app's Docker logs off the Pi via the Pironman apps_logs tool, with the structured-log schema this service emits (route.access, route.error, audit.*, cron.*, signin/refresh, bt client). Invoke with `/check-logs` plus optional args: a focus (`errors`, `auth`, `cron`, `access`), a `requestId`, a `path` (`/api/v1/cash`), a tail size (`n=200`), or a free-text grep term.
---

# Check logs

You are reading the **bt-gateway** container's logs. The service runs on the Pi at `https://bt-gateway-coolify.bogdanripa.com`; its logs are the container's stdout/stderr, read straight from the Docker daemon.

The point of this skill is determinism: same app, same schema, same output shape — no matter where it runs (laptop, scheduled routine, Claude Code on phone). Do not improvise a different way to reach the box.

## How it reads (one path everywhere)

Call the **`apps_logs`** MCP tool (Pironman server) with `app_id: "bt-gateway"` and a `tail` count:

```
apps_logs(app_id="bt-gateway", tail=200)
```

That returns the container's state, health, and its last `tail` lines. There is no server-side filtering and no time-window parameter — **you filter the returned lines yourself**. So: pull a generous tail, then narrow in your own reading.

If the tool is unavailable in this environment, say so plainly rather than reaching for `gcloud`, `docker`, or SSH. This service no longer runs on GCP and there is no Cloud Logging to fall back to.

## Fixed constants

```
APP_ID = bt-gateway
URL    = https://bt-gateway-coolify.bogdanripa.com
```

## Container state is part of the answer

`apps_logs` returns status and health alongside the lines. Always read it first:

- `status: "no container"` → the deploy failed or was rolled back. That is the finding; report it and check the most recent GitHub Actions run.
- unhealthy / restarting → look for a startup crash near the top of the tail: a missing `DATABASE_URL` or `MASTER_KEY`, an `EACCES` on port 80 (something reintroduced a `USER` line in the Dockerfile), or an IPv4-only bind failing the healthcheck.

A healthy container with no recent lines usually just means no traffic.

## The structured-log schema this service emits

All app logs are single-line JSON on stdout/stderr. Known `msg` values and their useful fields:

| `msg` | severity | key fields |
|---|---|---|
| `route.access` | INFO / ERROR (≥500) | `requestId`, `path`, `method`, `status`, `code`, `latencyMs` |
| `route.error` | WARNING (4xx) / ERROR (5xx) | `requestId`, `path`, `method`, `code`, `message`, `context`, `stack` |
| `audit.<type>` | INFO / WARNING (err) | e.g. `audit.signin.success`, `audit.signin.failure`, `audit.refresh.success`, `audit.order.placed` — carries the audit payload |
| `cron.refresh.summary` | INFO | cron sweep result counts |
| `db.schema.ready` | INFO | emitted once per process after the schema is applied — a useful "this container just started" marker |
| `db.pool.error` | ERROR | a pooled Postgres connection died in the background |
| BT client lines | INFO | from `BTTradeClient` (session/restore/login/refresh) |

Correlate any request end-to-end by its `requestId` (also returned to clients in the `x-request-id` header).

Lines are **not** guaranteed to be JSON — the Next.js server and any library can write plain text. Parse leniently: try JSON per line, fall back to treating it as raw text.

**Never print secrets.** These logs are scrubbed by design, but if any decrypted credential, BT token, OTP, API key beyond its 12-char prefix, Telegram bot token, `MASTER_KEY`, or `DATABASE_URL` password ever appears in a payload, redact it in your output and flag it to the user as a leak to fix.

## Parse the arguments

`$ARGUMENTS` is whitespace-separated and order-independent. Classify each token:

- **Focus** — one of: `errors`, `auth`, `cron`, `access`, `audit`, `db`, `all`. Default `all`.
- **requestId** — a UUID-ish token, or `req=<id>` / `requestId=<id>`. Keep only lines whose `requestId` matches.
- **path** — starts with `/` (e.g. `/api/v1/cash`) or `path=<p>`. Keep only lines whose `path` matches.
- **mode** — `demo` or `live`. Keep only lines carrying that `mode` (audit and BT lines have it).
- **tail** — `n=<int>` or `limit=<int>`. Default `200`. Raise it for a wide sweep; the whole window you can see is bounded by this number.
- **Window** — a token like `30m` / `6h` / `7d`. There is no server-side time filter, so treat it as a hint: pull a larger tail and drop lines outside the window when they carry a timestamp. Say in one line that the window was applied client-side.
- Anything else → a free-text term; keep lines containing it.

If the args are ambiguous, state how you interpreted them in one line before running, then proceed (don't stop to ask unless truly stuck).

## Focus → which lines to keep

- `errors` → `severity` of `ERROR`, or `route.access` with `status >= 500`, or any `route.error`.
- `auth` → `msg` containing `signin` or `refresh`.
- `cron` → `msg` containing `cron`.
- `access` → `msg == "route.access"`.
- `audit` → `msg` starting with `audit.`.
- `db` → `msg` starting with `db.`.
- `all` → everything.

## Summarize, don't dump

After the read:
1. Print a compact table of the matching lines — timestamp, `msg`, `path`/`status`, `latencyMs`, `code`. Not the raw JSON.
2. Add a 2–4 line read of what it shows: error clusters, repeated `code`s, latency spikes, a session that went `signin.failure` → no recovery, cron failures, a container that restarted mid-window.
3. When drilling into one `requestId` or one error, print that line's `message`, `context` and `stack` in full — that is the case where detail is the point.
4. If you spot a `requestId` worth drilling into, offer to re-run focused on it (`/check-logs req=<id> n=500`).

Keep it tight. The user wants the signal, not a JSON wall.

## Common one-liners (for reference)

- Recent 5xx: `/check-logs errors`
- Overnight session trouble: `/check-logs auth n=1000`
- Did the 45-min cron run + did it fail: `/check-logs cron n=500`
- One request end-to-end: `/check-logs req=<uuid> n=1000`
- Latency on cash endpoint: `/check-logs /api/v1/cash`
- Did the container just restart: `/check-logs db`
