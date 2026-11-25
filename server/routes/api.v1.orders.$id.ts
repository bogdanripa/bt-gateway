/**
 * GET /api/v1/orders/:id
 *
 * Returns the order details + history + available actions (cancel/modify).
 * We aggregate three upstream calls in parallel so the UI has everything in
 * one round-trip:
 *   - orders.get(id)          → the current order row
 *   - orders.getHistory(id)   → the state-change history
 *   - orders.getActions(id)   → what actions BT currently allows
 *
 * Cancellation is not exposed yet — `@bogdanripa/bt-trade` (through 0.3.1)
 * doesn't include a cancel method. Actions are surfaced so the UI can show
 * "cancel available" without being able to trigger it. When the package
 * exposes cancel we'll add DELETE on this route and emit `order.cancelled`.
 */

import { requireApiKey } from '@/lib/auth/api-key';
import { runWithSession } from '@/lib/bt/client-pool';
import { getMarketsCache } from '@/lib/bt/markets-cache';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import { assertAllowed, readRecordFields } from '@/lib/filters';


export const GET = withRoute<{ id: string }>(async (req, { params }) => {
  const caller = await requireApiKey(req);
  const id = params.id;
  if (!id) throw new ApiError('BAD_REQUEST', 'order id path segment required');

  try {
    const { order, history, actions, marketsCache } = await runWithSession(
      caller.tenant,
      caller.mode,
      async (client) => {
        const [o, h, a, mc] = await Promise.all([
          client.orders.get(id),
          client.orders.getHistory(id).catch(() => null),
          client.orders.getActions(id).catch(() => null),
          getMarketsCache(caller.tenant, caller.mode, client),
        ]);
        return { order: o, history: h, actions: a, marketsCache: mc };
      },
    );
    // BT answers an unknown order number with an empty body rather than a
    // 404. Without this guard that fell through to assertAllowed, which saw
    // no fields, fail-closed on the first constrained axis, and reported
    // "not permitted to access market=<unknown>" — telling the caller they
    // lack permission for an order that simply does not exist.
    // An empty object counts as "nothing", not just null: BT returns one for
    // an order number Orders/Get cannot resolve, and the identifying fields
    // its typedef promises (OrderNumber, Code, Symbol) are simply absent.
    // Without this the record reached assertAllowed, matched no axis, and was
    // reported as "not permitted to access market=<unknown>" — a permission
    // error for an order we never actually retrieved.
    const orderFields = order && typeof order === 'object' ? (order as Record<string, unknown>) : null;
    const identifies = (o: Record<string, unknown>) =>
      ['OrderNumber', 'orderNumber', 'OrderNumberDisplay', 'Code', 'code', 'Symbol', 'symbol']
        .some((k) => o[k] !== undefined && o[k] !== null && o[k] !== '');
    if (!orderFields || !identifies(orderFields)) {
      throw new ApiError('NOT_FOUND', `No order found with number ${id}`, {
        context: {
          uid: caller.tenant.uid,
          mode: caller.mode,
          id,
          // Field NAMES only, never values: enough to tell an empty body from
          // a shape we are reading at the wrong level, without logging an
          // order's contents.
          upstreamKeys: orderFields ? Object.keys(orderFields).slice(0, 40) : null,
        },
      });
    }

    // Hide orders that belong to an axis the key can't see. The markets cache
    // canonicalizes Order.Market (which may be a segment code like "REGS") to
    // "BVB" via the record's ExchangeId before matching.
    //
    // Currencies are deliberately NOT enforced here: an Order carries no
    // currency string (only MarketCurrencyId), so the axis could never match
    // and rejected every order outright on a currency-restricted key. Market
    // and symbol are still enforced, and an order's currency follows from the
    // market it traded on, which is checked.
    assertAllowed(
      caller.filters,
      readRecordFields(order, { marketsCache }),
      ['markets', 'stocks'],
    );
    return ok({ mode: caller.mode, order, history, actions });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('UPSTREAM_UNAVAILABLE', `orders.get failed: ${(e as Error).message}`);
  }
});
