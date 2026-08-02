/**
 * Portfolio-key resolution.
 *
 * Every portfolio / orders call in bt-trade takes a `portfolioKey`, which is
 * per-account. We resolve it by calling `client.accounts.list()` and picking:
 *   1. The `selected` account (matches the BT web UI's current selection), or
 *   2. The first account with `allowTrading` true, or
 *   3. The first account, or
 *   4. null → we throw UPSTREAM_UNAVAILABLE.
 *
 * We cache the resolved key per (uid, mode) in memory for the lifetime of the
 * Cloud Run instance. If the user switches accounts upstream we'll stick with
 * the old key until the instance recycles — acceptable because almost no one
 * changes their primary trading account day-to-day.
 */

import 'server-only';
import { ApiError } from '../errors';
import type { BTTradeClient } from '@bogdanripa/bt-trade';
import type { BtMode, TenantRef } from '../store';

const cache = new Map<string, string>();

function key(t: TenantRef, mode: BtMode): string {
  return `${t.uid}:${mode}`;
}

export async function getPortfolioKey(
  t: TenantRef,
  mode: BtMode,
  client: BTTradeClient,
): Promise<string> {
  const k = key(t, mode);
  const hit = cache.get(k);
  if (hit) return hit;

  const accounts = await client.accounts.list();
  const pick =
    accounts.find((a) => a.selected) ??
    accounts.find((a) => a.allowTrading) ??
    accounts[0];
  if (!pick?.portfolioKey) {
    throw new ApiError(
      'UPSTREAM_UNAVAILABLE',
      'No tradable account found for this session',
      { context: { uid: t.uid, mode, accountsCount: accounts.length } },
    );
  }
  cache.set(k, pick.portfolioKey);
  return pick.portfolioKey;
}

export function evictPortfolioKey(t: TenantRef, mode: BtMode): void {
  cache.delete(key(t, mode));
}

export function _resetPortfolioKeyCache(): void {
  cache.clear();
}
