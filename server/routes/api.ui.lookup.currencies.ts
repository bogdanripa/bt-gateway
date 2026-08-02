/**
 * GET /api/ui/lookup/currencies?mode=demo|live
 *
 * Currency codes available on this tenant's session. Sourced from
 * `client.reference.listCurrencies()`. Reshaped to `{ code, label }[]`.
 */

import { requireFirebaseUser } from '@/lib/auth/session';
import { runWithSession, toBtApiError } from '@/lib/bt/client-pool';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import type { BtMode } from '@/lib/store';


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
  const modeRaw = new URL(req.url).searchParams.get('mode');
  if (modeRaw !== 'demo' && modeRaw !== 'live') {
    throw new ApiError('BAD_REQUEST', 'mode query param must be "demo" or "live"');
  }
  const mode = modeRaw as BtMode;

  // runWithSession (not a bare getBtClient) so a stale pool entry retries once
  // against a rebuilt client instead of 502-ing. `interactive: false` because
  // this feeds an autocomplete: hanging the filter editor for up to 5 minutes
  // on an SMS OTP is worse than a fast 503 the UI can render as "re-auth".
  // The dashboard's /api/ui/account is the interactive path that drives login.
  try {
    const currencies = await runWithSession(
      caller.tenant,
      mode,
      (client) => client.reference.listCurrencies(),
      { interactive: false },
    );
    return ok({ mode, currencies: reshape(currencies) });
  } catch (e) {
    throw toBtApiError(e, 'listCurrencies', caller.tenant, mode);
  }
});
