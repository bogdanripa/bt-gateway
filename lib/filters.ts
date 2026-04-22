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
  const match = axis === 'currencies'
    ? (filterVal: string) => v.includes(filterVal)
    : (filterVal: string) => filterVal === v;

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
 * Pass `undefined` for fields the caller didn't specify — those are skipped.
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
    if (v == null) continue;
    const a = axisOf(filters, axis);
    if (!hasConstraints(a)) continue;
    if (!isAllowedOn(filters, axis, v)) {
      const label = axis === 'stocks' ? 'symbol' : axis.replace(/s$/, '');
      throw new ApiError(
        'FORBIDDEN',
        `This API key is not permitted to access ${label}=${v}`,
        { context: { axis, value: v } },
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
 * BT payloads are `unknown` — this helper reads common field names off a
 * record of unknown shape without throwing. BT uses PascalCase on most
 * endpoints (Currency, Market, Code) and occasionally nests the identifying
 * fields under a sub-object (`.Value.Currency` on MoneyBalance entries,
 * sometimes `.Security.Symbol` / `.Instrument.Code` on position entries).
 * We probe both the flat case and common nesting containers so the filter
 * logic stays endpoint-agnostic.
 */
// Symbol field candidates. Covers PositionItem.Code (live per-security rows)
// and PositionSummary.Ticker (aggregate rows) from bt-trade's typedefs, plus
// the usual fallbacks for other endpoints.
const SYMBOL_KEYS = ['symbol', 'Symbol', 'code', 'Code', 'ticker', 'Ticker', 'instrument', 'Instrument', 'securitySymbol', 'SecuritySymbol', 'stockSymbol', 'StockSymbol', 'isin', 'Isin', 'ISIN'];
const MARKET_KEYS = ['market', 'Market', 'marketCode', 'MarketCode', 'exchange', 'Exchange'];
const CURRENCY_KEYS = ['currency', 'Currency', 'currencyId', 'CurrencyId', 'currencyCode', 'CurrencyCode', 'ccy', 'Ccy'];
const NESTED_CONTAINERS = ['value', 'Value', 'security', 'Security', 'instrument', 'Instrument', 'securityInfo', 'SecurityInfo'];

export function readRecordFields(
  r: unknown,
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
  const pickAny = (keys: string[]): string | undefined => {
    const top = pickStr(o, keys);
    if (top) return top;
    for (const k of NESTED_CONTAINERS) {
      const parent = o[k];
      if (parent && typeof parent === 'object') {
        const v = pickStr(parent as Record<string, unknown>, keys);
        if (v) return v;
      }
    }
    return undefined;
  };
  return {
    market: pickAny(MARKET_KEYS),
    currency: pickAny(CURRENCY_KEYS),
    symbol: pickAny(SYMBOL_KEYS),
  };
}

/**
 * Shape-aware filter for BT's holdings payload. Per the bt-trade package's
 * types, POST /Portfolio/Select returns:
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
export function filterBtHoldings(payload: unknown, filters: ApiKeyFilters | undefined): unknown {
  if (!filters || !payload || typeof payload !== 'object') return payload;
  const root = payload as Record<string, unknown>;

  // TODO(filter-debug): delete after confirming the holdings filter works on a
  // live key. Captures before/after sizes on every mutation point and logs the
  // first PositionItem's keys + extracted axis values so we can see BT's real
  // shape and adjust readRecordFields if needed.
  const dbg: Record<string, unknown> = { filters };

  // (1) The real positions at Positions.Items.
  const positions = root['Positions'] ?? root['positions'];
  if (positions && typeof positions === 'object') {
    const pp = positions as Record<string, unknown>;
    const itemsKey = 'Items' in pp ? 'Items' : 'items' in pp ? 'items' : null;
    if (itemsKey && Array.isArray(pp[itemsKey])) {
      const before = pp[itemsKey] as unknown[];
      dbg.itemsBefore = before.length;
      if (before.length > 0) {
        const sample = before[0];
        if (sample && typeof sample === 'object') {
          dbg.sampleItemKeys = Object.keys(sample as Record<string, unknown>);
          dbg.sampleItemExtracted = readRecordFields(sample);
        }
      }
      const filtered = filterRecords(before, filters, readRecordFields);
      pp[itemsKey] = filtered;
      dbg.itemsAfter = filtered.length;
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
        const beforeSum = (t[sumKey] as unknown[]).length;
        const kept: unknown[] = [];
        for (const pos of t[sumKey] as unknown[]) {
          const next = filterPosition(pos, filters);
          if (next !== null) kept.push(next);
        }
        t[sumKey] = kept;
        dbg.totalPositionsBefore = beforeSum;
        dbg.totalPositionsAfter = kept.length;
      }

      // Top-level Total.MoneyBalances (NOT the ones nested inside the Numerar
      // summary row — those are handled in filterPosition). These are the
      // roll-up rows that show e.g. "Total cash" split per currency.
      const tmbKey = 'MoneyBalances' in t ? 'MoneyBalances' : 'moneyBalances' in t ? 'moneyBalances' : null;
      if (tmbKey && Array.isArray(t[tmbKey])) {
        const beforeMb = (t[tmbKey] as unknown[]).length;
        const filtered = filterRecords(t[tmbKey] as unknown[], filters, (b) => {
          const fields = readRecordFields(b);
          return { currency: fields.currency ?? null };
        });
        t[tmbKey] = filtered;
        dbg.totalMoneyBalancesBefore = beforeMb;
        dbg.totalMoneyBalancesAfter = filtered.length;
      }

      const ratesKey = 'CurrencyRates' in t ? 'CurrencyRates' : 'currencyRates' in t ? 'currencyRates' : null;
      if (ratesKey && Array.isArray(t[ratesKey])) {
        const beforeRates = (t[ratesKey] as unknown[]).length;
        t[ratesKey] = filterRecords(t[ratesKey] as unknown[], filters, (r) => {
          if (!r || typeof r !== 'object') return {};
          const o = r as Record<string, unknown>;
          const name = (typeof o.Name === 'string' ? o.Name : typeof o.name === 'string' ? o.name : undefined);
          return { currency: name ?? null };
        });
        dbg.ratesBefore = beforeRates;
        dbg.ratesAfter = (t[ratesKey] as unknown[]).length;
      }
    }
  }

  // TODO(filter-debug): delete alongside the `dbg` collector.
  console.log(JSON.stringify({
    severity: 'INFO',
    msg: 'holdings.filter_debug.run',
    ...dbg,
  }));

  return payload;
}

function filterPosition(pos: unknown, filters: ApiKeyFilters): unknown | null {
  if (!pos || typeof pos !== 'object') return pos;
  const p = pos as Record<string, unknown>;
  const assetType = (typeof p.AssetType === 'string' ? p.AssetType
    : typeof p.assetType === 'string' ? p.assetType : '') as string;
  const isCash = assetType === 'Numerar';

  if (isCash) {
    const balKey = 'MoneyBalances' in p ? 'MoneyBalances' : 'moneyBalances' in p ? 'moneyBalances' : null;
    if (balKey && Array.isArray(p[balKey])) {
      const kept = (p[balKey] as unknown[]).filter((b) => {
        const fields = readRecordFields(b);
        return isAllowedOn(filters, 'currencies', fields.currency ?? null);
      });
      if (kept.length === 0) return null;
      p[balKey] = kept;
    }
    return p;
  }

  // PositionSummary aggregates (e.g. per-asset-type totals). The identifying
  // ticker lives on a field called `Ticker` per bt-trade's PositionSummary
  // typedef. readRecordFields covers that via the SYMBOL_KEYS list.
  const fields = readRecordFields(p);
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
