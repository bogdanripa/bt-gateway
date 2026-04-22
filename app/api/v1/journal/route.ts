/**
 * Trade journal — the narrative record of every trade (entry thesis, exit
 * outcome). Append-only; corrections go in as new records referencing the
 * original's id.
 *
 *   POST /api/v1/journal       — append a record
 *   GET  /api/v1/journal?since=ISO&type=entry|exit&limit=N — read
 *
 * Records may carry their own `journal_id` for dedup (replay safety); if
 * omitted the server assigns one. `timestamp` on each record is what we
 * order by — callers should set it to an ISO string at write time.
 */

import { requireApiKey } from '@/lib/auth/api-key';
import { appendJournalEntry, listJournalEntries } from '@/lib/firestore';
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
  if (typeof record.timestamp !== 'string' || !record.timestamp) {
    record.timestamp = new Date().toISOString();
  }
  const id = await appendJournalEntry(caller.tenant, caller.mode, record);
  return ok({ mode: caller.mode, id });
});

export const GET = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const sp = req.nextUrl.searchParams;
  const records = await listJournalEntries(caller.tenant, caller.mode, {
    since: sp.get('since') ?? undefined,
    type: sp.get('type') ?? undefined,
    limit: sp.get('limit') ? Number(sp.get('limit')) : undefined,
  });
  return ok({ mode: caller.mode, records: filterRecords(records, caller.filters, readRecordFields) });
});
