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
import { assertAllowed, filterBtHoldings, filterRecords, readRecordFields } from '@/lib/filters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute(async (req) => {
  const caller = await requireApiKey(req);

  const market = req.nextUrl.searchParams.get('market') ?? undefined;
  const endDate = req.nextUrl.searchParams.get('endDate') ?? undefined;

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

  // BT's holdings response can come in a few shapes. Handle:
  //   - the real shape: { Total: { Positions: [...], CurrencyRates: [...] } }
  //     (Numerar-cash-with-inner-MoneyBalances-currency, plus stock positions)
  //   - bare array
  //   - { items: [...] }
  // filterBtHoldings handles the first case (and is a no-op on the others).
  // The markets cache lets readRecordFields canonicalize "REGS" → "BVB" etc.
  const read = (r: unknown) => readRecordFields(r, { marketsCache });
  holdings = filterBtHoldings(holdings, caller.filters, marketsCache);
  if (Array.isArray(holdings)) {
    holdings = filterRecords(holdings as unknown[], caller.filters, read);
  } else if (holdings && typeof holdings === 'object') {
    const obj = holdings as Record<string, unknown>;
    if (Array.isArray(obj.items)) {
      obj.items = filterRecords(obj.items as unknown[], caller.filters, read);
    }
  }

  return ok({ mode: caller.mode, portfolioKey, holdings });
});
