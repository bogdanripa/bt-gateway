/**
 * GET /api/ui/lookup/instruments?mode=demo|live&q=PREFIX
 *
 * Autocomplete feed for instrument-symbol pickers. Proxies
 * `client.markets.searchInstrument(q)` and shapes the response to
 * `{ code, market, label }[]`. `q` must be at least 1 char.
 */

import { requireFirebaseUser } from '@/lib/auth/session';
import { getBtClient } from '@/lib/bt/client-pool';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import type { BtMode } from '@/lib/store';


interface InstrumentOption {
  code: string;
  market?: string;
  label: string;
}

function reshape(hits: unknown): InstrumentOption[] {
  if (!Array.isArray(hits)) return [];
  const out: InstrumentOption[] = [];
  for (const h of hits) {
    if (!h || typeof h !== 'object') continue;
    const o = h as Record<string, unknown>;
    const code = typeof o.code === 'string' ? o.code : typeof o.symbol === 'string' ? o.symbol : undefined;
    if (!code) continue;
    const market = typeof o.market === 'string' ? o.market : undefined;
    const name = typeof o.name === 'string' ? o.name : typeof o.description === 'string' ? o.description : '';
    const parts = [code];
    if (market) parts.push(`(${market})`);
    if (name) parts.push(`— ${name}`);
    out.push({ code: code.toUpperCase(), market, label: parts.join(' ') });
  }
  const seen = new Set<string>();
  return out.filter((o) => {
    const k = `${o.code}::${o.market ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const GET = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const modeRaw = new URL(req.url).searchParams.get('mode');
  if (modeRaw !== 'demo' && modeRaw !== 'live') {
    throw new ApiError('BAD_REQUEST', 'mode query param must be "demo" or "live"');
  }
  const mode = modeRaw as BtMode;
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim();
  if (!q) return ok({ mode, instruments: [] });

  const client = await getBtClient(caller.tenant, mode);
  try {
    const hits = await client.markets.searchInstrument(q);
    return ok({ mode, instruments: reshape(hits) });
  } catch (e) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', `searchInstrument failed: ${(e as Error).message}`);
  }
});
