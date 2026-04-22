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
    // BT's Nomenclatures/GetExchanges returns PascalCase records. The exchange
    // code (e.g. "BVB") lives on a string field — never fall back to numeric
    // ids like ExchangeId, because those would get rendered as the chip value.
    const code = pickString(
      o,
      'code', 'Code',
      'symbol', 'Symbol',
      'market', 'Market',
      'shortCode', 'ShortCode',
      'abbreviation', 'Abbreviation',
      'mic', 'MIC',
    );
    if (!code) continue;
    const name = pickString(o, 'name', 'Name', 'displayName', 'DisplayName', 'description', 'Description');
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
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().toLowerCase();

  const client = await getBtClient(caller.tenant, mode);
  try {
    const raw = await client.markets.list();
    const all = reshape(raw);
    // Diagnostic: if BT returned records but we reshaped 0 options, the field
    // names we're looking at don't match the upstream payload. Log ONE sample
    // row's keys AND echo it into the response body so we can extend the
    // pickString list without a Cloud Logging round-trip.
    let debug: unknown = undefined;
    if (Array.isArray(raw) && raw.length > 0 && all.length === 0) {
      const sample = raw[0] && typeof raw[0] === 'object' ? raw[0] as Record<string, unknown> : null;
      const keys = sample ? Object.keys(sample) : [];
      console.warn(JSON.stringify({
        severity: 'WARNING',
        msg: 'lookup.markets.reshape_empty',
        uid: caller.tenant.uid,
        mode,
        upstreamCount: raw.length,
        sampleKeys: keys,
      }));
      debug = { upstreamCount: raw.length, sampleKeys: keys, sample };
    }
    const markets = q
      ? all.filter((m) => m.code.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
      : all;
    return ok(debug ? { mode, markets, _debug: debug } : { mode, markets });
  } catch (e) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', `markets.list failed: ${(e as Error).message}`);
  }
});
