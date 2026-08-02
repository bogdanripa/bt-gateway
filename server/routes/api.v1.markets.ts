/**
 * GET /api/v1/markets
 *
 * Returns the list of markets available to this session (BVB segments etc.).
 * Equivalent to `client.markets.list()`.
 */

import { requireApiKey } from '@/lib/auth/api-key';
import { runWithSession } from '@/lib/bt/client-pool';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import { filterRecords } from '@/lib/filters';


function marketCode(r: unknown): string | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const o = r as Record<string, unknown>;
  for (const k of ['code', 'market', 'marketCode', 'id']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

export const GET = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  try {
    let markets = await runWithSession(caller.tenant, caller.mode, (client) => client.markets.list());
    if (Array.isArray(markets)) {
      markets = filterRecords(markets as unknown[], caller.filters, (m) => ({
        market: marketCode(m) ?? null,
      }));
    }
    return ok({ mode: caller.mode, markets });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('UPSTREAM_UNAVAILABLE', `BT markets.list failed: ${(e as Error).message}`);
  }
});
