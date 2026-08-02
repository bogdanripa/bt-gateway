/**
 * GET  /api/ui/keys                 → list keys (without the raw value)
 * POST /api/ui/keys                 → { mode, label } → creates a key
 *                                     RESPONSE INCLUDES THE RAW KEY ONCE.
 *                                     The UI must surface it immediately and
 *                                     warn the user it won't be shown again.
 */

import { z } from 'zod';
import { requireFirebaseUser } from '@/lib/auth/session';
import { createApiKey, listApiKeys, type BtMode } from '@/lib/store';
import { generateApiKey } from '@/lib/auth/api-key';
import { ApiError } from '@/lib/errors';
import { audit } from '@/lib/events';
import { ok, withRoute } from '@/lib/route-handler';
import { sanitizeFilters } from '@/lib/filters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AxisSchema = z.object({
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
});

const FiltersSchema = z.object({
  markets: AxisSchema.default({ include: [], exclude: [] }),
  currencies: AxisSchema.default({ include: [], exclude: [] }),
  stocks: AxisSchema.default({ include: [], exclude: [] }),
});

const Schema = z.object({
  mode: z.enum(['demo', 'live']),
  label: z.string().min(1).max(80),
  filters: FiltersSchema.optional(),
});

export const GET = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const keys = await listApiKeys(caller.tenant);
  // Strip the hash — never exposed to the browser.
  const rows = keys.map(({ hash: _hash, ...rest }) => rest);
  return ok({ keys: rows });
});

export const POST = withRoute(async (req, { requestId }) => {
  const caller = await requireFirebaseUser(req);
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('BAD_REQUEST', 'Invalid body', { context: { issues: parsed.error.issues } });
  }
  const mode = parsed.data.mode as BtMode;
  const { key, hash, prefix } = generateApiKey(mode);
  const filters = parsed.data.filters ? sanitizeFilters(parsed.data.filters) : undefined;
  const id = await createApiKey(caller.tenant, {
    prefix,
    hash,
    mode,
    label: parsed.data.label,
    createdAt: new Date().toISOString(),
    ...(filters ? { filters } : {}),
  });

  await audit({
    tenant: caller.tenant,
    type: 'apikey.created',
    actor: 'user',
    mode,
    status: 'ok',
    requestId,
    detail: { id, prefix, label: parsed.data.label, filters: filters ?? null },
  });

  // Only this response ever exposes the raw key. It is NOT stored anywhere
  // in plaintext — we stored sha256(key). If the user loses it, they have
  // to make a new one.
  return ok({
    id,
    key,
    prefix,
    mode,
    label: parsed.data.label,
    warning: 'Save this key now. It will not be shown again.',
  });
});
