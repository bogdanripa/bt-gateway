/**
 * Per-API-key filter enforcement.
 *
 * Each API key can carry optional include/exclude lists on three axes:
 * markets, currencies, and instrument symbols ("stocks"). Semantics:
 *
 *   include=[] → no allowlist, anything passes
 *   include=[A,B] → only A and B pass
 *   exclude=[Z] → Z is always rejected, even if in include
 *
 * Matching is case-insensitive. An axis with both lists empty (or a caller
 * whose ApiKeyDoc has no `filters` field) is unconstrained.
 *
 * Two call shapes:
 *   - `isAllowedOn(axis, value, filters)` — a predicate, used to filter
 *     arrays of results returned from BT.
 *   - `assertAllowed(filters, picks)` — throws `FORBIDDEN` when a mutation
 *     (place order, append fill) targets something the key isn't permitted
 *     to act on.
 *
 * BT's JSON payloads are typed `unknown`, so the array-filter helper takes
 * field-extractor callbacks and silently passes through items whose fields
 * can't be read — better to err on the side of keeping a row than to drop
 * something we didn't recognize. The `assertAllowed` path on the other hand
 * is strict: if the caller supplied a symbol/market/currency, it must pass.
 */

import 'server-only';
import { ApiError } from './errors';
import type { ApiKeyFilters, FilterAxis } from './firestore';

export type FilterAxisName = 'markets' | 'currencies' | 'stocks';

const EMPTY_AXIS: FilterAxis = { include: [], exclude: [] };

export const EMPTY_FILTERS: ApiKeyFilters = {
  markets: EMPTY_AXIS,
  currencies: EMPTY_AXIS,
  stocks: EMPTY_AXIS,
};

function norm(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t ? t.toUpperCase() : null;
}

function axisOf(filters: ApiKeyFilters | undefined, axis: FilterAxisName): FilterAxis {
  return filters?.[axis] ?? EMPTY_AXIS;
}

function hasConstraints(a: FilterAxis): boolean {
  return a.include.length > 0 || a.exclude.length > 0;
}

/**
 * Returns true if `value` passes the filter for this axis. `null`/`undefined`
 * values (field missing on the upstream payload) pass when the axis has no
 * include list — we never synthesize a restriction we can't prove.
 *
 * Currency matching is substring-based: upstream payloads come in a few
 * shapes ("RON", "lei (RON)", "Romanian Leu"), so a filter value of "RON"
 * is expected to match all of them. The record's currency string must
 * CONTAIN the filter value (case-insensitive). Markets and stocks stay on
 * exact-equality matching because those codes are well-defined.
 */
/**
 * How each axis compares a record's value to a filter list entry:
 * - `currencies`: the record's currency string must CONTAIN the filter value
 *   (case-insensitive). Lets "RON" match "RON", "lei (RON)", "Romanian Leu
 *   RON" across BT's varying payload shapes.
 * - `markets`, `stocks`: exact-equality (case-insensitive). Short codes like
 *   "BVB" and tickers like "TLV" are well-defined; substring would leak
 *   e.g. "TEL" into "TELA" matches.
 *
 * Returns a predicate that takes a normalized filter-list entry and reports
 * whether the already-normalized record value matches it.
 */
function matcherFor(axis: FilterAxisName, recordValue: string): (filterVal: string) => boolean {
  if (axis === 'currencies') return (filterVal) => recordValue.includes(filterVal);
  return (filterVal) => filterVal === recordValue;
}

export function isAllowedOn(
  filters: ApiKeyFilters | undefined,
  axis: FilterAxisName,
  value: string | null | undefined,
): boolean {
  const a = axisOf(filters, axis);
  if (!hasConstraints(a)) return true;
  const v = norm(value);
  if (v == null) {
    // No field to match on → only reject if there's an include list (strict).
    return a.include.length === 0;
  }
  const match = matcherFor(axis, v);

  for (const x of a.exclude) {
    const n = norm(x);
    if (n && match(n)) return false;
  }
  if (a.include.length > 0) {
    let ok = false;
    for (const x of a.include) {
      const n = norm(x);
      if (n && match(n)) { ok = true; break; }
    }
    if (!ok) return false;
  }
  return true;
}

/**
 * Strict check: throws `FORBIDDEN` when any provided picks fail their axis.
 *
 * Semantics for a `null`/`undefined` pick on an axis that HAS an include
 * list: fail-closed. If the caller can't prove the axis value and the key
 * is restricted to a specific allowlist, it's not permitted. This matches
 * `isAllowedOn`'s strict-reject-on-unknown behavior — otherwise a caller
 * with `markets.include=[BVB]` could bypass the market gate by placing an
 * order against a searchInstrument hit that omits `.market` (e.g. some BT
 * response shapes only populate marketId).
 *
 * Axes with no constraints (empty include and exclude) always pass.
 *
 * Use this at the top of every mutating route (POST orders, preview, journal
 * append, fill append) after parsing the body, and at single-resource reads
 * (orders/:id, instruments/:symbol) once the target is resolved.
 */
