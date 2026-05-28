/**
 * GET /api/v1/snapshots/:date  — read one day's market snapshot
 * PUT /api/v1/snapshots/:date  — write/overwrite a day's snapshot
 *
 * `date` format: YYYY-MM-DD. macro-analyst writes these every morning after
 * composing the rule-evaluator inputs.
 */

import { requireApiKey, assertWriteAccess } from '@/lib/auth/api-key';
import { getMarketSnapshot, saveMarketSnapshot } from '@/lib/firestore';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const GET = withRoute<{ date: string }>(async (req, { params }) => {
  const caller = await requireApiKey(req);
  if (!DATE_RE.test(params.date)) {
    throw new ApiError('BAD_REQUEST', 'date must be YYYY-MM-DD');
  }
  const record = await getMarketSnapshot(caller.tenant, caller.mode, params.date);
  return ok({ mode: caller.mode, date: params.date, record });
});

export const PUT = withRoute<{ date: string }>(async (req, { params }) => {
  const caller = await requireApiKey(req);
  assertWriteAccess(caller);
  if (!DATE_RE.test(params.date)) {
    throw new ApiError('BAD_REQUEST', 'date must be YYYY-MM-DD');
  }
  let body: unknown;
  try { body = await req.json(); }
  catch { throw new ApiError('BAD_REQUEST', 'Body must be JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError('BAD_REQUEST', 'Body must be a JSON object');
  }
  await saveMarketSnapshot(caller.tenant, caller.mode, params.date, body);
  return ok({ mode: caller.mode, date: params.date, saved: true });
});
