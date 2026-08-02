/**
 * GET /api/ui/account?mode=demo|live
 *
 * Returns the signed-in user's current cash + holdings for the given mode,
 * fetched live from BT Trade via the client pool. Uses Firebase auth so the
 * web UI can call it without needing an API key.
 *
 * If no BT session exists yet the gateway will attempt a fresh login (OTP
 * via ntfy). That can take up to ~2 minutes — callers should show a spinner
 * and use a long enough timeout.
 */

import { requireFirebaseUser } from '@/lib/auth/session';
import { isSessionExpired, runWithSession } from '@/lib/bt/client-pool';
import { getPortfolioKey } from '@/lib/bt/portfolio-key';
import { getEvaluationCurrencyId } from '@/lib/bt/currency';
import { ApiError } from '@/lib/errors';
import { ok, withRoute } from '@/lib/route-handler';
import type { BtMode } from '@/lib/store';


export const GET = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);

  const rawMode = new URL(req.url).searchParams.get('mode') ?? 'demo';
  if (rawMode !== 'demo' && rawMode !== 'live') {
    throw new ApiError('BAD_REQUEST', 'mode must be demo or live');
  }
  const mode = rawMode as BtMode;

  // Wrap the whole BT interaction in runWithSession so a dead session from a
  // previous request triggers a transparent re-login (blocks on OTP) rather
  // than 502-ing every request until the user manually kicks things.
  const payload = await runWithSession(caller.tenant, mode, async (client) => {
    const portfolioKey = await getPortfolioKey(caller.tenant, mode, client);
    const currencyId = await getEvaluationCurrencyId(caller.tenant, mode, client);

    // Fetch cash and holdings independently so a cash failure doesn't also
    // hide the positions (and vice versa). The UI will render whatever came
    // back and show per-section errors for the rest.
    const [cashResult, holdingsResult] = await Promise.allSettled([
      client.portfolio.getCash({ portfolioKey, currencyId }),
      client.portfolio.getHoldings({ portfolioKey }),
    ]);

    // If every upstream fetch failed due to session expiry, surface the
    // AuthError so runWithSession retries with a fresh login. Mixed failures
    // (e.g. cash errored, holdings succeeded) fall through to per-section
    // errors — the UI can still render what came back.
    const rejected = [cashResult, holdingsResult].filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (rejected.length === 2 && rejected.every((r) => isSessionExpired(r.reason))) {
      throw rejected[0].reason;
    }

    const cash = cashResult.status === 'fulfilled' ? cashResult.value : null;
    const cashError = cashResult.status === 'rejected' ? (cashResult.reason as Error).message : null;
    const holdings = holdingsResult.status === 'fulfilled' ? holdingsResult.value : null;
    const holdingsError = holdingsResult.status === 'rejected' ? (holdingsResult.reason as Error).message : null;

    return { currencyId, cash, cashError, holdings, holdingsError };
  });

  if (!payload.cash && !payload.holdings) {
    throw new ApiError(
      'UPSTREAM_UNAVAILABLE',
      `BT fetch failed: cash=${payload.cashError}; holdings=${payload.holdingsError}`,
    );
  }

  return ok({ mode, ...payload });
});
