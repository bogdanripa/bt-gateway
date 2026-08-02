/**
 * GET /api/v1/holdings
 *
 * Returns current holdings (positions) on the default portfolio. Optional
 * query params:
 *   ?market=BVB            — filter by market (the BT client filters client-side)
 *   ?endDate=YYYY-MM-DD    — holdings as of a specific date
 */

import { requireApiKey } from '@/lib/auth/api-key';
import { runWithSession } from '@/lib/bt/client-pool';
import { getMarketsCache } from '@/lib/bt/markets-cache';
import { getPortfolioKey } from '@/lib/bt/portfolio-key';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import { assertAllowed, filterPortfolioSelectResponse, filterPaginatedPayload, readRecordFields } from '@/lib/filters';


export const GET = withRoute(async (req) => {
  const caller = await requireApiKey(req);

  const market = new URL(req.url).searchParams.get('market') ?? undefined;
  const endDate = new URL(req.url).searchParams.get('endDate') ?? undefined;

  // If the caller explicitly requested a market, reject up-front when that
  // market is filtered out — otherwise they'd get an empty array with no hint.
  if (market) assertAllowed(caller.filters, { market });

  let portfolioKey: string;
  let holdings: unknown;
  let marketsCache: Map<number, string> | undefined;
  try {
    ({ portfolioKey, holdings, marketsCache } = await runWithSession(
      caller.tenant,
      caller.mode,
      async (client) => {
        const pk = await getPortfolioKey(caller.tenant, caller.mode, client);
        // Fetch markets cache in parallel with holdings. Cache after first call,
        // so subsequent hits only eat the getHoldings latency.
        const [h, mc] = await Promise.all([
          client.portfolio.getHoldings({ portfolioKey: pk, market, endDate }),
          getMarketsCache(caller.tenant, caller.mode, client),
        ]);
        return { portfolioKey: pk, holdings: h, marketsCache: mc };
      },
    ));
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('UPSTREAM_UNAVAILABLE', `BT getHoldings failed: ${(e as Error).message}`, {
      context: { uid: caller.tenant.uid, mode: caller.mode },
    });
  }

  // filterPortfolioSelectResponse handles the real { Total, Positions } shape.
  // For the fallback shapes (bare array, { items }, PaginatedResult<T>) we
  // run the generic paginated walker. The markets cache lets readRecordFields
  // canonicalize "REGS" → "BVB" etc.
  const read = (r: unknown) => readRecordFields(r, { marketsCache });
  holdings = filterPortfolioSelectResponse(holdings, caller.filters, marketsCache);
  holdings = filterPaginatedPayload(holdings, caller.filters, read);

  return ok({ mode: caller.mode, portfolioKey, holdings });
});
