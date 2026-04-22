/**
 * GET /api/v1/cash
 *
 * Returns the available cash on the tenant's default portfolio, in the
 * portfolio's default evaluation currency. For multi-currency accounts the
 * response echoes the currencyId so clients can disambiguate.
 *
 * Read-only — does NOT emit an audit event. Cloud Logging captures the
 * access log automatically via `withRoute`.
 */

import { requireApiKey } from '@/lib/auth/api-key';
import { getBtClient } from '@/lib/bt/client-pool';
import { getPortfolioKey } from '@/lib/bt/portfolio-key';
import { getEvaluationCurrencyId } from '@/lib/bt/currency';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import { filterRecords, isAllowedOn } from '@/lib/filters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cash balance entries expose currency under `value.currency` (per
 * AccountSnapshot.tsx) — unwrap that for the filter pick.
 */
function cashCurrency(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const e = entry as Record<string, unknown>;
  const v = e.value;
  if (v && typeof v === 'object') {
    const c = (v as Record<string, unknown>).currency;
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  const direct = e.currency ?? e.currencyId ?? e.currencyCode;
  return typeof direct === 'string' && direct.trim() ? direct.trim() : undefined;
}

export const GET = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const client = await getBtClient(caller.tenant, caller.mode);
  const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);

  // getCash requires the evaluation currencyId. Some accounts don't have
  // `profile.selectedPortfolioPanelCurrencyID` populated — the helper
  // falls back to the evaluation-currencies nomenclature (preferring RON).
  const currencyId = await getEvaluationCurrencyId(caller.tenant, caller.mode, client);

  let cash: unknown;
  try {
    cash = await client.portfolio.getCash({ portfolioKey, currencyId });
  } catch (e) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', `BT getCash failed: ${(e as Error).message}`, {
      context: { uid: caller.tenant.uid, mode: caller.mode },
    });
  }

  // Cash is returned as an array of balance entries keyed by currency. Filter
  // out currencies the key can't see — if none remain, return an empty array.
  if (Array.isArray(cash)) {
    cash = filterRecords(cash as unknown[], caller.filters, (entry) => ({
      currency: cashCurrency(entry) ?? null,
    }));
  } else if (cash && typeof cash === 'object') {
    const obj = cash as Record<string, unknown>;
    if (Array.isArray(obj.items)) {
      obj.items = filterRecords(obj.items as unknown[], caller.filters, (entry) => ({
        currency: cashCurrency(entry) ?? null,
      }));
    } else {
      // Single balance object — drop entirely if its currency is filtered out.
      const c = cashCurrency(obj);
      if (c && !isAllowedOn(caller.filters, 'currencies', c)) cash = null;
    }
  }

  return ok({ mode: caller.mode, portfolioKey, cash });
});
