/**
 * Session-internal helpers: error classification and bt-trade auto-refresh
 * timer control.
 *
 * Kept distinct from `client-pool.ts` (which manages the client lifecycle)
 * because these two concerns don't share state — they operate on any
 * BTTradeClient instance, pool-owned or throwaway.
 */

import 'server-only';
import { AuthError, type BTTradeClient } from '@bogdanripa/bt-trade';

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
 * Clears any currently-scheduled timer and wraps `auth.refresh()` so future
 * refreshes (from 401-retry or explicit refresh) don't leave a new timer
 * behind either.
 */
export function disableAutoRefresh(client: BTTradeClient): void {
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
    try {
      await original();
    } finally {
      clearTimer();
    }
  };
}
