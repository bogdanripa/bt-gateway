/**
 * GET /api/ui/lookup/currencies?mode=demo|live
 *
 * Currency codes available on this tenant's session. Sourced from
 * `client.reference.listCurrencies()`. Reshaped to `{ code, label }[]`.
 */

import { requireFirebaseUser } from '@/lib/auth/session';
import { getBtClient } from '@/lib/bt/client-pool';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import type { BtMode } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CurrencyOption {
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

function reshape(currencies: unknown): CurrencyOption[] {
  if (!Array.isArray(currencies)) return [];
  const out: CurrencyOption[] = [];
  for (const c of currencies) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    // BT uses PascalCase (Code, Name, Symbol). Keep both cases for resilience.
    const code = pickString(o, 'code', 'Code', 'currency', 'Currency', 'currencyCode', 'CurrencyCode', 'symbol', 'Symbol');
    if (!code) continue;
    const name = pickString(o, 'name', 'Name', 'displayName', 'DisplayName', 'description', 'Description');
    const up = code.toUpperCase();
    out.push({ code: up, label: name ? `${up} — ${name}` : up });
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
  const client = await getBtClient(caller.tenant, mode);
  try {
    const currencies = await client.reference.listCurrencies();
    return ok({ mode, currencies: reshape(currencies) });
  } catch (e) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', `listCurrencies failed: ${(e as Error).message}`);
  }
});
