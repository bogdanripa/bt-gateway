/**
 * GET /api/ui/lookup/markets?mode=demo|live
 *
 * Returns the list of market codes available to this tenant, for use as
 * autocomplete options in the API-key filters UI. Results are pulled from
 * `client.markets.list()` and reshaped to `{ code, label }[]`.
 *
 * Firebase-authed (it's a browser-facing endpoint). Requires an active BT
 * session for the mode — if the user hasn't signed in to BT yet, the
 * upstream call surfaces as UPSTREAM_UNAVAILABLE and the UI should fall
 * back to free-form entry.
 */

import { requireFirebaseUser } from '@/lib/auth/session';
import { getBtClient } from '@/lib/bt/client-pool';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import type { BtMode } from '@/lib/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface MarketOption {
  code: string;
  label: string;
}

function reshape(markets: unknown): MarketOption[] {
  if (!Array.isArray(markets)) return [];
  const out: MarketOption[] = [];
  for (const m of markets) {
    if (!m || typeof m !== 'object') continue;
    const o = m as Record<string, unknown>;
    const code = typeof o.code === 'string' ? o.code
      : typeof o.market === 'string' ? o.market
      : typeof o.id === 'string' ? o.id
      : undefined;
    if (!code) continue;
    const name = typeof o.name === 'string' ? o.name : typeof o.displayName === 'string' ? o.displayName : '';
    out.push({ code, label: name ? `${code} — ${name}` : code });
  }
  // Dedup by code.
  const seen = new Set<string>();
  return out.filter((o) => (seen.has(o.code) ? false : (seen.add(o.code), true)));
}

export const GET = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const modeRaw = req.nextUrl.searchParams.get('mode');
  if (modeRaw !== 'demo' && modeRaw !== 'live') {
    throw new ApiError('BAD_REQUEST', 'mode query param must be "demo" or "live"');
  }
  const mode = modeRaw as BtMode;
  const client = await getBtClient(caller.tenant, mode);
  try {
    const markets = await client.markets.list();
    return ok({ mode, markets: reshape(markets) });
  } catch (e) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', `markets.list failed: ${(e as Error).message}`);
  }
});