export function assertAllowed(
  filters: ApiKeyFilters | undefined,
  picks: { market?: string | null; currency?: string | null; symbol?: string | null },
): void {
  const checks: Array<[FilterAxisName, string | null | undefined]> = [
    ['markets', picks.market],
    ['currencies', picks.currency],
    ['stocks', picks.symbol],
  ];
  for (const [axis, v] of checks) {
    const a = axisOf(filters, axis);
    if (!hasConstraints(a)) continue;
    if (!isAllowedOn(filters, axis, v)) {
      const label = axis === 'stocks' ? 'symbol' : axis.replace(/s$/, '');
      const displayValue = v ?? '<unknown>';
      throw new ApiError(
        'FORBIDDEN',
        `This API key is not permitted to access ${label}=${displayValue}`,
        { context: { axis, value: v ?? null } },
      );
    }
  }
}

/**
 * Filter an array of upstream records. `pick` extracts the value for each
 * axis from a record; return `undefined` when the field isn't present on
 * that record (it will pass through as unconstrained for that axis).
 */
export function filterRecords<T>(
  records: readonly T[],
  filters: ApiKeyFilters | undefined,
  pick: (r: T) => { market?: string | null; currency?: string | null; symbol?: string | null },
): T[] {
  if (!filters) return [...records];
  const m = axisOf(filters, 'markets');
  const c = axisOf(filters, 'currencies');
  const s = axisOf(filters, 'stocks');
  if (!hasConstraints(m) && !hasConstraints(c) && !hasConstraints(s)) return [...records];

  return records.filter((r) => {
    const fields = pick(r);
    if (hasConstraints(m) && !isAllowedOn(filters, 'markets', fields.market)) return false;
    if (hasConstraints(c) && !isAllowedOn(filters, 'currencies', fields.currency)) return false;
    if (hasConstraints(s) && !isAllowedOn(filters, 'stocks', fields.symbol)) return false;
    return true;
  });
}

/**
 * Filter a list using ONLY the currencies axis, ignoring markets/stocks.
 *
 * Use on resources that have no market/stock concept (cash balances,
 * Total.MoneyBalances roll-ups, Total.CurrencyRates). Going through
 * `filterRecords` would incorrectly drop every row when another axis has
 * an include list (undefined market + markets.include=[BVB] → strict reject).
 */
export function filterByCurrencyOnly<T>(
  records: readonly T[],
  filters: ApiKeyFilters | undefined,
  pickCurrency: (r: T) => string | null | undefined,
): T[] {
  return records.filter((r) => isAllowedOn(filters, 'currencies', pickCurrency(r)));
}

/**
 * Filter a response payload that might be a bare array, a `{ items: [...] }`
 * wrapper, or a bt-trade `PaginatedResult<T>` (`{ Items: T[], Page, PageSize,
 * TotalItemCount }`). Mutates the wrapper in place when applicable so the
 * caller keeps the original envelope; returns the payload (possibly a new
 * array if the input was a bare array).
 *
 * Keeps TotalItemCount in sync with the filtered length so clients don't
 * see a stale count.
 */
export function filterPaginatedPayload<R extends { market?: string | null; currency?: string | null; symbol?: string | null }>(
  payload: unknown,
  filters: ApiKeyFilters | undefined,
  pick: (r: unknown) => R,
): unknown {
  if (Array.isArray(payload)) {
    return filterRecords(payload as unknown[], filters, pick);
  }
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const itemsKey = Array.isArray(obj.Items) ? 'Items'
      : Array.isArray(obj.items) ? 'items'
      : null;
    if (itemsKey) {
      const filtered = filterRecords(obj[itemsKey] as unknown[], filters, pick);
      obj[itemsKey] = filtered;
      if (typeof obj.TotalItemCount === 'number') obj.TotalItemCount = filtered.length;
      else if (typeof obj.totalItemCount === 'number') obj.totalItemCount = filtered.length;
    }
  }
  return payload;
}

/**
 * BT payloads are `unknown` — this helper reads the canonical field names
 * off a record of unknown shape without throwing. BT uses PascalCase on
 * position/order records (Currency, Market, Code) and lowercase on cash
 * balance entries where currency is nested inside `.value: MoneyValue`.
 *
 * Field lists below cover what's observed in bt-trade 0.3.1's typedefs:
 *   - PositionItem: Code, Market, Currency, MarketId
 *   - PositionSummary: Ticker
 *   - Order: Code, Symbol, Market, MarketId/ExchangeId
 *   - BalanceEntry: value.currency (and its PascalCase cousins)
 *   - searchInstrument hit: code, market, currency, marketId (lowercase)
 */
