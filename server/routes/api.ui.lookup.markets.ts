/**
 * GET /api/ui/lookup/markets?mode=demo|live[&q=PREFIX]
 *
 * Returns the list of market codes available to this tenant, for use as
 * autocomplete options in the API-key filters UI. Shares the in-memory
 * markets cache with the filter matching path (lib/bt/markets-cache.ts) so
 * every keystroke-triggered lookup hits memory after the first call.
 *
 * With `?q=PREFIX` the response is filtered (case-insensitive substring
 * match on code or label). Omit `q` to get the full list.
 */

import { requireFirebaseUser } from '@/lib/auth/session';
import { runWithSession, toBtApiError } from '@/lib/bt/client-pool';
import { getMarkets } from '@/lib/bt/markets-cache';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import type { BtMode } from '@/lib/store';


export const GET = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const modeRaw = new URL(req.url).searchParams.get('mode');
  if (modeRaw !== 'demo' && modeRaw !== 'live') {
    throw new ApiError('BAD_REQUEST', 'mode query param must be "demo" or "live"');
  }
  const mode = modeRaw as BtMode;
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim().toLowerCase();

  // See api.ui.lookup.currencies.ts for why this is non-interactive.
  try {
    const { options } = await runWithSession(
      caller.tenant,
      mode,
      (client) => getMarkets(caller.tenant, mode, client),
      { interactive: false },
    );
    const markets = q
      ? options.filter((m) => m.code.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
      : options;
    return ok({ mode, markets });
  } catch (e) {
    throw toBtApiError(e, 'markets.list', caller.tenant, mode);
  }
});
