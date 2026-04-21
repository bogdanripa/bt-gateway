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

  let currencyId: string;
  try {
    const profile = await client.profile.get();
    currencyId = profile.selectedPortfolioPanelCurrencyID;
  } catch (e) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', `BT getProfile failed: ${(e as Error).message}`);
  }

  let cash: unknown;
  let holdings: unknown;
  try {
    [cash, holdings] = await Promise.all([
      client.portfolio.getCash({ portfolioKey, currencyId }),
      client.portfolio.getHoldings({ portfolioKey }),
    ]);
  } catch (e) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', `BT fetch failed: ${(e as Error).message}`);
  }

  return ok({ mode, cash, holdings });
});