const SYMBOL_KEYS = ['symbol', 'Symbol', 'code', 'Code', 'ticker', 'Ticker'];
const MARKET_KEYS = ['market', 'Market'];
const CURRENCY_KEYS = ['currency', 'Currency'];
// Only container we've ever seen nest a currency: BalanceEntry.value (a
// MoneyValue with .currency). Keep lowercase+PascalCase to cover both
// shapes observed.
const NESTED_CURRENCY_CONTAINERS = ['value', 'Value'];

const MARKET_ID_KEYS = ['MarketId', 'marketId', 'ExchangeId', 'exchangeId'];

function pickNumber(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

export function readRecordFields(
  r: unknown,
  opts?: { marketsCache?: Map<number, string> },
): { market?: string; currency?: string; symbol?: string } {
  if (!r || typeof r !== 'object') return {};
  const o = r as Record<string, unknown>;
  const pickStr = (obj: Record<string, unknown>, keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };

  // Currency may be nested inside `.value` on BalanceEntry records; otherwise
  // every field we care about is at the top level.
  const nestedCurrency = (): string | undefined => {
    for (const k of NESTED_CURRENCY_CONTAINERS) {
      const parent = o[k];
      if (parent && typeof parent === 'object') {
        const v = pickStr(parent as Record<string, unknown>, CURRENCY_KEYS);
        if (v) return v;
      }
    }
    return undefined;
  };

  // Prefer the canonical exchange name from the markets cache when a
  // MarketId/ExchangeId is on the record. BT sometimes surfaces a
  // segment-level code on `Market` (e.g. "REGS" for the BVB regulated-market
  // segment) while the user-configured filter is the parent exchange code
  // ("BVB"). MarketId is stable across segments.
  let market = pickStr(o, MARKET_KEYS);
  if (opts?.marketsCache) {
    const mid = pickNumber(o, MARKET_ID_KEYS);
    if (mid !== undefined) {
      const canonical = opts.marketsCache.get(mid);
      if (canonical) market = canonical;
    }
  }

  return {
    market,
    currency: pickStr(o, CURRENCY_KEYS) ?? nestedCurrency(),
    symbol: pickStr(o, SYMBOL_KEYS),
  };
}

/**
 * Shape-aware filter for the response BT returns from POST /Portfolio/Select
 * (the endpoint wrapped by `client.portfolio.getHoldings`). Per bt-trade's
 * typedefs the payload is:
 *
 *   {
 *     Positions: {                            // PaginatedResult<PositionItem>
 *       Items: [ { Code, Market, SecurityName, AvgPrice, ... }, ... ],  // the real per-security rows
 *       Page, PageSize, TotalItemCount,
 *     },
 *     Total: {
 *       Positions: [ { Key, Name, Ticker, AssetType, CurrencyId, Percent,
 *                      MoneyBalances, ... }, ... ],  // PositionSummary aggregates
 *       CurrencyRates: [ { Name: 'EUR', Rate, ID }, ... ],
 *     }
 *   }
 *
 * We filter BOTH:
 *   - `Positions.Items` — the actual per-security positions (matched by Code
 *     for stocks axis, Market for markets axis, etc.). Drop every row that
 *     fails any axis.
 *   - `Total.Positions` — the aggregate summary rows. For AssetType='Numerar'
 *     we filter the nested MoneyBalances by currency and drop the summary
 *     only if every balance is filtered out. For non-Numerar summary rows
 *     (per-asset-type totals) we check the row's Ticker against the stocks
 *     axis.
 *   - `Total.CurrencyRates` — filtered by rate.Name against currencies axis.
 *
 * Mutates the input in place — callers pass the just-received BT response so
 * there's no shared state to worry about.
 */
export function filterPortfolioSelectResponse(
  payload: unknown,
  filters: ApiKeyFilters | undefined,
  marketsCache?: Map<number, string>,
): unknown {
  if (!filters || !payload || typeof payload !== 'object') return payload;
  const root = payload as Record<string, unknown>;

  const read = (r: unknown) => readRecordFields(r, { marketsCache });

  // (1) The real positions at Positions.Items. bt-trade@0.3.1+ puts Market,
  // Currency, MarketId, CurrencyId directly on each PositionItem. We pass the
  // markets cache so readRecordFields can canonicalize BT's sometimes-segment-
  // level Market string (e.g. "REGS" → "BVB") before comparison.
  const positions = root['Positions'] ?? root['positions'];
  if (positions && typeof positions === 'object') {
    const pp = positions as Record<string, unknown>;
    const itemsKey = 'Items' in pp ? 'Items' : 'items' in pp ? 'items' : null;
    if (itemsKey && Array.isArray(pp[itemsKey])) {
      const filtered = filterRecords(pp[itemsKey] as unknown[], filters, read);
      pp[itemsKey] = filtered;
      if (typeof pp.TotalItemCount === 'number') pp.TotalItemCount = filtered.length;
      else if (typeof pp.totalItemCount === 'number') pp.totalItemCount = filtered.length;
    }
  }

  // (2) The Total.* aggregates.
  const totalKey = 'Total' in root ? 'Total' : 'total' in root ? 'total' : null;
  if (totalKey) {
    const total = root[totalKey];
    if (total && typeof total === 'object') {
      const t = total as Record<string, unknown>;

      const sumKey = 'Positions' in t ? 'Positions' : 'positions' in t ? 'positions' : null;
      if (sumKey && Array.isArray(t[sumKey])) {
        const kept: unknown[] = [];
        for (const pos of t[sumKey] as unknown[]) {
          const next = filterPosition(pos, filters, marketsCache);
          if (next !== null) kept.push(next);
        }
        t[sumKey] = kept;
      }

      // Top-level Total.MoneyBalances (NOT the ones nested inside the Numerar
      // summary row — those are handled in filterPosition). Roll-up rows that
      // show e.g. "Total cash" split per currency — currency-only.
      const tmbKey = 'MoneyBalances' in t ? 'MoneyBalances' : 'moneyBalances' in t ? 'moneyBalances' : null;
      if (tmbKey && Array.isArray(t[tmbKey])) {
        t[tmbKey] = filterByCurrencyOnly(
          t[tmbKey] as unknown[],
          filters,
          (b) => readRecordFields(b).currency ?? null,
        );
      }

      // CurrencyRates is also a currency-only resource — the currency lives
      // on `.Name`, not on the Currency/CurrencyId fields readRecordFields
      // probes, so pick it out explicitly.
      const ratesKey = 'CurrencyRates' in t ? 'CurrencyRates' : 'currencyRates' in t ? 'currencyRates' : null;
      if (ratesKey && Array.isArray(t[ratesKey])) {
        t[ratesKey] = filterByCurrencyOnly(
          t[ratesKey] as unknown[],
          filters,
          (r) => {
            if (!r || typeof r !== 'object') return null;
            const o = r as Record<string, unknown>;
            return typeof o.Name === 'string' ? o.Name
              : typeof o.name === 'string' ? o.name
              : null;
          },
        );
      }
    }
  }

  return payload;
}

function filterPosition(
  pos: unknown,
  filters: ApiKeyFilters,
  marketsCache?: Map<number, string>,
): unknown | null {
  if (!pos || typeof pos !== 'object') return pos;
  const p = pos as Record<string, unknown>;
  const assetType = (typeof p.AssetType === 'string' ? p.AssetType
    : typeof p.assetType === 'string' ? p.assetType : '') as string;
  const isCash = assetType === 'Numerar';

  if (isCash) {
    const balKey = 'MoneyBalances' in p ? 'MoneyBalances' : 'moneyBalances' in p ? 'moneyBalances' : null;
    if (balKey && Array.isArray(p[balKey])) {
      const kept = filterByCurrencyOnly(
        p[balKey] as unknown[],
        filters,
        (b) => readRecordFields(b).currency ?? null,
      );
      if (kept.length === 0) return null;
      p[balKey] = kept;
    }
    return p;
  }

  // PositionSummary aggregates (e.g. per-asset-type totals). The identifying
  // ticker lives on a field called `Ticker` per bt-trade's PositionSummary
  // typedef. readRecordFields covers that via the SYMBOL_KEYS list.
  const fields = readRecordFields(p, { marketsCache });
  if (!isAllowedOn(filters, 'markets', fields.market ?? null)) return null;
  if (!isAllowedOn(filters, 'currencies', fields.currency ?? null)) return null;
  if (!isAllowedOn(filters, 'stocks', fields.symbol ?? null)) return null;
  return p;
}

/**
 * Schema-compatible shape for the filter payload coming from the UI. Kept
 * in this module so both `/api/ui/keys` (create) and the future PATCH route
 * import the same definition.
 */
export function sanitizeFilters(input: unknown): ApiKeyFilters {
  const out: ApiKeyFilters = {
    markets: { include: [], exclude: [] },
    currencies: { include: [], exclude: [] },
    stocks: { include: [], exclude: [] },
  };
  if (!input || typeof input !== 'object') return out;
  const src = input as Record<string, unknown>;
  for (const axis of ['markets', 'currencies', 'stocks'] as const) {
    const a = src[axis];
    if (!a || typeof a !== 'object') continue;
    const rec = a as Record<string, unknown>;
    for (const side of ['include', 'exclude'] as const) {
      const list = rec[side];
      if (!Array.isArray(list)) continue;
      out[axis][side] = list
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter((x) => x.length > 0 && x.length <= 32);
    }
  }
  return out;
}
