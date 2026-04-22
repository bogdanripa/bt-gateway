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
 * record of unknown shape without throwing. The field priorities match the
 * shapes observed in holdings/orders/cash responses.
 */
export function readRecordFields(
  r: unknown,
): { market?: string; currency?: string; symbol?: string } {
  if (!r || typeof r !== 'object') return {};
  const o = r as Record<string, unknown>;
  const pickStr = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };
  return {
    market: pickStr('market', 'marketCode', 'exchange'),
    currency: pickStr('currency', 'currencyId', 'currencyCode', 'ccy'),
    symbol: pickStr('symbol', 'code', 'ticker', 'instrument'),
  };
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
