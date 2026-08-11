/**
 * Per-tenant, per-mode BT Trade client pool.
 *
 * We keep one `BTTradeClient` in memory per (uid, mode) on the always-warm
 * Cloud Run instance so the refresh token's 30-minute window actually gets
 * used — otherwise every request would cold-restore from Firestore and burn
 * refresh cycles unnecessarily.
 *
 * Lifecycle per (uid, mode):
 *   1. First call → load BtSessionDoc from Firestore + restore into a new client.
 *      If no session exists → load BtCredsDoc, decrypt, run full login().
 *      If no creds exist → throw UPSTREAM_UNAVAILABLE "credentials not set".
 *   2. The client's `onSessionChange` hook persists every snapshot rotation
 *      back to Firestore. Nothing in the route handlers has to remember to
 *      save state.
 *   3. On `signin.*` and `refresh.failure` the auditor + Telegram notifier
 *      fire. Refresh successes are noisy — they fire every 30 minutes — so
 *      they get audit-logged but NOT Telegrammed. This matches the user's
 *      rule: "don't message me every 45 minutes."
 *
 * OTP: the pool uses `ntfyOtpProvider` with a per-username deterministic
 * topic. Users install the iOS/Android SMS-forwarding shortcut pointed at
 * that topic. During login, the client blocks waiting on SMS for up to 5
 * minutes. If no SMS arrives the login throws and we surface a 502.
 *
 * Concurrency: two concurrent requests for the same (uid, mode) must share
 * one client instance. We guard initialization with a per-key in-flight
 * promise map so only the first caller triggers the Firestore + KMS reads,
 * and the rest await the same result.
 */

import {
  BTTradeClient,
  ntfyOtpProvider,
  defaultNtfyTopic,
  type SessionSnapshot,
} from '@bogdanripa/bt-trade';
import { instrumentRefresh, isSessionExpired, isUpstreamBlocked } from './session-internals';
import { ApiError } from '../errors';
import { decrypt } from '../secret-box';
import { audit } from '../events';
import { notifyTenant } from '../telegram';
import {
  getBtCreds,
  getBtSession,
  setBtSession,
  deleteBtSession,
  type BtMode,
  type TenantRef,
} from '../store';

/**
 * Per-TENANT sign-in mutex (keyed by uid, not uid:mode).
 *
 * At most one BT `login()` may be in flight per person, because BT sends the
 * 2FA code by SMS to one phone: two concurrent logins produce two codes that
 * invalidate each other, so both fail. The key is the uid so demo and live
 * serialise against each other too.
 *
 * A second caller WAITS for the in-flight login and then proceeds, rather
 * than being turned away with "retry shortly". Failing fast made the caller's
 * own retry the thing that re-entered this path, which is how one expired
 * token turned into a burst of authentication attempts.
 *
 * The map holds a promise that resolves when the current holder releases.
 * Race-free on a single-threaded runtime: the `while` re-check and the
 * `set` that follows it run in one synchronous stretch with no `await`
 * between them, so exactly one waiter can claim the slot per turn.
 *
 * Process-local because the platform runs exactly one container — it scales
 * to zero when idle, but never to two. Horizontal scaling would need this
 * moved into Postgres.
 */
/**
 * How this service identifies itself to BT.
 *
 * bt-trade defaults to `bt-trade/<version>`; we override so the traffic is
 * attributable to THIS deployment, commit included. Node's own default is
 * `user-agent: node`, which on a bank's auth endpoint reads as an
 * unidentified bot — precisely the wrong signal for someone automating their
 * own account. Requires @bogdanripa/bt-trade >= 0.3.2, which is now the
 * declared dependency.
 *
 * Deliberately NOT a browser User-Agent. See the note in bt-trade's
 * transport.js: claiming to be Chrome from a Node client is both dishonest
 * and counterproductive.
 */
const USER_AGENT = `bt-gateway/${(process.env.BT_GATEWAY_COMMIT ?? 'dev').slice(0, 7)} (+https://bt-gateway-coolify.bogdanripa.com)`;

const loginLock = new Map<string, Promise<void>>();

