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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute<{ symbol: string }>(async (req, { params }) => {
  const caller = await requireApiKey(req);
  const client = await getBtClient(caller.tenant, caller.mode);
  const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);

  const symbol = params.symbol?.toUpperCase();
  if (!symbol) throw new ApiError('BAD_REQUEST', 'symbol path segment required');

  const overrideMarketId = req.nextUrl.searchParams.get('marketId');

  let hits: unknown[];
  try {
    hits = await client.markets.searchInstrument(symbol);
  } catch (e) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', `searchInstrument failed: ${(e as Error).message}`);
  }
  if (!hits.length) throw new ApiError('NOT_FOUND', `Instrument not found: ${symbol}`);

  // Pick the caller-specified marketId, or the first hit.
  const first = hits[0] as { code?: string; marketId?: string | number };
  const marketId = overrideMarketId ?? first.marketId;
  const code = first.code ?? symbol;
  if (!marketId) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', 'searchInstrument hit missing marketId');
  }

  try {
    const instrument = await client.markets.getInstrument({
      portfolioKey,
      code,
      marketId,
    });
    return ok({ mode: caller.mode, symbol: code, marketId, instrument });
  } catch (e) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', `getInstrument failed: ${(e as Error).message}`);
  }
});
