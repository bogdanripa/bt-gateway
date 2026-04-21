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
import { getBtClient } from '@/lib/bt/client-pool';
import { getPortfolioKey } from '@/lib/bt/portfolio-key';
import { getEvaluationCurrencyId } from '@/lib/bt/currency';
import { ApiError } from '@/lib/errors';
import { ok, withRoute } from '@/lib/route-handler';
import type { BtMode } from '@/lib/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);

  const rawMode = new URL(req.url).searchParams.get('mode') ?? 'demo';
  if (rawMode !== 'demo' && rawMode !== 'live') {
    throw new ApiError('BAD_REQUEST', 'mode must be demo or live');
  }
  const mode = rawMode as BtMode;

  const client = await getBtClient(caller.tenant, mode);
  const portfolioKey = await getPortfolioKey(caller.tenant, mode, client);
  const currencyId = await getEvaluationCurrencyId(caller.tenant, mode, client);

  // Fetch cash and holdings independently so a cash failure doesn't also
  // hide the positions (and vice versa). The UI will render whatever came
  // back and show per-section errors for the rest.
  const [cashResult, holdingsResult] = await Promise.allSettled([
    client.portfolio.getCash({ portfolioKey, currencyId }),
    client.portfolio.getHoldings({ portfolioKey }),
  ]);

  const cash = cashResult.status === 'fulfilled' ? cashResult.value : null;
  const cashError = cashResult.status === 'rejected' ? (cashResult.reason as Error).message : null;
  const holdings = holdingsResult.status === 'fulfilled' ? holdingsResult.value : null;
  const holdingsError = holdingsResult.status === 'rejected' ? (holdingsResult.reason as Error).message : null;

  if (!cash && !holdings) {
    throw new ApiError(
      'UPSTREAM_UNAVAILABLE',
      `BT fetch failed: cash=${cashError}; holdings=${holdingsError}`,
    );
  }

  return ok({ mode, currencyId, cash, cashError, holdings, holdingsError });
});