/**
 * How long a queued caller will wait for someone else's login before giving
 * up. `login()` itself blocks up to 5 minutes waiting for an OTP; the normal
 * case observed in production is a few seconds, because the phone shortcut
 * forwards the SMS automatically. This bound exists so a login nobody ever
 * completes cannot pin every subsequent request behind it.
 */
const LOGIN_WAIT_MAX_MS = 2 * 60 * 1000;

async function acquireLoginSlot(t: TenantRef, mode: BtMode): Promise<() => void> {
  const deadline = Date.now() + LOGIN_WAIT_MAX_MS;
  while (loginLock.has(t.uid)) {
    if (Date.now() >= deadline) throw sessionExpiredError(t, mode, 'login-in-progress');
    const holder = loginLock.get(t.uid);
    if (!holder) break;
    // The holder's failure is not ours to rethrow — we only care that its
    // turn is over. A rejected lock promise still means the slot is free.
    await Promise.race([
      holder.catch(() => { /* holder failed; slot is free either way */ }),
      new Promise<void>((r) => setTimeout(r, Math.max(0, deadline - Date.now())).unref?.()),
    ]);
  }
  // No await between the check above and the claim below — see the note on
  // loginLock about why that is what makes this race-free.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = () => {
      loginLock.delete(t.uid);
      resolve();
    };
  });
  loginLock.set(t.uid, held);
  return release;
}

/**
 * Consecutive-failure circuit breaker for full sign-in, keyed by
 * `uid:mode`.
 *
 * `loginInProgress` only ever guarded CONCURRENT logins — it is released in
 * a `finally` the moment login throws, so sequential retries walked straight
 * past it. With a route retrying per request, an upstream outage became one
 * fresh `login()` per inbound call: 35 authentication attempts in 25 seconds
 * against BT's auth endpoint, from a residential IP. The per-key 60 req/min
 * rate limit never fired because the request rate was never the problem.
 *
 * After THRESHOLD consecutive failures, sign-in is refused outright for
 * COOLDOWN_MS. That is deliberately a hard stop and not a backoff: when the
 * far side is refusing us, the correct number of additional credential
 * attempts is zero. One success resets it.
 */
const LOGIN_FAILURE_THRESHOLD = 3;
const LOGIN_COOLDOWN_MS = 5 * 60 * 1000;

interface LoginBreaker {
  count: number;
  /** Epoch ms before which no further login may be attempted. */
  until: number;
  lastError: string;
}

const loginBreaker = new Map<string, LoginBreaker>();

interface PoolEntry {
  client: BTTradeClient;
  /** The username that was used to log in — cached for log context only. */
  username: string;
}

const pool = new Map<string, PoolEntry>();
const inflight = new Map<string, Promise<PoolEntry>>();

function key(t: TenantRef, mode: BtMode): string {
  return `${t.uid}:${mode}`;
}

/**
 * Opaque log sink — routes to stdout only if BT_CLIENT_DEBUG=1 is set.
 * Otherwise we swallow bt-trade's chatter so it doesn't flood Cloud Logging.
 */
function btLog(uid: string, mode: BtMode): (msg: string, data?: unknown) => void {
  if (process.env.BT_CLIENT_DEBUG !== '1') return () => { /* drop */ };
  return (msg, data) => {
    console.log(
      JSON.stringify({ severity: 'DEBUG', msg: `bt.${msg}`, uid, mode, data }),
    );
  };
}

/**
 * Build the canonical "session is dead, only an OTP login can recover it"
 * error. Distinct 503 code (`SESSION_EXPIRED`) so programmatic callers can
 * tell it apart from a real upstream 502 and fall back to cached data /
 * prompt a human to re-auth, instead of blindly retrying.
 */
function sessionExpiredError(t: TenantRef, mode: BtMode, stage: string): ApiError {
  const message =
    stage === 'login-in-progress'
      ? `BT ${mode} sign-in already in progress — retry shortly`
      : `BT ${mode} session expired — sign in to restore live data`;
  return new ApiError('SESSION_EXPIRED', message, { context: { uid: t.uid, mode, stage } });
}

