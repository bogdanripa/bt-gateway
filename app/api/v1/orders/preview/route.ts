/**
 * POST /api/v1/orders/preview
 *
 * Preview fees + net value for a prospective order WITHOUT placing it.
 * Body:
 *   {
 *     symbol: "TVBETETF",
 *     marketId?: "<id>",        // optional; resolved from symbol if omitted
 *     quantity?: number,        // optional for preview (some brokers accept 0)
 *     price: number,
 *     side: "buy" | "sell",
 *     type?: "limit" | "market" // default "limit"
 *   }
 *
 * Preview does NOT mutate — it's a read-only pricing call — so no audit event.
 */

import { z } from 'zod';
import { requireApiKey } from '@/lib/auth/api-key';
import { runWithSession } from '@/lib/bt/client-pool';
import { getPortfolioKey } from '@/lib/bt/portfolio-key';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import { assertAllowed } from '@/lib/filters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Schema = z.object({
  symbol: z.string().min(1).max(32),
  marketId: z.union([z.string(), z.number()]).optional(),
  quantity: z.number().positive().optional(),
  price: z.number().positive(),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['limit', 'market']).default('limit'),
});

export const POST = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('BAD_REQUEST', 'Invalid preview body', {
      context: { issues: parsed.error.issues },
    });
  }
  const args = parsed.data;

  // Reject up-front if the requested symbol is filtered out.
  const symbolUp = args.symbol.toUpperCase();
  assertAllowed(caller.filters, { symbol: symbolUp });

  let symbol = symbolUp;
  let marketId = args.marketId;
  try {
    const { preview } = await runWithSession(caller.tenant, caller.mode, async (client) => {
      const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);
      // Always resolve via searchInstrument so the market + currency filter
      // applies even when marketId is supplied explicitly.
      const hits = await client.markets.searchInstrument(symbol);
      if (!Array.isArray(hits) || hits.length === 0) {
        throw new ApiError('NOT_FOUND', `Instrument not found: ${symbol}`);
      }
      type Hit = { code?: string; marketId?: string | number; market?: string; currency?: string };
      const pick = marketId
        ? (hits as Hit[]).find((h) => String(h.marketId) === String(marketId))
        : (hits[0] as Hit);
      if (!pick) {
        throw new ApiError(
          'NOT_FOUND',
          `Instrument ${symbol} not listed on marketId=${marketId}`,
        );
      }
      if (!pick.marketId) {
        throw new ApiError('UPSTREAM_UNAVAILABLE', 'searchInstrument hit missing marketId');
      }
      marketId = pick.marketId;
      symbol = pick.code ?? symbol;
      assertAllowed(caller.filters, { symbol, market: pick.market, currency: pick.currency });

      const p = await client.orders.preview({
        portfolioKey,
        symbol,
        marketId,
        quantity: args.quantity ?? null,
        price: args.price,
        side: args.side,
        type: args.type,
      });
      return { preview: p };
    });
    return ok({ mode: caller.mode, symbol, marketId, preview });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('UPSTREAM_UNAVAILABLE', `preview failed: ${(e as Error).message}`);
  }
});
