/**
 * POST /api/internal/cron/refresh
 *
 * Hit by the Pi's cron dispatcher every 45 minutes. Walks all tenants × modes
 * and refreshes any stored BT session so refresh tokens never expire unused.
 *
 * Auth is a shared secret (`INTERNAL_CRON_SECRET`), accepted two ways:
 *
 *   - `Authorization: Bearer <secret>` — for manual curl and anything that
 *     can set headers.
 *   - `{"secret": "<secret>"}` in the JSON body — for the platform scheduler,
 *     which sends a method, a path and a body but has no way to attach a
 *     header. The body is deliberately preferred over a query parameter: a
 *     `?secret=` would end up in the edge proxy's access log, whereas a body
 *     does not.
 *
 * The secret is set as an app environment variable. It's not user-facing and
 * doesn't rotate on a schedule — regenerate manually if exposed.
 *
 * The response returns a compact summary so a single cron attempt is
 * self-sufficient for debugging without opening the container logs.
 */

import { ApiError, json } from '@/lib/errors';
import { ok, withRoute } from '@/lib/route-handler';
import { refreshAllTenants } from '@/lib/bt/refresh';
import crypto from 'node:crypto';


function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Pull the presented secret from the Authorization header, falling back to a
 * `secret` field in the JSON body. Returns null when neither is present.
 */
async function presentedSecret(req: Request): Promise<string | null> {
  const auth = req.headers.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();

  try {
    const body = (await req.json()) as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const s = (body as Record<string, unknown>).secret;
      if (typeof s === 'string' && s.length > 0) return s.trim();
    }
  } catch {
    // No body, or not JSON — nothing to authenticate with.
  }
  return null;
}

export const POST = withRoute(async (req, { requestId }) => {
  const expected = process.env.INTERNAL_CRON_SECRET;
  if (!expected) {
    throw new ApiError('INTERNAL', 'cron secret not configured on this instance');
  }
  const presented = await presentedSecret(req);
  if (!presented || !timingSafeEqual(presented, expected)) {
    throw new ApiError('UNAUTHORIZED', 'invalid cron auth');
  }

  const results = await refreshAllTenants(requestId);
  const counts = results.reduce(
    (acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
    {} as Record<string, number>,
  );

  // One structured log line for trend-watching in the container logs.
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
