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
 * Shape-aware filter for BT's holdings payload. The upstream response is
 * roughly:
 *
 *   { Total: {
 *       Positions: [
 *         { AssetType: 'Numerar', MoneyBalances: [
 *             { Title, Value: { Currency, Formatted, Amount, ... } }, ...
 *         ] },
 *         { AssetType: '...', Symbol, Market, Currency, ... },  // stock
 *         ...
 *       ],
 *       CurrencyRates: [ { Name: 'EUR', Rate: 4.92 }, ... ],
 *   } }
 *
 * For stock positions we filter the Position itself by its top-level
 * Market/Currency/Symbol. For the "Numerar" (cash) position we instead
 * filter the inner MoneyBalances array — currency lives at .Value.Currency
 * there — and drop the whole position if every balance is filtered out.
 * CurrencyRates are also filtered by the Name field so the FX table
 * doesn't leak currencies the key can't see.
 *
 * Mutates the input for simplicity; callers pass the just-received BT
 * response so there's no shared state to worry about.
 */
export function filterBtHoldings(payload: unknown, filters: ApiKeyFilters | undefined): unknown {
  if (!filters || !payload || typeof payload !== 'object') return payload;
  const root = payload as Record<string, unknown>;
  const totalKey = 'Total' in root ? 'Total' : 'total' in root ? 'total' : null;
  if (!totalKey) return payload;
  const total = root[totalKey];
  if (!total || typeof total !== 'object') return payload;
  const t = total as Record<string, unknown>;

  const positionsKey = 'Positions' in t ? 'Positions' : 'positions' in t ? 'positions' : null;
  if (positionsKey && Array.isArray(t[positionsKey])) {
    const kept: unknown[] = [];
    for (const pos of t[positionsKey] as unknown[]) {
      const next = filterPosition(pos, filters);
      if (next !== null) kept.push(next);
    }
    t[positionsKey] = kept;
  }

  const ratesKey = 'CurrencyRates' in t ? 'CurrencyRates' : 'currencyRates' in t ? 'currencyRates' : null;
  if (ratesKey && Array.isArray(t[ratesKey])) {
    t[ratesKey] = filterRecords(t[ratesKey] as unknown[], filters, (r) => {
      if (!r || typeof r !== 'object') return {};
      const o = r as Record<string, unknown>;
      const name = (typeof o.Name === 'string' ? o.Name : typeof o.name === 'string' ? o.name : undefined);
      return { currency: name ?? null };
    });
  }

  return payload;
}

const INNER_POSITION_KEYS = ['Positions', 'positions', 'Securities', 'securities', 'Items', 'items', 'Holdings', 'holdings', 'Stocks', 'stocks', 'SubPositions', 'subPositions'];

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

  // Non-cash position. Two possible shapes:
  //   (a) flat record — Symbol/Market/Currency at top level.
  //   (b) aggregate record with a nested array of per-security children
  //       (e.g. Positions/Securities/Items). Filter the inner array and
  //       drop the aggregate only if everything got filtered out.
  // Try (b) first: if we find an inner array we prefer filtering it.
  for (const k of INNER_POSITION_KEYS) {
    const inner = p[k];
    if (!Array.isArray(inner)) continue;
    const kept = (inner as unknown[]).filter((item) => {
      const f = readRecordFields(item);
      if (!isAllowedOn(filters, 'markets', f.market ?? null)) return false;
      if (!isAllowedOn(filters, 'currencies', f.currency ?? null)) return false;
      if (!isAllowedOn(filters, 'stocks', f.symbol ?? null)) return false;
      return true;
    });
    if (kept.length === 0) return null;
    p[k] = kept;
    return p;
  }

  // (a) flat record path.
  const fields = readRecordFields(p);
  if (fields.symbol === undefined && fields.market === undefined && fields.currency === undefined) {
    // Couldn't classify at all — log the keys so we can extend the field list.
    console.warn(JSON.stringify({
      severity: 'WARNING',
      msg: 'filterPosition.unclassified',
      assetType,
      keys: Object.keys(p),
    }));
  }
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
