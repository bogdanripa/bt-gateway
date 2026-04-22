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
import { getBtClient } from '@/lib/bt/client-pool';
import { getPortfolioKey } from '@/lib/bt/portfolio-key';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import { assertAllowed, readRecordFields } from '@/lib/filters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute<{ symbol: string }>(async (req, { params }) => {
  const caller = await requireApiKey(req);
  const client = await getBtClient(caller.tenant, caller.mode);
  const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);

  const symbol = params.symbol?.toUpperCase();
  if (!symbol) throw new ApiError('BAD_REQUEST', 'symbol path segment required');

  // Reject before touching BT when the symbol alone is enough to tell.
  assertAllowed(caller.filters, { symbol });

  const overrideMarketId = req.nextUrl.searchParams.get('marketId');

  let hits: unknown[];
  try {
    hits = await client.markets.searchInstrument(symbol);
  } catch (e) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', `searchInstrument failed: ${(e as Error).message}`);
  }
  if (!hits.length) throw new ApiError('NOT_FOUND', `Instrument not found: ${symbol}`);

  // Pick the caller-specified marketId, or the first hit.
  const first = hits[0] as { code?: string; marketId?: string | number; market?: string };
  const marketId = overrideMarketId ?? first.marketId;
  const code = first.code ?? symbol;
  if (!marketId) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', 'searchInstrument hit missing marketId');
  }
  // Now that the market is resolved, check it too.
  assertAllowed(caller.filters, { market: first.market, symbol: code });

  try {
    const instrument = await client.markets.getInstrument({
      portfolioKey,
      code,
      marketId,
    });
    // Belt-and-braces: the instrument payload may carry a currency field;
    // reject if filtered out.
    const fields = readRecordFields(instrument);
    assertAllowed(caller.filters, fields);
    return ok({ mode: caller.mode, symbol: code, marketId, instrument });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('UPSTREAM_UNAVAILABLE', `getInstrument failed: ${(e as Error).message}`);
  }
});