/**
 * Classify an error raised by a BT call into the canonical ApiError.
 *
 * Route handlers that wrap a BT call in their own try/catch must funnel the
 * error through here rather than blanket-wrapping it in UPSTREAM_UNAVAILABLE:
 * a dead session is a 503 `SESSION_EXPIRED` ("re-auth"), not a 502 ("BT is
 * broken"), and a caller can only tell them apart if the code is right.
 *
 * Existing `ApiError`s pass through untouched — they were already classified
 * (e.g. the `login-required` 503 `buildClient` throws on the non-interactive
 * path, or the `no-creds` 502).
 */
export function toBtApiError(
  e: unknown,
  label: string,
  t: TenantRef,
  mode: BtMode,
): ApiError {
  if (e instanceof ApiError) return e;
  if (isSessionExpired(e)) return sessionExpiredError(t, mode, 'refresh-failed');
  return new ApiError('UPSTREAM_UNAVAILABLE', `${label} failed: ${(e as Error).message}`, {
    context: { uid: t.uid, mode, label },
  });
}

/**
 * Collapse a sign-in error into one readable line.
 *
 * BT's edge deny page is ~9 kB of HTML with an inline base64 logo. Logging it
 * raw put 35 copies into the container log (300 kB+ for a two-minute window)
 * and would have pushed the same wall of markup into a Telegram alert. The
 * only parts that matter operationally are that it IS a block, and the
 * Reference ID + Client IP that BT asks you to quote when reporting it.
 */
function summarizeLoginError(e: unknown): string {
  const raw = (e as Error)?.message || 'login failed';
  if (!isUpstreamBlocked(e)) return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
  // The labels and their values are separated by markup — the page renders
  // them as `Reference ID:</b> <code>0.a73bd417…</code>` — so skip over any
  // run of tags and whitespace before the value. Without this the capture
  // starts at `<` and matches nothing, silently dropping the two identifiers
  // this function exists to preserve.
  const skip = String.raw`(?:\s|<[^>]*>)*`;
  const ref = new RegExp(`Reference ID:${skip}([^\\s<]+)`, 'i').exec(raw)?.[1];
  const ip = new RegExp(`Client IP:${skip}([0-9a-fA-F.:]+)`, 'i').exec(raw)?.[1];
  const bits = ['BT edge refused this IP (Access denied / Acces blocat)'];
  if (ip) bits.push(`clientIp=${ip}`);
  if (ref) bits.push(`ref=${ref}`);
  return bits.join(' ');
}

/**
 * Throw if sign-in is currently circuit-broken for this tenant+mode.
 *
 * Reported as UPSTREAM_UNAVAILABLE, not SESSION_EXPIRED: the session is not
 * the problem and a human re-authenticating would not help — the far side is
 * refusing us. A 502 tells the caller to back off; a 503 SESSION_EXPIRED
 * would invite exactly the re-auth attempt we are trying to prevent.
 */
function assertLoginAllowed(t: TenantRef, mode: BtMode): void {
  const b = loginBreaker.get(key(t, mode));
  if (!b || b.count < LOGIN_FAILURE_THRESHOLD) return;
  const remainingMs = b.until - Date.now();
  if (remainingMs <= 0) return;
  const remainingSec = Math.ceil(remainingMs / 1000);
  throw new ApiError(
    'UPSTREAM_UNAVAILABLE',
    `BT ${mode} sign-in suspended after ${b.count} consecutive failures — retry in ${remainingSec}s`,
    {
      context: {
        uid: t.uid,
        mode,
        stage: 'login-circuit-open',
        failures: b.count,
        retryAfterSec: remainingSec,
        lastError: b.lastError,
      },
    },
  );
}

function recordLoginFailure(t: TenantRef, mode: BtMode, message: string): void {
  const k = key(t, mode);
  const prev = loginBreaker.get(k);
  const count = (prev?.count ?? 0) + 1;
  loginBreaker.set(k, {
    count,
    until: Date.now() + LOGIN_COOLDOWN_MS,
    lastError: message,
  });
  if (count === LOGIN_FAILURE_THRESHOLD) {
    console.error(
      JSON.stringify({
        severity: 'ERROR',
        msg: 'bt.login.circuit_open',
        uid: t.uid,
        mode,
        failures: count,
        cooldownSec: LOGIN_COOLDOWN_MS / 1000,
        lastError: message,
      }),
    );
  }
}

