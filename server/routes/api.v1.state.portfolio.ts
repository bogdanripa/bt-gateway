/**
 * GET /api/v1/state/portfolio  — read the tenant's cached portfolio state.
 * PUT /api/v1/state/portfolio  — replace the cached portfolio state.
 *
 * The auto-trading project writes this after each `status` call as a
 * snapshot/cache for downstream skills (risk-monitor, portfolio-manager,
 * retrospective) that don't need sub-second freshness. The authoritative
 * cash + holdings come from BT Trade directly via /api/v1/cash and
 * /api/v1/holdings; this is a convenience read.
 */

import { requireApiKey, assertWriteAccess } from '@/lib/auth/api-key';
import { getPortfolioState, setPortfolioState } from '@/lib/store';
import { ok, readJsonObject, withRoute } from '@/lib/route-handler';


export const GET = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const state = await getPortfolioState(caller.tenant, caller.mode);
  return ok({ mode: caller.mode, state });
});

export const PUT = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  assertWriteAccess(caller);
  const body = await readJsonObject(req);
  await setPortfolioState(caller.tenant, caller.mode, body);
  return ok({ mode: caller.mode, saved: true });
});
