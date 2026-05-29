---
name: check-logs
description: Read bt-gateway's Cloud Run logs the same way every time, from anywhere — laptop, routine, or Claude Code on phone. Calls the Cloud Logging REST API via a bundled Node reader (no gcloud binary needed), with the fixed project/service and the structured-log schema this service emits (route.access, route.error, audit.*, cron.*, signin/refresh, bt client). Invoke with `/check-logs` plus optional args: a time window (`1h`, `30m`, `7d`), a focus (`errors`, `auth`, `cron`, `access`), a `requestId`, a `path` (`/api/v1/cash`), or a free-text grep term.
---

# Check logs

You are reading the **bt-gateway** Cloud Run service's logs. The whole point of this skill is determinism: same project, same service, same filter schema, same output shape — no matter where it runs (laptop, scheduled routine, Claude Code on phone). Do not improvise; build the filter from the fixed pieces below and run it through the bundled Node reader.

## How it reads (one path everywhere)

All reads go through `.claude/skills/check-logs/read-logs.mjs`, a Node script that calls the Cloud Logging REST API using `google-auth-library` (a transitive dep already in `node_modules`). There is **no dependency on the `gcloud` binary**, so it works in headless containers that only have Node + the checked-out repo. Authentication is Application Default Credentials:

- **Laptop** → your ADC from `gcloud auth application-default login`.
- **Routine / Claude on phone** → set `GOOGLE_APPLICATION_CREDENTIALS` to a key for the `bt-gateway-runtime` service account, which holds `roles/logging.viewer` (granted in `infra/provision-m1.sh`).

## Fixed constants (baked into read-logs.mjs — do not re-parametrize)

```
PROJECT=auto-trader-493814
SERVICE=bt-gateway
RESOURCE_FILTER='resource.type="cloud_run_revision" AND resource.labels.service_name="bt-gateway"'
```

The reader always prepends `RESOURCE_FILTER` and a `timestamp>=` bound from `--freshness`. You only ever pass the *extra* filter clause via `--filter`.

## Preflight

1. Make sure deps are present (they usually are):
   ```bash
   node -e "require.resolve('google-auth-library')" 2>/dev/null || npm install
   ```
2. If a read fails with "no access token" / a 401/403 from the Logging API, ADC isn't configured for this environment. Tell the user exactly which fix applies:
   - laptop → `gcloud auth application-default login`
   - routine / phone → set `GOOGLE_APPLICATION_CREDENTIALS` to the runtime-SA key in the environment's secrets/env settings.
   Do not fail silently and do not try to switch credentials yourself.

## The structured-log schema this service emits

All app logs are single-line JSON on stdout/stderr, parsed by Cloud Logging into `jsonPayload`. Known `jsonPayload.msg` values and their useful fields:

| `msg` | severity | key fields |
|---|---|---|
| `route.access` | INFO / ERROR (≥500) | `requestId`, `path`, `method`, `status`, `code`, `latencyMs` |
| `route.error` | WARNING (4xx) / ERROR (5xx) | `requestId`, `path`, `method`, `code`, `message`, `context`, `stack` |
| `audit.<type>` | INFO / WARNING (err) | e.g. `audit.signin.success`, `audit.signin.failure`, `audit.refresh.success`, `audit.order.placed` — carries the audit payload |
| `audit.firestore_write_failed` | ERROR | the audit doc that failed to persist |
| `cron.refresh.summary` | INFO | cron sweep result counts |
| BT client lines | INFO | from `BTTradeClient` (session/restore/login/refresh) |

Correlate any request end-to-end by its `requestId` (also returned to clients in the `x-request-id` header).

**Never print secrets.** These logs are scrubbed by design, but if any decrypted credential, BT token, OTP, API key beyond its 12-char prefix, or Telegram bot token ever appears in a payload, redact it in your output and flag it to the user as a leak to fix.

## Parse the arguments

`$ARGUMENTS` is whitespace-separated and order-independent. Classify each token:

- **Window** — matches `^\d+[mhd]$` (e.g. `30m`, `1h`, `7d`). Maps to `--freshness`. Default `1h` if absent.
- **Focus** — one of: `errors`, `auth`, `cron`, `access`, `audit`, `all`. Default `all`.
- **requestId** — a UUID-ish token, or `req=<id>` / `requestId=<id>`. Adds `jsonPayload.requestId="<id>"`.
- **path** — starts with `/` (e.g. `/api/v1/cash`) or `path=<p>`. Adds `jsonPayload.path="<p>"`.
- **mode** — `demo` or `live`. Adds `jsonPayload.mode="<mode>"` when present (audit/bt lines carry it).
- **limit** — `n=<int>` or `limit=<int>`. Default `50`.
- Anything else → treat as a free-text term and AND a `jsonPayload.msg:"<term>"` substring match (Cloud Logging `:` is "has substring"). If it's clearly a message fragment rather than an `msg`, use `jsonPayload.message:"<term>"` instead — pick whichever fits, or OR both.

If the args are ambiguous, state how you interpreted them in one line before running, then proceed (don't stop to ask unless truly stuck).

## Focus → filter clause

AND exactly one of these onto `RESOURCE_FILTER` based on the focus:

- `errors` → `severity>=ERROR` (catches `status>=500` access logs, 5xx `route.error`, failed audit writes).
- `auth` → `(jsonPayload.msg:"signin" OR jsonPayload.msg:"refresh" OR jsonPayload.msg:"audit.signin" OR jsonPayload.msg:"audit.refresh")`
- `cron` → `jsonPayload.msg:"cron"`
- `access` → `jsonPayload.msg="route.access"`
- `audit` → `jsonPayload.msg:"audit."`
- `all` → no extra clause.

## Run it

Always invoke the bundled reader from the repo root. Pass the focus/extra clause via `--filter`, the window via `--freshness`, and the count via `--limit`:

```bash
node .claude/skills/check-logs/read-logs.mjs \
  --filter '<EXTRA_CLAUSE>' \
  --freshness <WINDOW> \
  --limit <LIMIT>
```

- `<EXTRA_CLAUSE>` is the focus clause from the table above (omit `--filter` entirely for focus `all`). `<WINDOW>` defaults to `1h`, `<LIMIT>` to `50`. Results come newest-first (`--order desc`, the default).
- When the user gave a specific `requestId` or is drilling into one error, add `--json` so `message`, `context`, and `stack` are printed in full — the default table hides them.
- The reader only supports relative windows (`--freshness 30m/6h/7d`). For an absolute range ("between 17:00 and 17:05 yesterday"), pick a `--freshness` wide enough to cover it and visually narrow in the output, or add an explicit `timestamp<="..."` upper bound to `--filter` in RFC3339 UTC.

Example — recent 5xx in the last 6h:

```bash
node .claude/skills/check-logs/read-logs.mjs --filter 'severity>=ERROR' --freshness 6h --limit 50
```

## Summarize, don't dump

After the read:
1. Print the command's table output (it's already compact).
2. Add a 2–4 line read of what it shows: error clusters, repeated `code`s, latency spikes, a session that went `signin.failure` → no recovery, cron failures, etc.
3. If you spot a `requestId` worth drilling into, offer to re-run focused on it (`/check-logs req=<id> 24h`).

Keep it tight. The user wants the signal, not a JSON wall.

## Common one-liners (for reference)

- Recent 5xx: `/check-logs errors 6h`
- Overnight session trouble: `/check-logs auth 12h`
- Did the 45-min cron run + did it fail: `/check-logs cron 3h`
- One request end-to-end: `/check-logs req=<uuid> 24h`
- Latency on cash endpoint: `/check-logs /api/v1/cash 6h`