function recordLoginSuccess(t: TenantRef, mode: BtMode): void {
  loginBreaker.delete(key(t, mode));
}

/** Test seam — the breaker is process-local and survives across tests. */
export function _resetLoginBreaker(): void {
  loginBreaker.clear();
}

// Exposed for tests only; the breaker is otherwise driven entirely from
// buildClient's login path. Mirrors the `_internals` convention in
// lib/auth/api-key.ts.
export const _internals = {
  acquireLoginSlot,
  assertLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  summarizeLoginError,
  LOGIN_FAILURE_THRESHOLD,
  LOGIN_COOLDOWN_MS,
};

async function buildClient(
  t: TenantRef,
  mode: BtMode,
  interactive: boolean,
): Promise<PoolEntry> {
  const creds = await getBtCreds(t, mode);
  if (!creds) {
    throw new ApiError(
      'UPSTREAM_UNAVAILABLE',
      `No ${mode} credentials set for this account`,
      { context: { uid: t.uid, mode, stage: 'no-creds' } },
    );
  }

  const [username, password] = await Promise.all([
    decrypt(creds.usernameCipher),
    decrypt(creds.passwordCipher),
  ]);

  // `ntfyOtpProvider` derives a deterministic topic from the username. We
  // purposely don't let the user override it in M2 — one less knob. The
  // user's phone shortcut posts SMS bodies to that URL; see README for setup.
  const otpProvider = ntfyOtpProvider({
    topic: defaultNtfyTopic(username),
    timeoutMs: 5 * 60 * 1000,
    log: btLog(t.uid, mode),
  });

  const client = new BTTradeClient({
    demo: mode === 'demo',
    otpProvider,
    log: btLog(t.uid, mode),
    timeoutMs: 30_000,
    userAgent: USER_AGENT,
    onSessionChange: async (snap) => {
      if (!snap) {
        await deleteBtSession(t, mode).catch(() => { /* best-effort */ });
        return;
      }
      try {
        await setBtSession(t, mode, snap);
      } catch (e) {
        console.error(
          JSON.stringify({
            severity: 'WARNING',
            msg: 'bt.session_persist_failed',
            uid: t.uid,
            mode,
            err: (e as Error).message,
          }),
        );
      }
    },
    onExpired: (err) => {
      // Auto-refresh gave up and no stored password allowed relogin. The
      // session is dead; the next call will try to login() again using the
      // encrypted creds — which will trigger a fresh OTP prompt.
      void audit({
        tenant: t,
        type: 'signin.failure',
        actor: 'system',
        mode,
        status: 'err',
        error: { code: 'SESSION_EXPIRED', message: err.message },
      });
      void notifyTenant(
        t,
        `bt-gateway: ${mode} session expired and could not auto-recover. ` +
          `Next API call will prompt for SMS OTP via ntfy.`,
      );
      // Drop from pool so the next call rebuilds.
      pool.delete(key(t, mode));
    },
  });

  // Wrap auth.refresh: kill bt-trade's internal setTimeout-driven refresh
  // (the cron + transport 401-retry are sufficient, the third driver was
  // racing both — see git history for the zombie-refresh invalid_grant
  // cascade) AND emit always-on summary breadcrumbs so we can correlate
  // RT issuance with subsequent attempts. source:'pool' marks these as
  // user-traffic-driven (transport 401-retry, /api/v1/session/refresh).
  instrumentRefresh(client, { uid: t.uid, mode, source: 'pool' });

  // Try to restore a persisted snapshot. If it works, we skip the full
  // login (and the OTP prompt). If the refresh token has already expired
  // server-side, the first request will 401 → transport refresh fails →
  // bt-trade's onExpired fires. The route handler will retry via full login.
  const existing = await getBtSession(t, mode);
  if (existing?.snapshot) {
    try {
      client.restore(existing.snapshot as SessionSnapshot);
      // Log the restore so the user can see session activity in the audit feed.
      // Fire-and-forget — no need to block the request on this write.
      void audit({
        tenant: t,
        type: 'signin.restored',
        actor: 'system',
        mode,
        status: 'ok',
        detail: { username },
      });
      return { client, username };
    } catch (e) {
      // Stale snapshot shape — fall through to full login.
      console.log(
        JSON.stringify({
          severity: 'WARNING',
          msg: 'bt.restore_failed',
          uid: t.uid,
          mode,
          err: (e as Error).message,
        }),
      );
    }
  }

  // Non-interactive callers (e.g. /api/v1/session/refresh, which only rotates
  // a token) must NOT trigger the blocking OTP login. Fail fast so they don't
  // hang on the phone.
  if (!interactive) {
    throw sessionExpiredError(t, mode, 'login-required');
  }

  // Single-login guard: if this tenant already has a sign-in underway (e.g. a
  // demo request triggered login and now a live request lands, or a retry
  // arrives mid-login), fail fast instead of starting a second login. A second
  // login would email the user another OTP, and the two codes collide /
  // invalidate each other. The caller retries and rides the established
  // session once this login completes.
  // Wait for any sign-in already running for this tenant, then take the slot.
  const releaseLogin = await acquireLoginSlot(t, mode);

  // Full login — blocks until the phone posts an OTP to ntfy (up to 5 min).
  try {
    // Breaker checked AFTER acquiring the slot, so a caller that queued behind
    // someone else's login re-evaluates it against that login's outcome
    // instead of a stale reading taken before the wait.
    assertLoginAllowed(t, mode);
    await client.login({ username, password });
  } catch (e) {
    // The breaker's own refusal is already a classified ApiError — it is not
    // a login attempt, so it must not be audited or counted as one.
    if (e instanceof ApiError) throw e;
    // Audit + Telegram. sign-in errors are the one case we always alert on.
    // Summarized, not raw: an edge deny page is kilobytes of HTML.
    const msg = summarizeLoginError(e);
    recordLoginFailure(t, mode, msg);
    await audit({
      tenant: t,
      type: 'signin.failure',
      actor: 'system',
      mode,
      status: 'err',
      error: { code: 'LOGIN_FAILED', message: msg },
    });
    await notifyTenant(
      t,
      `bt-gateway: ${mode} sign-in failed: ${msg}`,
    );
    throw new ApiError('UPSTREAM_UNAVAILABLE', `BT ${mode} sign-in failed: ${msg}`, {
      context: { uid: t.uid, mode, stage: 'login' },
    });
  } finally {
    releaseLogin();
  }

  recordLoginSuccess(t, mode);

  await audit({
    tenant: t,
    type: 'signin.success',
    actor: 'system',
    mode,
    status: 'ok',
    detail: { username },
  });
  await notifyTenant(t, `bt-gateway: ${mode} sign-in OK for ${username}.`);

  return { client, username };
}

