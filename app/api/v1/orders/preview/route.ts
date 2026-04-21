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
import { getBtClient } from '@/lib/bt/client-pool';
import { getPortfolioKey } from '@/lib/bt/portfolio-key';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';

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

  const client = await getBtClient(caller.tenant, caller.mode);
  const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);

  // Resolve marketId if not given.
  let marketId = args.marketId;
  let symbol = args.symbol.toUpperCase();
  if (!marketId) {
    const hits = await client.markets.searchInstrument(symbol).catch((e) => {
      throw new ApiError('UPSTREAM_UNAVAILABLE', `searchInstrument: ${(e as Error).message}`);
    });
    const first = hits[0] as { code?: string; marketId?: string | number } | undefined;
    if (!first?.marketId) throw new ApiError('NOT_FOUND', `Instrument not found: ${symbol}`);
    marketId = first.marketId;
    symbol = first.code ?? symbol;
  }

  try {
    const preview = await client.orders.preview({
      portfolioKey,
      symbol,
      marketId,
      quantity: args.quantity ?? null,
      price: args.price,
      side: args.side,
      type: args.type,
    });
    return ok({ mode: caller.mode, symbol, marketId, preview });
  } catch (e) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', `preview failed: ${(e as Error).message}`);
  }
});
