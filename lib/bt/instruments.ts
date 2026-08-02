/**
 * Search-instrument resolution shared by POST /orders, POST /orders/preview,
 * and GET /instruments/:symbol.
 *
 * All three endpoints do the same thing: accept an optional marketId, call
 * `client.markets.searchInstrument(symbol)`, then either pick the hit whose
 * marketId matches the caller's override or take the first hit. They also
 * all then enforce the filter against the resolved hit's market + currency.
 *
 * The `Hit` shape is what `searchInstrument` returns per the package's
 * README: `[{ code, marketId, market, currency, name, exchange, isin }]`.
 * We only surface the fields we actually need downstream.
 */

import type { BTTradeClient } from '@bogdanripa/bt-trade';
import { ApiError } from '../errors';

export interface ResolvedInstrument {
  code: string;
  marketId: string | number;
  market?: string;
  currency?: string;
}

/** Minimal shape used by this helper; not the full BT hit record. */
interface Hit {
  code?: string;
  marketId?: string | number;
  market?: string;
  currency?: string;
}

/**
 * Resolve a symbol to a concrete (code, marketId, market, currency) tuple
 * by calling searchInstrument.
 *
 * - With `overrideMarketId`: picks the hit whose marketId matches. Throws
 *   NOT_FOUND if the symbol exists but no hit matches that marketId.
 * - Without: picks the first hit (mirrors the BT web UI).
 *
 * Throws NOT_FOUND when the symbol has no hits at all, and
 * UPSTREAM_UNAVAILABLE if a hit is returned without a marketId (defensive;
 * shouldn't happen in practice).
 */
export async function resolveInstrument(
  client: BTTradeClient,
  symbol: string,
  overrideMarketId?: string | number | null,
  marketsCache?: Map<number, string>,
): Promise<ResolvedInstrument> {
  const hits = (await client.markets.searchInstrument(symbol)) as Hit[];
  if (!Array.isArray(hits) || hits.length === 0) {
    throw new ApiError('NOT_FOUND', `Instrument not found: ${symbol}`);
  }
  const pick = overrideMarketId != null && overrideMarketId !== ''
    ? hits.find((h) => String(h.marketId) === String(overrideMarketId))
    : hits[0];
  if (!pick) {
    throw new ApiError(
      'NOT_FOUND',
      `Instrument ${symbol} not listed on marketId=${overrideMarketId}`,
    );
  }
  if (pick.marketId === undefined || pick.marketId === null) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', 'searchInstrument hit missing marketId');
  }

  // Canonicalize the market via the id → exchange-name map when available:
  // hits can carry a segment-level code (e.g. "REGS" for the BVB regulated
  // segment) while per-key filters are configured with the parent exchange
  // code ("BVB"). MarketId is stable across segments, so it wins.
  let market = pick.market;
  if (marketsCache) {
    const mid = Number(pick.marketId);
    const canonical = Number.isFinite(mid) ? marketsCache.get(mid) : undefined;
    if (canonical) market = canonical;
  }

  return {
    code: pick.code ?? symbol,
    marketId: pick.marketId,
    market,
    currency: pick.currency,
  };
}