/**
 * Options shared by the session entry points.
 *
 * `interactive` (default true) controls what happens when the session is dead
 * and the ONLY way to recover is a full `login()` with its blocking OTP wait:
 *   - true  → run login() (a human is present, e.g. the dashboard).
 *   - false → throw `SESSION_EXPIRED` immediately (programmatic API reads and
 *             the cron — nobody is around to forward an OTP).
 */
export interface SessionOptions {
  interactive?: boolean;
}

/**
 * Get (or lazily construct) the BTTradeClient for this tenant + mode.
 * Callers MUST NOT cache the returned client across requests — it may be
 * evicted from the pool at any time (e.g., on session expiry).
 */
export async function getBtClient(
  t: TenantRef,
  mode: BtMode,
  opts: SessionOptions = {},
): Promise<BTTradeClient> {
  const interactive = opts.interactive ?? true;
  const k = key(t, mode);
  const hit = pool.get(k);
  if (hit) return hit.client;

  const pending = inflight.get(k);
  if (pending) return (await pending).client;

  const p = buildClient(t, mode, interactive)
    .then((entry) => {
      pool.set(k, entry);
      return entry;
    })
    .finally(() => {
      inflight.delete(k);
    });
  inflight.set(k, p);
  return (await p).client;
}

/**
 * Drop a client from the pool — call after logout or when credentials change.
 */
export function evictBtClient(t: TenantRef, mode: BtMode): void {
  pool.delete(key(t, mode));
}

