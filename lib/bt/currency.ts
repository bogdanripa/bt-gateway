/**
 * Evaluation-currency resolution for `portfolio.getCash` /
 * `portfolio.getCashDetails`.
 *
 * BT's cash endpoints require a `currencyId` — the evaluation currency in
 * which balances should be returned. Two things make this surprisingly
 * annoying:
 *
 *   1. Currency IDs are PER-PORTFOLIO. The global
 *      `reference.listEvaluationCurrencies()` returns a generic RON entry
 *      (usually id=3) that won't be accepted on some portfolios — BT
 *      rejects with "Moneda solicitata pe portofoliul SPOT nu este
 *      disponibila!" even when RON is otherwise available on the account.
 *   2. The profile's `selectedPortfolioPanelCurrencyID` is often 0/null
 *      for accounts that haven't touched the portfolio panel in the
 *      web UI.
 *
 * So the only robust path is the list BT hands back on the account itself:
 * `accounts.list()[i].portfolios[j].currencies` — those IDs are guaranteed
 * to be valid for that portfolio. We match the same account
 * `portfolio-key.ts` picks (selected → allowTrading → first), then:
 *
 *   1. Walk its portfolios looking for one whose currencies contain RON
 *      (name match). Take that currency id.
 *   2. If no RON match, use `accounts.defaultCurrencyId(account)` — the
 *      same logic the BT web app uses (first portfolio's first currency).
 *   3. If the account has no portfolio currencies at all, fall through to
 *      the old profile/nomenclature path as a last resort.
 *
 * The resolved id is cached per (uid, mode) for the lifetime of the Cloud
 * Run instance. On eviction the next call re-resolves from scratch.
 */

import { ApiError } from '../errors';
import type { BTTradeClient } from '@bogdanripa/bt-trade';
import type { BtMode, TenantRef } from '../store';

export interface EvalCurrency {
  id: number | string;
  name: string;
}

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

function isRonCurrency(name: unknown): boolean {
  return typeof name === 'string' && name.toUpperCase().includes('RON');
}

/**
 * Enumerate every evaluation currency the selected account's portfolios
 * support. This is the canonical source for any cash call: each id returned
 * is guaranteed to be accepted by BT's `getCash`, because BT emitted it on
 * this account's own portfolio list.
 *
 * Used directly by `/api/v1/cash` (to iterate all currencies) and
 * indirectly by `getEvaluationCurrencyId` (which picks RON or the default).
 *
 * Returns `[]` if the account has no portfolios or no currencies. The
 * caller decides how to handle empty (cash route throws, the resolver
 * falls through to the profile/nomenclature paths).
 */
export async function listEvaluationCurrencies(
  client: BTTradeClient,
): Promise<EvalCurrency[]> {
  const accounts = await client.accounts.list();
  const account =
    accounts.find((a) => a.selected) ??
    accounts.find((a) => a.allowTrading) ??
    accounts[0];
  if (!account) return [];

  const byId = new Map<string | number, EvalCurrency>();
  for (const p of account.portfolios ?? []) {
    for (const c of p.currencies ?? []) {
      if (c.id === undefined || c.id === null || c.id === '') continue;
      const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : String(c.id);
      if (!byId.has(c.id)) byId.set(c.id, { id: c.id, name });
    }
  }
  return [...byId.values()];
}

/**
 * Returns the evaluation-currency id to use for this tenant + mode. Tries
 * the per-portfolio currencies first (reliable), then the profile, then
 * the global nomenclature (historical last resort).
 */
export async function getEvaluationCurrencyId(
  t: TenantRef,
  mode: BtMode,
  client: BTTradeClient,
): Promise<number> {
  const k = cacheKey(t, mode);
  const hit = cache.get(k);
  if (hit) return hit;

  // 1. Per-portfolio currencies (the reliable path). Prefer RON, else the
  //    BT web app's default (first portfolio's first currency).
  try {
    const currencies = await listEvaluationCurrencies(client);
    const ron = currencies.find((c) => isRonCurrency(c.name));
    const chosenId = validId(ron?.id ?? currencies[0]?.id);
    if (chosenId) {
      cache.set(k, chosenId);
      return chosenId;
    }
  } catch (e) {
    console.warn(
      JSON.stringify({ severity: 'WARNING', msg: 'currency.portfolio_currencies_failed', err: (e as Error).message }),
    );
  }

  // 2. Profile preference (accounts that have used the web portfolio panel).
  try {
    const profile = await client.profile.get();
    const id = validId((profile as Record<string, unknown>)['selectedPortfolioPanelCurrencyID']);
    if (id) {
      cache.set(k, id);
      return id;
    }
  } catch (e) {
    console.warn(
      JSON.stringify({ severity: 'WARNING', msg: 'currency.profile_failed', err: (e as Error).message }),
    );
  }

  // 3. Global nomenclature — historical last resort. Known to return IDs
  //    that aren't valid on some portfolios; kept only for completeness.
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

  if (currencies.length === 0) {
    throw new ApiError(
      'UPSTREAM_UNAVAILABLE',
      'BT returned no evaluation currencies — cannot resolve currencyId',
      { context: { uid: t.uid, mode } },
    );
  }

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
