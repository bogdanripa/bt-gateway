/**
 * GET /api/v1/markets
 *
 * Returns the list of markets available to this session (BVB segments etc.).
 * Equivalent to `client.markets.list()`.
 */

import { requireApiKey } from '@/lib/auth/api-key';
import { getBtClient } from '@/lib/bt/client-pool';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const client = await getBtClient(caller.tenant, caller.mode);
  try {
    const markets = await client.markets.list();
    return ok({ mode: caller.mode, markets });
  } catch (e) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', `BT markets.list failed: ${(e as Error).message}`);
  }
});
