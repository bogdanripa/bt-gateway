/**
 * POST /api/v1/session/refresh
 *
 * Force a refresh cycle on the tenant's BT session. Mostly useful for:
 *   - The keep-alive cron (`/internal/cron/refresh`) that walks all tenants.
 *   - The UI's "re-authenticate" button after a session expiry alert.
 *
 * Calling this does NOT start a new login — it just rotates the access token
 * using the persisted refresh token. If the refresh token has expired, the
 * NEXT user-initiated call to any `/api/v1/*` endpoint will fail and trigger
 * the full login path (with OTP prompt). Successes here audit-log as
 * `refresh.success` but do NOT Telegram — per the user's "no message every
 * 45 minutes" rule. Failures DO Telegram, via the underlying session hook.
 */

import { requireApiKey } from '@/lib/auth/api-key';
import { getBtClient } from '@/lib/bt/client-pool';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import { audit } from '@/lib/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute(async (req, { requestId }) => {
  const caller = await requireApiKey(req);
  // Programmatic endpoint (cron + UI button) — never block on the OTP login.
  // If the session is gone, refresh can't recover it anyway; fail fast with
  // SESSION_EXPIRED so a human re-auths via the dashboard.
  const client = await getBtClient(caller.tenant, caller.mode, { interactive: false });

  try {
    await client.auth.refresh();
  } catch (e) {
    const msg = (e as Error).message || 'refresh failed';
    await audit({
      tenant: caller.tenant,
      type: 'refresh.failure',
      actor: `api_key:${caller.keyId}`,
      mode: caller.mode,
      status: 'err',
      requestId,
      error: { code: 'REFRESH_FAILED', message: msg },
    });
    throw new ApiError('UPSTREAM_UNAVAILABLE', `BT refresh failed: ${msg}`);
  }

  await audit({
    tenant: caller.tenant,
    type: 'refresh.success',
    actor: `api_key:${caller.keyId}`,
    mode: caller.mode,
    status: 'ok',
    requestId,
  });

  return ok({ mode: caller.mode, refreshed: true });
});
