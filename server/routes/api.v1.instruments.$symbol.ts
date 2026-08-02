/**
 * GET /api/v1/instruments/:symbol[?marketId=N]
 *
 * Instrument lookup by symbol. Two-step upstream flow:
 *   1. searchInstrument(symbol) → list of listings across markets.
 *   2. getInstrument({ portfolioKey, code, marketId }) → tick payload for one.
 *
 * Response:
 *   {
 *     mode, symbol,
 *     instruments: [{ code, marketId, market, currency, name, ... }, ...],
 *     instrument: { ...tick detail for the picked listing... },
 *     marketId: <the picked listing's marketId>,
 *   }
 *
 * The per-key filter is applied to `searchInstrument` hits: any listing
 * whose market or currency isn't allowed is dropped from `instruments`,
 * and the picked detail obviously has to pass too. If the filter excludes
 * every listing, the response is 403.
 *
 * `?marketId=N` narrows to that single listing (and its detail). If that
 * listing exists upstream but isn't allowed by the filter, we still 403.
 */

import { requireApiKey } from '@/lib/auth/api-key';
import { runWithSession } from '@/lib/bt/client-pool';
import { getMarketsCache } from '@/lib/bt/markets-cache';
import { getPortfolioKey } from '@/lib/bt/portfolio-key';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';
import { assertAllowed, filterRecords, readRecordFields } from '@/lib/filters';


type Hit = { code?: string; marketId?: string | number; market?: string; currency?: string; name?: string };

export const GET = withRoute<{ symbol: string }>(async (req, { params }) => {
  const caller = await requireApiKey(req);
  const symbol = params.symbol?.toUpperCase();
  if (!symbol) throw new ApiError('BAD_REQUEST', 'symbol path segment required');

  // Fast-fail before touching BT when the symbol itself is blocked.
  assertAllowed(caller.filters, { symbol });

  const overrideMarketId = new URL(req.url).searchParams.get('marketId');

  try {
    const { code, marketId, instrument, instruments, marketsCache } = await runWithSession(
      caller.tenant,
      caller.mode,
      async (client) => {
        const [portfolioKey, hits, marketsCache] = await Promise.all([
          getPortfolioKey(caller.tenant, caller.mode, client),
          client.markets.searchInstrument(symbol) as Promise<Hit[]>,
          getMarketsCache(caller.tenant, caller.mode, client),
        ]);
        if (!Array.isArray(hits) || hits.length === 0) {
          throw new ApiError('NOT_FOUND', `Instrument not found: ${symbol}`);
        }

        // Filter the full list of listings by markets + currencies + stocks
        // axes. Threading the markets cache so a hit with {market: "REGS",
        // marketId: 1} canonicalizes to "BVB" for matching. `stocks` was
        // already checked up-front on the raw symbol.
        const read = (r: unknown) => readRecordFields(r, { marketsCache });
        const allowed = filterRecords(hits as unknown[], caller.filters, read) as Hit[];
        if (allowed.length === 0) {
          throw new ApiError(
            'FORBIDDEN',
            `Instrument ${symbol} has no listings accessible under this key's filters`,
            { context: { symbol, totalHits: hits.length } },
          );
        }

        // Pick the listing to fetch detail for. If the caller gave marketId,
        // it must be in the filtered set.
        const pick = overrideMarketId
          ? allowed.find((h) => String(h.marketId) === String(overrideMarketId))
          : allowed[0];
        if (!pick) {
          // Distinguish "listing exists but filter excludes it" (403) from
          // "listing simply doesn't exist at all" (404).
          const existsUnfiltered = hits.some(
            (h) => String(h.marketId) === String(overrideMarketId),
          );
          throw new ApiError(
            existsUnfiltered ? 'FORBIDDEN' : 'NOT_FOUND',
            existsUnfiltered
              ? `Listing ${symbol} on marketId=${overrideMarketId} is blocked by this key's filters`
              : `Instrument ${symbol} not listed on marketId=${overrideMarketId}`,
          );
        }
        if (!pick.marketId) {
          throw new ApiError('UPSTREAM_UNAVAILABLE', 'searchInstrument hit missing marketId');
        }

        const resolvedCode = pick.code ?? symbol;
        const inst = await client.markets.getInstrument({
          portfolioKey,
          code: resolvedCode,
          marketId: pick.marketId,
        });
        return {
          code: resolvedCode,
          marketId: pick.marketId,
          instrument: inst,
          instruments: allowed,
          marketsCache,
        };
      },
    );

    // Belt-and-braces: if the detail payload carries a currency/market field
    // that wasn't visible at search time, re-check it — using the cache so
    // "REGS" on the detail still canonicalizes to "BVB".
    assertAllowed(caller.filters, readRecordFields(instrument, { marketsCache }));

    return ok({
      mode: caller.mode,
      symbol: code,
      marketId,
      instruments,
      instrument,
    });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('UPSTREAM_UNAVAILABLE', `getInstrument failed: ${(e as Error).message}`);
  }
});
