/**
 * Session-internal helpers: error classification, bt-trade auto-refresh
 * timer control, and per-refresh summary logging.
 *
 * Kept distinct from `client-pool.ts` (which manages the client lifecycle)
 * because these concerns don't share state — they operate on any
 * BTTradeClient instance, pool-owned or throwaway.
 */

import { AuthError, type BTTradeClient } from '@bogdanripa/bt-trade';
import type { BtMode } from '../store';

/**
 * Detect an upstream BLOCK rather than an auth outcome: BT's edge (WAF)
 * answering with an HTML deny page instead of the JSON the API contract
 * promises.
 *
 * This matters because bt-trade cannot tell the two apart. It POSTs to
 * /api/RefreshToken, gets `<!DOCTYPE html>… Acces blocat / Access denied …`
 * back, fails to parse it, and raises `AuthError` — the exact same type it
 * raises for a genuinely dead session. Treating that as expiry is what
 * turned a transient IP block into 35 full logins in 25 seconds against a
 * bank's auth endpoint: every request deleted the (still perfectly valid)
 * session snapshot and re-authenticated, which is the behaviour most likely
 * to extend the block and flag the account.
 *
 * Matched on the response body because that is all we get — the HTML never
 * carries a machine-readable code, and bt-trade does not surface the HTTP
 * status. Any HTML body from a JSON endpoint is by definition not a valid
 * auth answer, so the doctype/tag check is the load-bearing one; the phrase
 * list only sharpens the log message.
 */
export function isUpstreamBlocked(e: unknown): boolean {
  if (!e) return false;
  const msg = (e as Error).message ?? '';
  if (!msg) return false;
  return /<!DOCTYPE html|<html|Acces blocat|Access denied|Reference ID:|Forbidden|<title>/i.test(msg);
}

/**
 * Detect the "session is toast" family of errors bt-trade raises when it
 * can't auto-refresh past a 401: AuthError thrown from the transport's
 * refresh-and-retry path, or specific message substrings from auth.js.
 *
 * An upstream block is explicitly NOT session expiry, even though it also
 * arrives as an AuthError. Callers use this to decide whether to destroy
 * the persisted snapshot and re-login; doing that because a firewall said
 * no loses a working session and amplifies the outage.
 */
export function isSessionExpired(e: unknown): boolean {
  if (!e) return false;
  if (isUpstreamBlocked(e)) return false;
  if (e instanceof AuthError) return true;
  const msg = (e as Error).message ?? '';
  if (!msg) return false;
  return /Session refresh failed|Refresh token has expired|NOT_LOGGED_IN|Cannot refresh/i.test(msg);
}

/**
 * Last 8 chars of a refresh_token — enough to correlate "RT issued at T1"
 * with "RT sent at T2" across log lines without leaking the full token.
 * Returns null for missing/short values.
 */
function rtTail(rt: string | null | undefined): string | null {
  if (typeof rt !== 'string' || rt.length < 8) return null;
  return rt.slice(-8);
}

export interface RefreshContext {
  uid: string;
  mode: BtMode;
  /** Where the refresh originated from — for filtering / triage. */
  source: 'pool' | 'cron';
}

/**
 * Instrument a BTTradeClient's `auth.refresh` for our two concerns:
 *
 *   1. Neutralize bt-trade's internal access-token auto-refresh timer.
 *      bt-trade schedules a setTimeout on every successful login/restore/
 *      refresh; we have our own cron + transport 401-retry to keep things
 *      fresh, so the third driver is just race surface (zombie clients
 *      firing with stale RTs after the cron has rotated them in Firestore).
 *
 *      The wrapper covers ALL three scheduling sites:
 *        - login()  — wrapped here so its post-login schedule is killed.
 *        - restore() — wrapped here so its post-restore schedule is killed.
 *        - refresh() — wrapped here so its post-refresh schedule is killed,
 *          AND the call surface is what emits the summary breadcrumbs.
 *
 *   2. Emit always-on summary breadcrumbs (RT tail, expiries, rotation)
 *      for every refresh — pool-driven (user calls / explicit refresh
 *      route) AND cron-driven. Only the last 8 chars of any RT make it
 *      to logs, so no plaintext leakage.
 *
 * `BT_REFRESH_DEBUG=1` continues to add the heavy `bt.refresh.request` /
 * `bt.refresh.response` lines (with full bodies) on the cron path only —
 * see lib/bt/refresh.ts.
 */
export function instrumentRefresh(client: BTTradeClient, ctx: RefreshContext): void {
  const auth = client.auth;

  const clearTimer = () => {
    if (auth._refreshTimer) {
      clearTimeout(auth._refreshTimer);
      auth._refreshTimer = null;
    }
  };

  clearTimer();

  // Wrap login + restore so the timer scheduled by their internal
  // #scheduleAutoRefresh() is cleared as soon as control returns to us.
  // Without these, the very first timer set at login/restore time survives
  // and fires ~60 minutes later — by which point the cron may have rotated
  // the RT in Firestore, leaving the in-memory snapshot stale and the
  // pool-driven refresh sending an already-consumed RT.
  const originalLogin = client.login.bind(client);
  client.login = async function (args) {
    try {
      return await originalLogin(args);
    } finally {
      clearTimer();
    }
  };

  const originalRestore = client.restore.bind(client);
  client.restore = function (snap) {
    try {
      return originalRestore(snap);
    } finally {
      clearTimer();
    }
  };

  const original = auth.refresh.bind(auth);

  auth.refresh = async function () {
    const before = client.toSnapshot();
    console.log(JSON.stringify({
      severity: 'INFO',
      msg: 'bt.refresh.summary.attempt',
      uid: ctx.uid,
      mode: ctx.mode,
      source: ctx.source,
      rtSentTail: rtTail(before?.refreshToken),
      rtSentExpiresAt: before?.refreshTokenExpires ?? null,
    }));

    try {
      await original();
    } catch (e) {
      console.warn(JSON.stringify({
        severity: 'WARNING',
        msg: 'bt.refresh.summary.result',
        uid: ctx.uid,
        mode: ctx.mode,
        source: ctx.source,
        status: 'err',
        rtSentTail: rtTail(before?.refreshToken),
        errMessage: (e as Error)?.message ?? String(e),
      }));
      throw e;
    } finally {
      clearTimer();
    }

    const after = client.toSnapshot();
    console.log(JSON.stringify({
      severity: 'INFO',
      msg: 'bt.refresh.summary.result',
      uid: ctx.uid,
      mode: ctx.mode,
      source: ctx.source,
      status: 'ok',
      rtSentTail: rtTail(before?.refreshToken),
      rtReceivedTail: rtTail(after?.refreshToken),
      rtRotated: !!after?.refreshToken && after.refreshToken !== before?.refreshToken,
      rtReceivedExpiresAt: after?.refreshTokenExpires ?? null,
      accessTokenExpiresAt: after?.expiresAt ? new Date(after.expiresAt).toISOString() : null,
    }));
  };
}

