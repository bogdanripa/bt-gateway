/**
 * GET /api/v1/cash
 *
 * Returns the available cash on the tenant's default portfolio, in the
 * portfolio's default evaluation currency. For multi-currency accounts the
 * response echoes the currencyId so clients can disambiguate.
 *
 * Read-only — does NOT emit an audit event. Cloud Logging captures the
 * access log automatically via `withRoute`.
 */

import { requireApiKey } from '@/lib/auth/api-key';
import { getBtClient } from '@/lib/bt/client-pool';
import { getPortfolioKey } from '@/lib/bt/portfolio-key';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const client = await getBtClient(caller.tenant, caller.mode);
  const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);

  // getCash requires the evaluation currencyId — the currency shown in
  // the BT Trade web UI's portfolio panel. Pull it from the user profile.
  let currencyId: string;
  try {
    const profile = await client.profile.get();
    currencyId = profile.selectedPortfolioPanelCurrencyID;
  } catch (e) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', `BT getProfile failed: ${(e as Error).message}`, {
      context: { uid: caller.tenant.uid, mode: caller.mode },
    });
  }

  let cash: unknown;
  try {
    cash = await client.portfolio.getCash({ portfolioKey, currencyId });
  } catch (e) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', `BT getCash failed: ${(e as Error).message}`, {
      context: { uid: caller.tenant.uid, mode: caller.mode },
    });
  }

  return ok({ mode: caller.mode, portfolioKey, cash });
});
