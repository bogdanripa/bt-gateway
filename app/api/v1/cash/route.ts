/**
 * GET /api/v1/cash
 *
 * Returns the cash balances for the tenant's default portfolio across ALL
 * evaluation currencies the portfolio supports (RON, USD, EUR, GBP, …).
 *
 * Why one call wasn't enough: `portfolio.getCash({ portfolioKey, currencyId })`
 * only returns balances for the requested evaluation currency — users with
 * USD/EUR holdings saw nothing when the resolver defaulted to RON. We now
 * iterate every PortfolioCurrency on the account and flatten the results.
 *
 * The per-key currency filter is applied BEFORE we call BT (so we don't
 * waste requests on disallowed currencies) AND after (defense in depth).
 *
 * Response shape:
 *   {
 *     mode, portfolioKey,
 *     cash: BalanceEntry[],                       // flat, across all currencies
 *     errors?: [{ currency: string, message }]    // only present on partial failures
 *   }
 *
 * Read-only — does NOT emit an audit event. Cloud Logging captures the
 * access log via `withRoute`.
 */

import { requireApiKey } from '@/lib/auth/api-key';
import { getBtClient } from '@/lib/bt/client-pool';
import { getPortfolioKey } from '@/lib/bt/portfolio-key';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import { filterRecords, isAllowedOn } from '@/lib/filters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cash balance entries expose currency under `value.currency` — unwrap that
 * for the filter pick. Fall back to top-level variants when present.
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

interface EvalCurrency {
  id: string | number;
  name: string;
}

export const GET = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const client = await getBtClient(caller.tenant, caller.mode);
  const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);

  // Collect the full set of evaluation currencies supported on this account's
  // portfolios. Using the per-account list (not the global nomenclature)
  // guarantees every currencyId we pass is accepted by BT — the global
  // nomenclature's IDs differ per-portfolio and were the source of the earlier
  // "Moneda solicitata pe portofoliul SPOT nu este disponibila" bug.
  const accounts = await client.accounts.list();
  const account =
    accounts.find((a) => a.selected) ??
    accounts.find((a) => a.allowTrading) ??
    accounts[0];
  if (!account) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', 'No BT accounts available for this session');
  }

  const byId = new Map<string | number, EvalCurrency>();
  for (const p of account.portfolios ?? []) {
    for (const c of p.currencies ?? []) {
      if (c.id === undefined || c.id === null || c.id === '') continue;
      const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : String(c.id);
      if (!byId.has(c.id)) byId.set(c.id, { id: c.id, name });
    }
  }
  if (byId.size === 0) {
    throw new ApiError(
      'UPSTREAM_UNAVAILABLE',
      'No evaluation currencies available on this portfolio',
      { context: { uid: caller.tenant.uid, mode: caller.mode } },
    );
  }

  // Pre-filter by the API key's currency rules. Saves a BT call per currency
  // the caller can't see anyway.
  const toFetch: EvalCurrency[] = [];
  for (const c of byId.values()) {
    if (isAllowedOn(caller.filters, 'currencies', c.name)) toFetch.push(c);
  }

  if (toFetch.length === 0) {
    return ok({ mode: caller.mode, portfolioKey, cash: [] });
  }

  // Parallel fetch — tolerate per-currency failures so a single bad endpoint
  // doesn't nuke the whole response.
  const results = await Promise.allSettled(
    toFetch.map((c) =>
      client.portfolio.getCash({ portfolioKey, currencyId: c.id }),
    ),
  );

  const cash: unknown[] = [];
  const errors: Array<{ currency: string; message: string }> = [];
  for (let i = 0; i < toFetch.length; i++) {
    const r = results[i];
    const cur = toFetch[i];
    if (r.status === 'fulfilled') {
      const v = r.value;
      if (Array.isArray(v)) {
        for (const entry of v) cash.push(entry);
      } else if (v !== null && v !== undefined) {
        // Defensive — some future BT response might wrap the array.
        cash.push(v);
      }
    } else {
      errors.push({
        currency: cur.name,
        message: (r.reason as Error)?.message ?? String(r.reason),
      });
    }
  }

  // Defense-in-depth: filter the flattened list in case BT ever returns
  // cross-currency rows from a single-currency getCash call.
  const filtered = filterRecords(cash, caller.filters, (entry) => ({
    currency: cashCurrency(entry) ?? null,
  }));

  return ok({
    mode: caller.mode,
    portfolioKey,
    cash: filtered,
    ...(errors.length ? { errors } : {}),
  });
});
