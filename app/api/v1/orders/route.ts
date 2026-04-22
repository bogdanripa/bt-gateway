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
import { requireApiKey } from '@/lib/auth/api-key';
import { runWithSession } from '@/lib/bt/client-pool';
import { getPortfolioKey } from '@/lib/bt/portfolio-key';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import { audit } from '@/lib/events';
import { assertAllowed, filterRecords, readRecordFields } from '@/lib/filters';

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
    result = await runWithSession(caller.tenant, caller.mode, async (client) => {
      const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);
      // Always call searchInstrument so we know the resolved market + currency
      // to enforce the filter against — even when the caller supplied marketId
      // explicitly. Otherwise markets.include=[BVB] could be bypassed by
      // passing marketId for a foreign exchange, and currencies.include=[RON]
      // could be bypassed by buying TSLA via marketId=4 (US).
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

      return client.orders.placeOrder({
        portfolioKey,
        symbol,
        marketId,
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
    let orders = await runWithSession(caller.tenant, caller.mode, async (client) => {
      const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);
      return client.orders.search({
        portfolioKey,
        statuses,
        side,
        symbol: symbolParam,
        startDate: sp.get('startDate') ?? undefined,
        endDate: sp.get('endDate') ?? undefined,
      });
    });
    if (Array.isArray(orders)) {
      orders = filterRecords(orders as unknown[], caller.filters, readRecordFields);
    } else if (orders && typeof orders === 'object') {
      const obj = orders as Record<string, unknown>;
      // bt-trade's Orders/Search returns PaginatedResult<Order> =
      // { Items: Order[], Page, PageSize, TotalItemCount }. Cover both the
      // PascalCase (real) and lowercase (legacy / defensive) item keys, and
      // keep TotalItemCount in sync with the filtered length.
      const itemsKey = Array.isArray(obj.Items) ? 'Items'
        : Array.isArray(obj.items) ? 'items'
        : null;
      if (itemsKey) {
        const filtered = filterRecords(obj[itemsKey] as unknown[], caller.filters, readRecordFields);
        obj[itemsKey] = filtered;
        if (typeof obj.TotalItemCount === 'number') obj.TotalItemCount = filtered.length;
        else if (typeof obj.totalItemCount === 'number') obj.totalItemCount = filtered.length;
      }
    }
    return ok({ mode: caller.mode, orders });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('UPSTREAM_UNAVAILABLE', `orders.search failed: ${(e as Error).message}`);
  }
});
