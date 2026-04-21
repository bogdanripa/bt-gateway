/**
 * POST /api/internal/cron/refresh
 *
 * Hit by Cloud Scheduler every 45 minutes. Walks all tenants × modes and
 * refreshes any stored BT session so refresh tokens never expire unused.
 *
 * Auth is a shared-secret `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 * The secret is stored in Secret Manager and mounted into the Cloud Run
 * service as an env var via `--set-secrets`; Cloud Scheduler sends it in
 * the header at job creation time. It's not user-facing and doesn't
 * rotate with any schedule — regenerate manually if exposed.
 *
 * The response returns a compact summary so a Cloud Scheduler attempt log
 * is self-sufficient for debugging without opening Cloud Logging.
 */

import { ApiError } from '@/lib/errors';
import { ok, withRoute } from '@/lib/route-handler';
import { refreshAllTenants } from '@/lib/bt/refresh';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export const POST = withRoute(async (req, { requestId }) => {
  const expected = process.env.INTERNAL_CRON_SECRET;
  if (!expected) {
    throw new ApiError('INTERNAL', 'cron secret not configured on this instance');
  }
  const auth = req.headers.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m || !timingSafeEqual(m[1].trim(), expected)) {
    throw new ApiError('UNAUTHORIZED', 'invalid cron auth');
  }

  const results = await refreshAllTenants(requestId);
  const counts = results.reduce(
    (acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
    {} as Record<string, number>,
  );

  // One structured log line for trend-watching in Cloud Logging.
  console.log(
    JSON.stringify({
      severity: 'INFO',
      msg: 'cron.refresh.summary',
      requestId,
      counts,
      total: results.length,
    }),
  );

  return ok({ total: results.length, counts, results });
});
