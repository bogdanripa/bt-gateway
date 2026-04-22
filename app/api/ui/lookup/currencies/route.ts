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
import type { BtMode } from '@/lib/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CurrencyOption {
  code: string;
  label: string;
}

function reshape(currencies: unknown): CurrencyOption[] {
  if (!Array.isArray(currencies)) return [];
  const out: CurrencyOption[] = [];
  for (const c of currencies) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const code = typeof o.code === 'string' ? o.code
      : typeof o.currency === 'string' ? o.currency
      : typeof o.currencyCode === 'string' ? o.currencyCode
      : typeof o.id === 'string' ? o.id
      : undefined;
    if (!code) continue;
    const name = typeof o.name === 'string' ? o.name : typeof o.displayName === 'string' ? o.displayName : '';
    out.push({ code: code.toUpperCase(), label: name ? `${code.toUpperCase()} — ${name}` : code.toUpperCase() });
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
