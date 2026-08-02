/**
 * DELETE /api/ui/keys/:id — revoke by setting revokedAt. We don't hard-delete
 * so the audit row and "last used at" stay meaningful for forensics.
 *
 * PATCH /api/ui/keys/:id — update the key's filters. Body:
 *   { filters: { markets: {include,exclude}, currencies: {...}, stocks: {...} } }
 * Any omitted axis is reset to { include: [], exclude: [] } (i.e. PATCH is
 * a full replace of the filter tree, not a deep merge).
 */

import { z } from 'zod';
import { requireFirebaseUser } from '@/lib/auth/session';
import { listApiKeys, revokeApiKey, updateApiKeyFilters } from '@/lib/store';
import { ApiError, json } from '@/lib/errors';
import { audit } from '@/lib/events';
import { ok, withRoute } from '@/lib/route-handler';
import { sanitizeFilters } from '@/lib/filters';


const AxisSchema = z.object({
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
});

const PatchSchema = z.object({
  filters: z.object({
    markets: AxisSchema.default({ include: [], exclude: [] }),
    currencies: AxisSchema.default({ include: [], exclude: [] }),
    stocks: AxisSchema.default({ include: [], exclude: [] }),
  }),
});

export const DELETE = withRoute<{ id: string }>(async (req, { params, requestId }) => {
  const caller = await requireFirebaseUser(req);
  const id = params.id;
  if (!id) throw new ApiError('BAD_REQUEST', 'id path segment required');

  // Look it up so we can record mode+prefix in the audit row.
  const keys = await listApiKeys(caller.tenant);
  const target = keys.find((k) => k.id === id);
  if (!target) throw new ApiError('NOT_FOUND', 'API key not found');

  await revokeApiKey(caller.tenant, id);
  await audit({
    tenant: caller.tenant,
    type: 'apikey.revoked',
    actor: 'user',
    mode: target.mode,
    status: 'ok',
    requestId,
    detail: { id, prefix: target.prefix, label: target.label },
  });

  return ok({ id, revoked: true });
});

export const PATCH = withRoute<{ id: string }>(async (req, { params, requestId }) => {
  const caller = await requireFirebaseUser(req);
  const id = params.id;
  if (!id) throw new ApiError('BAD_REQUEST', 'id path segment required');

  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('BAD_REQUEST', 'Invalid body', { context: { issues: parsed.error.issues } });
  }

  const keys = await listApiKeys(caller.tenant);
  const target = keys.find((k) => k.id === id);
  if (!target) throw new ApiError('NOT_FOUND', 'API key not found');
  if (target.revokedAt) throw new ApiError('CONFLICT', 'Cannot edit filters on a revoked key');

  const filters = sanitizeFilters(parsed.data.filters);
  await updateApiKeyFilters(caller.tenant, id, filters);

  await audit({
    tenant: caller.tenant,
    type: 'apikey.updated',
    actor: 'user',
    mode: target.mode,
    status: 'ok',
    requestId,
    detail: { id, prefix: target.prefix, label: target.label, filters },
  });

  return ok({ id, filters });
});
