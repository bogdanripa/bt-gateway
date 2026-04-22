/**
 * GET /api/v1/holdings
 *
 * Returns current holdings (positions) on the default portfolio. Optional
 * query params:
 *   ?market=BVB            — filter by market (the BT client filters client-side)
 *   ?endDate=YYYY-MM-DD    — holdings as of a specific date
 */

import { requireApiKey } from '@/lib/auth/api-key';
import { getBtClient } from '@/lib/bt/client-pool';
import { getPortfolioKey } from '@/lib/bt/portfolio-key';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import { assertAllowed, filterBtHoldings, filterRecords, readRecordFields } from '@/lib/filters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const client = await getBtClient(caller.tenant, caller.mode);
  const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);

  const market = req.nextUrl.searchParams.get('market') ?? undefined;
  const endDate = req.nextUrl.searchParams.get('endDate') ?? undefined;

  // If the caller explicitly requested a market, reject up-front when that
  // market is filtered out — otherwise they'd get an empty array with no hint.
  if (market) assertAllowed(caller.filters, { market });

  let holdings: unknown;
  try {
    holdings = await client.portfolio.getHoldings({
      portfolioKey,
      market,
      endDate,
    });
  } catch (e) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', `BT getHoldings failed: ${(e as Error).message}`, {
      context: { uid: caller.tenant.uid, mode: caller.mode },
    });
  }

  // BT's holdings response can come in a few shapes. Handle:
  //   - the real shape: { Total: { Positions: [...], CurrencyRates: [...] } }
  //     (Numerar-cash-with-inner-MoneyBalances-currency, plus stock positions)
  //   - bare array
  //   - { items: [...] }
  // filterBtHoldings handles the first case (and is a no-op on the others).
  holdings = filterBtHoldings(holdings, caller.filters);
  if (Array.isArray(holdings)) {
    holdings = filterRecords(holdings as unknown[], caller.filters, readRecordFields);
  } else if (holdings && typeof holdings === 'object') {
    const obj = holdings as Record<string, unknown>;
    if (Array.isArray(obj.items)) {
      obj.items = filterRecords(obj.items as unknown[], caller.filters, readRecordFields);
    }
  }

  return ok({ mode: caller.mode, portfolioKey, holdings });
});
