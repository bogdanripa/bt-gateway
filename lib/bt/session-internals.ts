/**
 * Session-internal helpers: error classification, bt-trade auto-refresh
 * timer control, and per-refresh summary logging.
 *
 * Kept distinct from `client-pool.ts` (which manages the client lifecycle)
 * because these concerns don't share state — they operate on any
 * BTTradeClient instance, pool-owned or throwaway.
 */

import 'server-only';
import { AuthError, type BTTradeClient } from '@bogdanripa/bt-trade';
import type { BtMode } from '../firestore';

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
 *      firing with stale RTs).
 *   2. Emit always-on summary breadcrumbs (RT tail, expiries, rotation)
 *      for every refresh — pool-driven (user calls / explicit refresh
 *      route) AND cron-driven. Only the last 8 chars of any RT make it
 *      to logs, so no plaintext leakage.
 *
 * Single helper because both concerns hook the same `auth.refresh` wrapper.
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

