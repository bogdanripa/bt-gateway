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
 * Cancellation is not exposed in M2 — `@bogdanripa/bt-trade@0.3.0` doesn't
 * include a cancel method yet. Actions are surfaced so the UI can show
 * "cancel available" without being able to trigger it. When the node module
 * exposes cancel we'll add DELETE on this route and emit `order.cancelled`.
 */

import { requireApiKey } from '@/lib/auth/api-key';
import { runWithSession } from '@/lib/bt/client-pool';
import { getMarketsCache } from '@/lib/bt/markets-cache';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import { assertAllowed, readRecordFields } from '@/lib/filters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    // Hide orders that belong to an axis the key can't see. The markets cache
    // canonicalizes Order.Market (which may be a segment code like "REGS") to
    // "BVB" via the record's MarketId before matching.
    assertAllowed(caller.filters, readRecordFields(order, { marketsCache }));
    return ok({ mode: caller.mode, order, history, actions });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('UPSTREAM_UNAVAILABLE', `orders.get failed: ${(e as Error).message}`);
  }
});
