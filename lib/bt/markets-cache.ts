/**
 * In-memory `markets.list()` cache.
 *
 * Consumed by two paths:
 *
 *   1. Filter matching: record.MarketId → canonical exchange name, so we
 *      can compare against the user's filter (e.g. "BVB") when BT's
 *      `record.Market` surfaces a segment-level code like "REGS".
 *   2. UI autocomplete (/api/ui/lookup/markets): reshaped `{ code, label }[]`
 *      so the settings page doesn't hit BT on every keystroke.
 *
 * The nomenclature barely changes — cached for the lifetime of the Cloud Run
 * instance, one bundle per (uid, mode). A single in-flight promise dedupes
 * concurrent callers so we only hit BT once on cold start.
 */

import 'server-only';
import type { BTTradeClient } from '@bogdanripa/bt-trade';
import type { BtMode, TenantRef } from '../firestore';

export interface MarketOption {
  code: string;
  label: string;
}

export interface MarketsBundle {
  /** Canonical-name map, keyed by the exchange id. */
  byId: Map<number, string>;
  /** Reshaped list for UI autocomplete, deduped by code, stable order. */
  options: MarketOption[];
  /** Raw upstream response, exposed for callers that need fields we don't surface. */
  raw: unknown;
}

const cache = new Map<string, Promise<MarketsBundle>>();

function cacheKey(t: TenantRef, mode: BtMode): string {
  return `${t.uid}:${mode}`;
}

function pickStr(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

async function loadMarketsBundle(client: BTTradeClient): Promise<MarketsBundle> {
  const raw = await client.markets.list();
  const byId = new Map<number, string>();
  const options: MarketOption[] = [];
  const seenCodes = new Set<string>();

  if (!Array.isArray(raw)) return { byId, options, raw };

  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const o = m as Record<string, unknown>;

    const rawId = o.id ?? o.Id ?? o.ID;
    const id = typeof rawId === 'number' ? rawId
      : typeof rawId === 'string' && rawId.trim() ? Number(rawId)
      : NaN;

    // `name`/`key` carry the short code BT uses on records (BVB, XETRA, US…);
    // `description` is the long human name ("Bursa de Valori Bucuresti").
    const code = pickStr(o, 'name', 'Name', 'key', 'Key', 'code', 'Code');
    const desc = pickStr(o, 'description', 'Description');

    if (Number.isFinite(id) && code) byId.set(id as number, code);

    if (code && !seenCodes.has(code)) {
      seenCodes.add(code);
      options.push({ code, label: desc && desc !== code ? `${code} — ${desc}` : code });
    }
  }

  return { byId, options, raw };
}

export function getMarkets(
  t: TenantRef,
  mode: BtMode,
  client: BTTradeClient,
): Promise<MarketsBundle> {
  const k = cacheKey(t, mode);
  const existing = cache.get(k);
  if (existing) return existing;
  const p = loadMarketsBundle(client).catch((e) => {
    // On failure, drop the cached promise so the next caller re-tries rather
    // than getting the rejection forever.
    cache.delete(k);
    throw e;
  });
  cache.set(k, p);
  return p;
}

/** Convenience shortcut when only the id → name map is needed. */
export async function getMarketsCache(
  t: TenantRef,
  mode: BtMode,
  client: BTTradeClient,
): Promise<Map<number, string>> {
  return (await getMarkets(t, mode, client)).byId;
}

export function evictMarkets(t: TenantRef, mode: BtMode): void {
  cache.delete(cacheKey(t, mode));
}

export function _resetMarketsCache(): void {
  cache.clear();
}
