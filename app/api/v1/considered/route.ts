/**
 * Considered candidates — trades that the synthesis step looked at but did
 * NOT enter, along with why. Feeds the retrospective so the corpus isn't
 * just what worked but also what was deliberately skipped.
 *
 *   POST /api/v1/considered         — append a record
 *   GET  /api/v1/considered?since=ISO&limit=N  — query
 */

import { requireApiKey, assertWriteAccess } from '@/lib/auth/api-key';
import { appendConsideredRecord, listConsideredRecords } from '@/lib/store';
import { ok, readJsonObject, withRoute } from '@/lib/route-handler';
import { assertAllowed, filterRecords, readRecordFields } from '@/lib/filters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  assertWriteAccess(caller);
  const record = await readJsonObject(req);
  assertAllowed(caller.filters, readRecordFields(record));
  const id = await appendConsideredRecord(caller.tenant, caller.mode, record);
  return ok({ mode: caller.mode, id });
});

export const GET = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const sp = req.nextUrl.searchParams;
  const records = await listConsideredRecords(caller.tenant, caller.mode, {
    since: sp.get('since') ?? undefined,
    limit: sp.get('limit') ? Number(sp.get('limit')) : undefined,
  });
  return ok({ mode: caller.mode, records: filterRecords(records, caller.filters, readRecordFields) });
});
