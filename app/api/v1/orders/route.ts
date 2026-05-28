/**
 * POST /api/v1/orders — place a live order (MUTATING; audited).
 * GET  /api/v1/orders — list orders with optional filters (read-only).
 *
 * POST body:
 *   {
 *     symbol: "TVBETETF",
 *     marketId?: "<id>",
 *     quantity: number,
 *     price?: number,              // required unless type === "market"
 *     side: "buy" | "sell",
 *     type?: "limit" | "market",   // default "limit"
 *     valability?: "day" | "gtc"   // default "day"
 *   }
 *
 * The mode is implied by the API key prefix — a `bvb_demo_...` key places
 * demo orders, a `bvb_live_...` key places live ones. There is no body
 * param to pick between them; that's a load-bearing invariant.
 *
 * GET query params:
 *   ?statuses=OPEN,FILLED   (comma-separated; passed as string[] to BT)
 *   ?side=buy|sell
 *   ?symbol=XXX
 *   ?startDate=YYYY-MM-DD   (BT expects DD.MM.YYYY; the client normalizes)
 *   ?endDate=YYYY-MM-DD
 */

import { z } from 'zod';
import { requireApiKey, assertWriteAccess } from '@/lib/auth/api-key';
import { runWithSession, runWithSessionMutating } from '@/lib/bt/client-pool';
import { resolveInstrument } from '@/lib/bt/instruments';
import { getMarketsCache } from '@/lib/bt/markets-cache';
import { getPortfolioKey } from '@/lib/bt/portfolio-key';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import { audit } from '@/lib/events';
import { assertAllowed, filterPaginatedPayload, readRecordFields } from '@/lib/filters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PlaceSchema = z.object({
  symbol: z.string().min(1).max(32),
  marketId: z.union([z.string(), z.number()]).optional(),
  quantity: z.number().int().positive(),
  price: z.number().positive().optional(),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['limit', 'market']).default('limit'),
  valability: z.enum(['day', 'gtc']).default('day'),
});

export const POST = withRoute(async (req, { requestId }) => {
  const caller = await requireApiKey(req);
  assertWriteAccess(caller);
  const body = await req.json().catch(() => null);
  const parsed = PlaceSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('BAD_REQUEST', 'Invalid order body', {
      context: { issues: parsed.error.issues },
    });
  }
  const args = parsed.data;
  if (args.type !== 'market' && !args.price) {
    throw new ApiError('BAD_REQUEST', 'price is required for non-market orders');
  }

  // Up-front check on symbol; market + currency get checked after we resolve
  // the instrument via searchInstrument.
  const symbolUp = args.symbol.toUpperCase();
  assertAllowed(caller.filters, { symbol: symbolUp });

  let symbol = symbolUp;
  let marketId = args.marketId;
  let result: unknown;
  try {
    // Mutating path: no auto-retry on session expiry mid-flight. If BT
    // accepted the order but returned 401 on the way back, retrying would
    // double-submit (BT has no idempotency key).
    result = await runWithSessionMutating(caller.tenant, caller.mode, async (client) => {
      const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);
      // Always resolve via searchInstrument — even when the caller supplied
      // marketId — so the filter can bite on the resolved market + currency.
      // Otherwise markets.include=[BVB] could be bypassed by passing a marketId
      // for a foreign exchange, and currencies.include=[RON] could be bypassed
      // by buying TSLA via marketId=4 (US).
      const resolved = await resolveInstrument(client, symbol, marketId);
      symbol = resolved.code;
      marketId = resolved.marketId;
      assertAllowed(caller.filters, {
        symbol: resolved.code,
        market: resolved.market,
        currency: resolved.currency,
      });

      return client.orders.placeOrder({
        portfolioKey,
        symbol: resolved.code,
        marketId: resolved.marketId,
        quantity: args.quantity,
        price: args.price,
        side: args.side,
        type: args.type,
        valability: args.valability,
      });
    });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const msg = (e as Error).message || 'placeOrder failed';
    await audit({
      tenant: caller.tenant,
      type: 'order.rejected',
      actor: `api_key:${caller.keyId}`,
      mode: caller.mode,
      status: 'err',
      requestId,
      detail: { symbol, marketId, quantity: args.quantity, price: args.price, side: args.side, type: args.type },
      error: { code: 'PLACE_FAILED', message: msg },
    });
    throw new ApiError('UPSTREAM_UNAVAILABLE', `placeOrder failed: ${msg}`);
  }

  await audit({
    tenant: caller.tenant,
    type: 'order.placed',
    actor: `api_key:${caller.keyId}`,
    mode: caller.mode,
    status: 'ok',
    requestId,
    detail: {
      symbol,
      marketId,
      quantity: args.quantity,
      price: args.price,
      side: args.side,
      type: args.type,
      valability: args.valability,
      // JSON round-trip strips any non-serializable values (Dates → strings,
      // functions dropped) so the Firestore write never silently fails.
      result: JSON.parse(JSON.stringify(result ?? null)) as unknown,
    },
  });
  return ok({ mode: caller.mode, order: result });
});

export const GET = withRoute(async (req) => {
  const caller = await requireApiKey(req);

  const sp = req.nextUrl.searchParams;
  const statusesRaw = sp.get('statuses');
  const statuses = statusesRaw ? statusesRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const sideRaw = sp.get('side');
  const side = sideRaw === 'buy' || sideRaw === 'sell' ? sideRaw : undefined;
  const symbolParam = sp.get('symbol') ?? undefined;

  // If the caller narrowed by symbol, reject when that symbol isn't allowed
  // rather than silently returning [].
  if (symbolParam) assertAllowed(caller.filters, { symbol: symbolParam });

  try {
    const { orders: rawOrders, marketsCache } = await runWithSession(
      caller.tenant,
      caller.mode,
      async (client) => {
        const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);
        const [o, mc] = await Promise.all([
          client.orders.search({
            portfolioKey,
            statuses,
            side,
            symbol: symbolParam,
            startDate: sp.get('startDate') ?? undefined,
            endDate: sp.get('endDate') ?? undefined,
          }),
          getMarketsCache(caller.tenant, caller.mode, client),
        ]);
        return { orders: o, marketsCache: mc };
      },
    );

    // bt-trade's Orders/Search returns PaginatedResult<Order> =
    // { Items: Order[], Page, PageSize, TotalItemCount }. filterPaginatedPayload
    // walks the Items array, filters it, and syncs TotalItemCount.
    const read = (r: unknown) => readRecordFields(r, { marketsCache });
    const orders = filterPaginatedPayload(rawOrders, caller.filters, read);
    return ok({ mode: caller.mode, orders });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('UPSTREAM_UNAVAILABLE', `orders.search failed: ${(e as Error).message}`);
  }
});
