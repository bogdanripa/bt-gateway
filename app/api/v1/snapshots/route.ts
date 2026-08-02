/**
 * GET /api/v1/snapshots?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=N
 *
 * List market snapshots in a date range. Ordered by date desc. Used by the
 * retrospective skill to replay regimes and join macro context to trade
 * outcomes.
 *
 * Per-day read/write is at /api/v1/snapshots/:date.
 */

import { requireApiKey } from '@/lib/auth/api-key';
import { listMarketSnapshots } from '@/lib/store';
import { ok, withRoute } from '@/lib/route-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const sp = req.nextUrl.searchParams;
  const records = await listMarketSnapshots(caller.tenant, caller.mode, {
    from: sp.get('from') ?? undefined,
    to: sp.get('to') ?? undefined,
    limit: sp.get('limit') ? Number(sp.get('limit')) : undefined,
  });
  return ok({ mode: caller.mode, records });
});
