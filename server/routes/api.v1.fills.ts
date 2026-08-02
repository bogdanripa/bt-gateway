/**
 * Fill records — one per historical fill. Append-only.
 *
 *   POST /api/v1/fills        — append a fill
 *   GET  /api/v1/fills?since=ISO&limit=N — query
 *
 * Records may carry their own `fill_id` for dedup. Ordered by `filled_at`.
 */

import { requireApiKey, assertWriteAccess } from '@/lib/auth/api-key';
import { appendFillRecord, listFillRecords } from '@/lib/store';
import { ok, readJsonObject, withRoute } from '@/lib/route-handler';
import { assertAllowed, filterRecords, readRecordFields } from '@/lib/filters';


export const POST = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  assertWriteAccess(caller);
  const record = await readJsonObject(req);
  assertAllowed(caller.filters, readRecordFields(record));
  if (typeof record.filled_at !== 'string' || !record.filled_at) {
    record.filled_at = new Date().toISOString();
  }
  const id = await appendFillRecord(caller.tenant, caller.mode, record);
  return ok({ mode: caller.mode, id });
});

export const GET = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const sp = new URL(req.url).searchParams;
  const records = await listFillRecords(caller.tenant, caller.mode, {
    since: sp.get('since') ?? undefined,
    limit: sp.get('limit') ? Number(sp.get('limit')) : undefined,
  });
  return ok({ mode: caller.mode, records: filterRecords(records, caller.filters, readRecordFields) });
});
