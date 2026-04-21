/**
 * DELETE /api/ui/keys/:id — revoke by setting revokedAt. We don't hard-delete
 * so the audit row and "last used at" stay meaningful for forensics.
 */

import { requireFirebaseUser } from '@/lib/auth/session';
import { revokeApiKey, listApiKeys } from '@/lib/firestore';
import { ApiError } from '@/lib/errors';
import { audit } from '@/lib/events';
import { ok, withRoute } from '@/lib/route-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
