/**
 * In-memory `reference.listOrderStatuses()` cache + resolver.
 *
 * Exists because `criteria.statuses` on BT's `Orders/Search` is a list of
 * *server-known status codes*, not free text. Sending anything else — the
 * English words the MCP tool used to advertise, for instance — makes BT
 * reject the whole request with HTTP 400, which the gateway then reported as
 * `UPSTREAM_UNAVAILABLE`. The symptom was `list_orders` 502-ing while every
 * other BT-backed route was healthy.
 *
 * We do not hardcode the vocabulary. BT publishes it at
 * `Nomenclatures/GetOrderStatuses`, and an order's own `status` field is a
 * `{ id, name }` pair from that same list, so resolving against it at runtime
 * is both correct and self-documenting: the error message for an unknown
 * value can enumerate what BT actually accepts, in BT's own wording.
 *
 * The nomenclature barely changes — cached for the container's lifetime, one
 * per (uid, mode), with a single in-flight promise deduping concurrent
 * callers. Loaded lazily and ONLY when a caller supplies `statuses`, so the
 * common unfiltered listing never pays for a call it does not need.
 */

import type { BTTradeClient } from '@bogdanripa/bt-trade';
import { ApiError } from '../errors';
import type { BtMode, TenantRef } from '../store';

export interface OrderStatusOption {
  id: number;
  name: string;
}

export interface OrderStatusBundle {
  /** Stable order, as BT returned it. */
  options: OrderStatusOption[];
  /** Upper-cased name → id, for resolving caller-supplied names. */
  byName: Map<string, number>;
  /** Every known id, for accepting a caller who already passes ids. */
  ids: Set<number>;
}

const cache = new Map<string, Promise<OrderStatusBundle>>();

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

function pickNum(o: Record<string, unknown>, ...keys: string[]): number | undefined {
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

async function loadOrderStatuses(client: BTTradeClient): Promise<OrderStatusBundle> {
  const raw = await client.reference.listOrderStatuses();
  const options: OrderStatusOption[] = [];
  const byName = new Map<string, number>();
  const ids = new Set<number>();

  // Casing varies across BT's nomenclature endpoints (camelCase on some,
  // PascalCase on others), so probe both rather than assume.
  if (Array.isArray(raw)) {
    for (const s of raw) {
      if (!s || typeof s !== 'object') continue;
      const o = s as Record<string, unknown>;
      const id = pickNum(o, 'id', 'Id', 'ID', 'statusId', 'StatusId');
      const name = pickStr(o, 'name', 'Name', 'description', 'Description', 'label', 'Label');
      if (id === undefined || !name) continue;
      options.push({ id, name });
      byName.set(name.toUpperCase(), id);
      ids.add(id);
    }
  }

  return { options, byName, ids };
}

export function getOrderStatuses(
  t: TenantRef,
  mode: BtMode,
  client: BTTradeClient,
): Promise<OrderStatusBundle> {
  const k = cacheKey(t, mode);
  const existing = cache.get(k);
  if (existing) return existing;
  const p = loadOrderStatuses(client).catch((e) => {
    // Drop the cached promise on failure so the next caller retries rather
    // than inheriting the rejection forever.
    cache.delete(k);
    throw e;
  });
  cache.set(k, p);
  return p;
}

/**
 * Turn caller-supplied status tokens into the ids BT expects.
 *
 * Accepts either a numeric id or a name from the nomenclature
 * (case-insensitive). Anything else throws `BAD_REQUEST` listing what BT
 * actually accepts — the caller's input is wrong, and telling them so is far
 * more useful than forwarding it and relaying BT's opaque 400.
 *
 * If the nomenclature comes back empty (shape we don't recognise), the
 * tokens are passed through untouched rather than rejecting a request we
 * cannot prove is invalid — the previous behaviour, no worse.
 */
export async function resolveOrderStatuses(
  t: TenantRef,
  mode: BtMode,
  client: BTTradeClient,
  tokens: readonly string[],
): Promise<Array<number | string>> {
  const bundle = await getOrderStatuses(t, mode, client);
  if (bundle.options.length === 0) return [...tokens];

  const resolved: number[] = [];
  const unknown: string[] = [];

  for (const token of tokens) {
    const asNum = Number(token);
    if (Number.isFinite(asNum) && bundle.ids.has(asNum)) {
      resolved.push(asNum);
      continue;
    }
    const byName = bundle.byName.get(token.trim().toUpperCase());
    if (byName !== undefined) {
      resolved.push(byName);
      continue;
    }
    unknown.push(token);
  }

  if (unknown.length > 0) {
    const valid = bundle.options.map((o) => `${o.name} (${o.id})`).join(', ');
    throw new ApiError(
      'BAD_REQUEST',
      `Unknown order status${unknown.length > 1 ? 'es' : ''}: ${unknown.join(', ')}. ` +
        `BT accepts these: ${valid}. Omit "statuses" to list every order.`,
      { context: { unknown, valid: bundle.options } },
    );
  }

  return resolved;
}
