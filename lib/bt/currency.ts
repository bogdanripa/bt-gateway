/**
 * Evaluation-currency resolution for `portfolio.getCash` /
 * `portfolio.getCashDetails`.
 *
 * BT's cash endpoints require a `currencyId` — the evaluation currency in
 * which balances should be returned. The profile sometimes carries it as
 * `selectedPortfolioPanelCurrencyID`, but for fresh demo accounts (and some
 * live accounts that have never touched the portfolio panel in the web UI)
 * the field is 0 / null / undefined. When that happens we fall back to
 * `reference.listEvaluationCurrencies()` and pick RON — the only currency
 * that matters for a BVB-focused gateway.
 *
 * The resolved id is cached per (uid, mode) for the lifetime of the Cloud
 * Run instance, same pattern as portfolio-key.ts. Currency IDs are server
 * enums — they don't change.
 */

import 'server-only';
import { ApiError } from '../errors';
import type { BTTradeClient } from '@bogdanripa/bt-trade';
import type { BtMode, TenantRef } from '../firestore';

const cache = new Map<string, number>();

function cacheKey(t: TenantRef, mode: BtMode): string {
  return `${t.uid}:${mode}`;
}

function validId(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * Returns the evaluation-currency id to use for this tenant + mode. Tries
 * the profile first, then the evaluation-currencies nomenclature (preferring
 * RON), then throws.
 */
export async function getEvaluationCurrencyId(
  t: TenantRef,
  mode: BtMode,
  client: BTTradeClient,
): Promise<number> {
  const k = cacheKey(t, mode);
  const hit = cache.get(k);
  if (hit) return hit;

  // 1. Profile preference (works for accounts that have used the web UI's
  //    portfolio panel at least once).
  try {
    const profile = await client.profile.get();
    const id = validId((profile as Record<string, unknown>)['selectedPortfolioPanelCurrencyID']);
    if (id) {
      cache.set(k, id);
      return id;
    }
  } catch (e) {
    // Profile fetch failure is not fatal — fall through to the nomenclature.
    console.warn(
      JSON.stringify({ severity: 'WARNING', msg: 'currency.profile_failed', err: (e as Error).message }),
    );
  }

  // 2. Nomenclature fallback. Pick RON if present (BVB-focused default),
  //    otherwise the first entry.
  let currencies: unknown[];
  try {
    const raw = await client.reference.listEvaluationCurrencies();
    currencies = Array.isArray(raw) ? raw : [];
  } catch (e) {
    throw new ApiError(
      'UPSTREAM_UNAVAILABLE',
      `Could not resolve evaluation currency: ${(e as Error).message}`,
      { context: { uid: t.uid, mode } },
    );
  }

  if (!Array.isArray(currencies) || currencies.length === 0) {
    throw new ApiError(
      'UPSTREAM_UNAVAILABLE',
      'BT returned no evaluation currencies — cannot resolve currencyId',
      { context: { uid: t.uid, mode } },
    );
  }

  // Find RON. Currency code / name fields aren't strictly typed — look at
  // several common shapes: { Code: 'RON' }, { code: 'RON' }, { Symbol: 'RON' }.
  const isRon = (c: unknown): boolean => {
    if (!c || typeof c !== 'object') return false;
    const o = c as Record<string, unknown>;
    return ['Code', 'code', 'Symbol', 'symbol', 'Name', 'name'].some(
      (f) => typeof o[f] === 'string' && (o[f] as string).toUpperCase() === 'RON',
    );
  };

  const chosen = currencies.find(isRon) ?? currencies[0];
  const idCandidate = chosen && typeof chosen === 'object'
    ? (chosen as Record<string, unknown>)
    : null;
  const id = idCandidate
    ? validId(idCandidate['ID'] ?? idCandidate['Id'] ?? idCandidate['id'] ?? idCandidate['CurrencyID'] ?? idCandidate['currencyId'])
    : null;

  if (!id) {
    throw new ApiError(
      'UPSTREAM_UNAVAILABLE',
      'BT evaluation currency has no usable id field',
      { context: { uid: t.uid, mode, sampleKeys: idCandidate ? Object.keys(idCandidate) : [] } },
    );
  }

  cache.set(k, id);
  return id;
}

export function evictEvaluationCurrency(t: TenantRef, mode: BtMode): void {
  cache.delete(cacheKey(t, mode));
}

export function _resetEvaluationCurrencyCache(): void {
  cache.clear();
}
