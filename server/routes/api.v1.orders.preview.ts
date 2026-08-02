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
import { resolveInstrument } from '@/lib/bt/instruments';
import { getPortfolioKey } from '@/lib/bt/portfolio-key';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError, json } from '@/lib/errors';
import { assertAllowed } from '@/lib/filters';


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

  try {
    const { preview, resolvedCode, resolvedMarketId } = await runWithSession(
      caller.tenant,
      caller.mode,
      async (client) => {
        const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);
        // Always resolve via searchInstrument so the market + currency filter
        // applies even when marketId is supplied explicitly.
        const resolved = await resolveInstrument(client, symbolUp, args.marketId);
        assertAllowed(caller.filters, {
          symbol: resolved.code,
          market: resolved.market,
          currency: resolved.currency,
        });

        const p = await client.orders.preview({
          portfolioKey,
          symbol: resolved.code,
          marketId: resolved.marketId,
          quantity: args.quantity ?? null,
          price: args.price,
          side: args.side,
          type: args.type,
        });
        return { preview: p, resolvedCode: resolved.code, resolvedMarketId: resolved.marketId };
      },
    );
    return ok({ mode: caller.mode, symbol: resolvedCode, marketId: resolvedMarketId, preview });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('UPSTREAM_UNAVAILABLE', `preview failed: ${(e as Error).message}`);
  }
});
