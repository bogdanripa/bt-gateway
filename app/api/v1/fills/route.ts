/**
 * Fill records — one per historical fill. Append-only.
 *
 *   POST /api/v1/fills        — append a fill
 *   GET  /api/v1/fills?since=ISO&limit=N — query
 *
 * Records may carry their own `fill_id` for dedup. Ordered by `filled_at`.
 */

import { requireApiKey } from '@/lib/auth/api-key';
import { appendFillRecord, listFillRecords } from '@/lib/firestore';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import { assertAllowed, filterRecords, readRecordFields } from '@/lib/filters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  let body: unknown;
  try { body = await req.json(); }
  catch { throw new ApiError('BAD_REQUEST', 'Body must be JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError('BAD_REQUEST', 'Body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  assertAllowed(caller.filters, readRecordFields(record));
  if (typeof record.filled_at !== 'string' || !record.filled_at) {
    record.filled_at = new Date().toISOString();
  }
  const id = await appendFillRecord(caller.tenant, caller.mode, record);
  return ok({ mode: caller.mode, id });
});

export const GET = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const sp = req.nextUrl.searchParams;
  const records = await listFillRecords(caller.tenant, caller.mode, {
    since: sp.get('since') ?? undefined,
    limit: sp.get('limit') ? Number(sp.get('limit')) : undefined,
  });
  return ok({ mode: caller.mode, records: filterRecords(records, caller.filters, readRecordFields) });
});
