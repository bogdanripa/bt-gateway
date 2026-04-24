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

import 'server-only';
import {
  BTTradeClient,
  AuthError,
  ntfyOtpProvider,
  defaultNtfyTopic,
  type SessionSnapshot,
} from '@bogdanripa/bt-trade';
import { ApiError } from '../errors';
import { decrypt } from '../kms';
import { audit } from '../events';
import { notifyTenant } from '../telegram';
import {
  getBtCreds,
  getBtSession,
  setBtSession,
  deleteBtSession,
  type BtMode,
  type TenantRef,
} from '../firestore';

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

async function buildClient(t: TenantRef, mode: BtMode): Promise<PoolEntry> {
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

  // Kill bt-trade's internal auto-refresh timer before any login/restore
  // runs. Our cron + transport 401-retry cover both token types; an
  // internal third driver was racing both (see git history for the
  // zombie-refresh invalid_grant cascade).
  disableAutoRefresh(client);

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

  // Full login — blocks until the phone posts an OTP to ntfy (up to 5 min).
  try {
    await client.login({ username, password });
  } catch (e) {
    // Audit + Telegram. sign-in errors are the one case we always alert on.
    const msg = (e as Error).message || 'login failed';
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
  }

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
 * Get (or lazily construct) the BTTradeClient for this tenant + mode.
 * Callers MUST NOT cache the returned client across requests — it may be
 * evicted from the pool at any time (e.g., on session expiry).
 */
export async function getBtClient(t: TenantRef, mode: BtMode): Promise<BTTradeClient> {
  const k = key(t, mode);
  const hit = pool.get(k);
  if (hit) return hit.client;

  const pending = inflight.get(k);
  if (pending) return (await pending).client;

  const p = buildClient(t, mode)
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

/**
 * Detect the "session is toast" family of errors bt-trade raises when it
 * can't auto-refresh past a 401: AuthError thrown from the transport's
 * refresh-and-retry path, or specific message substrings from auth.js.
 */
export function isSessionExpired(e: unknown): boolean {
  if (!e) return false;
  if (e instanceof AuthError) return true;
  const msg = (e as Error).message ?? '';
  if (!msg) return false;
  return /Session refresh failed|Refresh token has expired|NOT_LOGGED_IN|Cannot refresh/i.test(msg);
}

/**
 * Run `op` against this tenant's BT client, transparently retrying ONCE
 * with a freshly-built client if the first attempt fails because the
 * session died (bt-trade's refresh-after-401 gave up).
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
): Promise<T> {
  const client = await getBtClient(tenant, mode);
  try {
    return await op(client);
  } catch (e) {
    if (!isSessionExpired(e)) throw e;
    // onExpired may already have evicted the pool entry; call again to be
    // sure, then rebuild. The rebuild will restore from snapshot if it's
    // still valid (skipping OTP), otherwise prompt for a fresh login.
    evictBtClient(tenant, mode);
    const fresh = await getBtClient(tenant, mode);
    return op(fresh);
  }
}

/**
 * Neuter bt-trade's internal access-token auto-refresh timer on this client.
 *
 * Why: bt-trade schedules an internal `setTimeout` auto-refresh on every
 * successful login/restore/refresh. On throwaway clients (e.g. the cron's)
 * that timer keeps the client alive past its intended lifetime and later
 * fires using the refresh_token the client had in memory at that time —
 * which by then may have been rotated (and consumed) by a parallel refresh.
 * BT returns `invalid_grant` and we spiral into full-login OTP prompts.
 *
 * The transport's 401-retry-with-refresh already keeps access tokens fresh
 * on user traffic, and our cron keeps the refresh token itself alive. A
 * third refresh driver is just extra race surface.
 *
 * Clears any currently-scheduled timer and wraps `auth.refresh()` so
 * future refreshes (from 401-retry or explicit refresh) don't leave a
 * new timer behind either. Single-underscore `_refreshTimer` is exposed
 * (not `#`-private in bt-trade 0.3.1).
 */
export function disableAutoRefresh(client: BTTradeClient): void {
  type AuthShape = {
    _refreshTimer: ReturnType<typeof setTimeout> | null;
    refresh(): Promise<void>;
  };
  const auth = (client as unknown as { auth: AuthShape }).auth;

  const clearTimer = () => {
    if (auth._refreshTimer) {
      clearTimeout(auth._refreshTimer);
      auth._refreshTimer = null;
    }
  };

  clearTimer();
  const original = auth.refresh.bind(auth);
  auth.refresh = async function () {
    try {
      await original();
    } finally {
      clearTimer();
    }
  };
}

/** Test hook. */
export function _resetBtClientPool(): void {
  pool.clear();
  inflight.clear();
}
