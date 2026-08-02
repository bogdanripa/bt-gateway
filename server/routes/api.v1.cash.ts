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
 * Read-only — does NOT emit an audit event. The container logs capture the
 * access log via `withRoute`.
 */

import { requireApiKey } from '@/lib/auth/api-key';
import { isSessionExpired, runWithSession } from '@/lib/bt/client-pool';
import { listEvaluationCurrencies, type EvalCurrency } from '@/lib/bt/currency';
import { getPortfolioKey } from '@/lib/bt/portfolio-key';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import { filterByCurrencyOnly, isAllowedOn } from '@/lib/filters';


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

export const GET = withRoute(async (req) => {
  const caller = await requireApiKey(req);

  // Wrap BT interaction in runWithSession so a dead session auto-recovers
  // (login() feeds off the ntfy OTP shortcut). The in-memory per-tenant
  // loginInProgress guard (load-bearing on the single pinned instance)
  // guarantees only one login / one outstanding OTP at a time; if a login is
  // already underway this throws SESSION_EXPIRED (503) and the caller retries
  // — picking up the fresh session once it lands.
  const { portfolioKey, cash, errors } = await runWithSession(caller.tenant, caller.mode, async (client) => {
    const pk = await getPortfolioKey(caller.tenant, caller.mode, client);

    // Canonical per-portfolio currency list — IDs here are guaranteed to be
    // accepted by BT (the global nomenclature's IDs differ per-portfolio and
    // were the source of the earlier "Moneda solicitata pe portofoliul SPOT
    // nu este disponibila" bug).
    const currencies = await listEvaluationCurrencies(client);
    if (currencies.length === 0) {
      throw new ApiError(
        'UPSTREAM_UNAVAILABLE',
        'No evaluation currencies available on this portfolio',
        { context: { uid: caller.tenant.uid, mode: caller.mode } },
      );
    }

    // Pre-filter by the API key's currency rules. Saves a BT call per currency
    // the caller can't see anyway.
    const toFetch: EvalCurrency[] = [];
    for (const c of currencies) {
      if (isAllowedOn(caller.filters, 'currencies', c.name)) toFetch.push(c);
    }

    if (toFetch.length === 0) {
      return { portfolioKey: pk, cash: [] as unknown[], errors: [] as Array<{ currency: string; message: string }> };
    }

    // Parallel fetch — tolerate per-currency failures so a single bad endpoint
    // doesn't nuke the whole response.
    const results = await Promise.allSettled(
      toFetch.map((c) => client.portfolio.getCash({ portfolioKey: pk, currencyId: c.id })),
    );

    // If EVERY currency fetch failed and at least one was session-expired,
    // throw the AuthError up so runWithSession can rebuild and retry.
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (rejected.length === results.length && rejected.some((r) => isSessionExpired(r.reason))) {
      throw rejected.find((r) => isSessionExpired(r.reason))!.reason;
    }

    const cashAcc: unknown[] = [];
    const errorsAcc: Array<{ currency: string; message: string }> = [];
    for (let i = 0; i < toFetch.length; i++) {
      const r = results[i];
      const cur = toFetch[i];
      if (r.status === 'fulfilled') {
        const v = r.value;
        if (Array.isArray(v)) {
          for (const entry of v) cashAcc.push(entry);
        } else if (v !== null && v !== undefined) {
          cashAcc.push(v);
        }
      } else {
        errorsAcc.push({
          currency: cur.name,
          message: (r.reason as Error)?.message ?? String(r.reason),
        });
      }
    }

    return { portfolioKey: pk, cash: cashAcc, errors: errorsAcc };
  });

  // Defense-in-depth: filter the flattened list in case BT ever returns
  // cross-currency rows from a single-currency getCash call.
  const filtered = filterByCurrencyOnly(
    cash,
    caller.filters,
    (entry) => cashCurrency(entry) ?? null,
  );

  return ok({
    mode: caller.mode,
    portfolioKey,
    cash: filtered,
    ...(errors.length ? { errors } : {}),
  });
});
