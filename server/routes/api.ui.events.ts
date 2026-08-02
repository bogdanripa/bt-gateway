/**
 * GET /api/ui/events?limit=200 — audit log for the signed-in tenant.
 *
 * Only mutating events land in the audit log (reads never write
 * there), so this already returns the "see all audit lines that make
 * changes" view the spec asks for. A `?types=` filter is supported so the
 * UI can hide routine refresh.success entries to keep the feed focused on
 * trading activity.
 */

import { requireFirebaseUser } from '@/lib/auth/session';
import { listEvents, type EventDoc } from '@/lib/store';
import { ok, withRoute } from '@/lib/route-handler';


export const GET = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const sp = new URL(req.url).searchParams;
  const limit = Math.min(Math.max(Number(sp.get('limit') ?? 200), 1), 1000);
  const typesRaw = sp.get('types');
  const types = typesRaw
    ? (typesRaw.split(',').map((s) => s.trim()).filter(Boolean) as EventDoc['type'][])
    : undefined;
  const events = await listEvents(caller.tenant, { limit, types });
  return ok({ events });
});
