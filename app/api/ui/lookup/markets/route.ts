/**
 * GET /api/ui/lookup/markets?mode=demo|live[&q=PREFIX]
 *
 * Returns the list of market codes available to this tenant, for use as
 * autocomplete options in the API-key filters UI. Results are pulled from
 * `client.markets.list()` and reshaped to `{ code, label }[]`.
 *
 * With `?q=PREFIX` the response is filtered (case-insensitive substring
 * match on code or label). Omit `q` to get the full list.
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

function pickString(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function reshape(markets: unknown): MarketOption[] {
  if (!Array.isArray(markets)) return [];
  const out: MarketOption[] = [];
  for (const m of markets) {
    if (!m || typeof m !== 'object') continue;
    const o = m as Record<string, unknown>;
    // BT's /Nomenclatures/GetExchanges returns { key, description, id, name }:
    //   - `name` and `key` are the SHORT CODE ("BVB", "XETRA", "UK", "US"),
    //      which is what appears on PositionItem.Market and what
    //      searchInstrument returns as .market. This is the value we want
    //      stored as the filter — matching upstream records directly.
    //   - `description` is the human name ("Bursa de Valori Bucuresti").
    //      Used only as the dropdown label for clarity.
    // Fall back to classic Code/Symbol fields if BT ever swaps the shape.
    const code = pickString(
      o,
      'name', 'Name',
      'key', 'Key',
      'code', 'Code',
      'symbol', 'Symbol',
      'market', 'Market',
      'shortCode', 'ShortCode',
      'abbreviation', 'Abbreviation',
      'mic', 'MIC',
    );
    if (!code) continue;
    const desc = pickString(o, 'description', 'Description');
    const label = desc && desc !== code ? `${code} — ${desc}` : code;
    out.push({ code, label });
  }
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
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().toLowerCase();

  const client = await getBtClient(caller.tenant, mode);
  try {
    const all = reshape(await client.markets.list());
    const markets = q
      ? all.filter((m) => m.code.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
      : all;
    return ok({ mode, markets });
  } catch (e) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', `markets.list failed: ${(e as Error).message}`);
  }
});
