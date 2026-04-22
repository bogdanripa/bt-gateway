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
import { getBtClient } from '@/lib/bt/client-pool';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import { assertAllowed, readRecordFields } from '@/lib/filters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute<{ id: string }>(async (req, { params }) => {
  const caller = await requireApiKey(req);
  const id = params.id;
  if (!id) throw new ApiError('BAD_REQUEST', 'order id path segment required');

  const client = await getBtClient(caller.tenant, caller.mode);

  try {
    const [order, history, actions] = await Promise.all([
      client.orders.get(id),
      client.orders.getHistory(id).catch(() => null),
      client.orders.getActions(id).catch(() => null),
    ]);
    // Hide orders that belong to an axis the key can't see.
    assertAllowed(caller.filters, readRecordFields(order));
    return ok({ mode: caller.mode, order, history, actions });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('UPSTREAM_UNAVAILABLE', `orders.get failed: ${(e as Error).message}`);
  }
});
