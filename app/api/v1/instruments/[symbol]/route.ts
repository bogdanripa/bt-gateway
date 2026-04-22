/**
 * GET /api/v1/instruments/:symbol
 *
 * Tick details for an instrument by symbol. Two-step upstream call:
 *   1. searchInstrument(symbol) → pick the BVB hit
 *   2. getInstrument({ portfolioKey, code, marketId }) → the tick payload
 *
 * Optional `?marketId=` override — otherwise we use the first match from
 * searchInstrument, which is what the BT web UI does.
 */

import { requireApiKey } from '@/lib/auth/api-key';
import { runWithSession } from '@/lib/bt/client-pool';
import { getPortfolioKey } from '@/lib/bt/portfolio-key';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import { assertAllowed, readRecordFields } from '@/lib/filters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute<{ symbol: string }>(async (req, { params }) => {
  const caller = await requireApiKey(req);
  const symbol = params.symbol?.toUpperCase();
  if (!symbol) throw new ApiError('BAD_REQUEST', 'symbol path segment required');

  // Reject before touching BT when the symbol alone is enough to tell.
  assertAllowed(caller.filters, { symbol });

  const overrideMarketId = req.nextUrl.searchParams.get('marketId');

  try {
    const { code, marketId, instrument } = await runWithSession(caller.tenant, caller.mode, async (client) => {
      const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);
      const hits = await client.markets.searchInstrument(symbol);
      if (!Array.isArray(hits) || hits.length === 0) {
        throw new ApiError('NOT_FOUND', `Instrument not found: ${symbol}`);
      }
      // Pick the hit matching the caller's marketId override if any, else
      // the first. Enforcing the filter against the matched hit (not the
      // first) prevents a caller from bypassing the markets/currency guard
      // via ?marketId=X.
      type Hit = { code?: string; marketId?: string | number; market?: string; currency?: string };
      const pick = overrideMarketId
        ? (hits as Hit[]).find((h) => String(h.marketId) === String(overrideMarketId))
        : (hits[0] as Hit);
      if (!pick) {
        throw new ApiError(
          'NOT_FOUND',
          `Instrument ${symbol} not listed on marketId=${overrideMarketId}`,
        );
      }
      if (!pick.marketId) {
        throw new ApiError('UPSTREAM_UNAVAILABLE', 'searchInstrument hit missing marketId');
      }
      const resolvedCode = pick.code ?? symbol;
      assertAllowed(caller.filters, {
        symbol: resolvedCode,
        market: pick.market,
        currency: pick.currency,
      });

      const inst = await client.markets.getInstrument({
        portfolioKey,
        code: resolvedCode,
        marketId: pick.marketId,
      });
      return { code: resolvedCode, marketId: pick.marketId, instrument: inst };
    });

    // Belt-and-braces: the instrument payload may carry a currency field;
    // reject if filtered out.
    assertAllowed(caller.filters, readRecordFields(instrument));
    return ok({ mode: caller.mode, symbol: code, marketId, instrument });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('UPSTREAM_UNAVAILABLE', `getInstrument failed: ${(e as Error).message}`);
  }
});