// Re-export for callers that import from client-pool — `isSessionExpired`
// and `instrumentRefresh` live in ./session-internals, but keeping the
// existing import surface means no call-site churn.
export { instrumentRefresh, isSessionExpired } from './session-internals';

/**
 * Run `op` against this tenant's BT client, transparently retrying ONCE
 * with a freshly-built client if the first attempt fails because the
 * session died (bt-trade's refresh-after-401 gave up).
 *
 * ONLY SAFE FOR IDEMPOTENT READS. A mutation (place/cancel order, etc.)
 * that hits 401 after BT has accepted it but before the response lands
 * would get retried and double-submit — BT has no idempotency key. Use
 * `runWithSessionMutating` for mutations; it rebuilds the session up-front
 * (if needed) but does not retry the operation after it starts.
 *
 * The rebuild goes through `getBtClient` → `buildClient` → `login()`, which
 * blocks up to 5 minutes waiting for an OTP to be posted to the tenant's
 * ntfy topic. Callers that can't tolerate that wait should call
 * `getBtClient` directly.
 *
 * Concurrent requests that hit the same expired session all converge on one
 * login attempt via the pool's in-flight promise, so the user only has to
 * post the OTP once even if multiple requests are stuck.
 */
export async function runWithSession<T>(
  tenant: TenantRef,
  mode: BtMode,
  op: (client: BTTradeClient) => Promise<T>,
  opts: SessionOptions = {},
): Promise<T> {
  const interactive = opts.interactive ?? true;
  const client = await getBtClient(tenant, mode, { interactive });
  try {
    return await op(client);
  } catch (e) {
    if (!isSessionExpired(e)) throw e;
    // The op failed because the transport's refresh-after-401 gave up — the
    // persisted snapshot's refresh token is dead. onExpired may already have
    // evicted the pool entry; call again to be sure.
    evictBtClient(tenant, mode);

    // Only destroy the persisted snapshot when this caller can actually
    // replace it. An interactive caller can log in, so dropping the snapshot
    // is what makes the rebuild do a fresh lock-guarded login instead of
    // restoring the same dead session and 401-looping.
    //
    // A NON-interactive caller cannot log in — it fails fast by design. If it
    // deleted the snapshot anyway it would resolve nothing for itself and
    // guarantee that the next interactive caller pays a full OTP login: an
    // SMS plus two password-bearing POSTs to BT's most protected endpoint,
    // since bt-trade's 2-step flow re-sends the password with the OTP. That
    // is the traffic worth being frugal with. Evicting the pool entry is
    // enough to force a fresh restore on the retry below.
    if (interactive) await deleteBtSession(tenant, mode);
    try {
      const fresh = await getBtClient(tenant, mode, { interactive });
      return await op(fresh);
    } catch (e2) {
      // A stale-but-present snapshot restores fine, then the op 401s and the
      // transport's refresh dies — surfacing as an AuthError, not the clean
      // SESSION_EXPIRED that buildClient throws when there's no snapshot.
      // Normalize both to one code on the non-interactive (read) path.
      if (!interactive && isSessionExpired(e2)) {
        throw sessionExpiredError(tenant, mode, 'refresh-failed');
      }
      throw e2;
    }
  }
}

/**
 * Mutation-safe variant of `runWithSession`.
 *
 * If the session is already dead when we go to fetch the client,
 * `buildClient` will rebuild it (triggering the OTP wait as needed).
 * However, once `op` has started we do NOT retry on session expiry — a
 * mid-flight 401 on a POST may represent "BT accepted the order, then the
 * response path lost auth", and retrying would double-submit. BT has no
 * idempotency key, so we bubble the AuthError up as a 502 and let the
 * caller decide whether to retry manually after checking state.
 */
export async function runWithSessionMutating<T>(
  tenant: TenantRef,
  mode: BtMode,
  op: (client: BTTradeClient) => Promise<T>,
  opts: SessionOptions = {},
): Promise<T> {
  const interactive = opts.interactive ?? true;
  const client = await getBtClient(tenant, mode, { interactive });
  return op(client);
}

/** Test hook. */
export function _resetBtClientPool(): void {
  pool.clear();
  inflight.clear();
}
