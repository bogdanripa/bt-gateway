/**
 * API key generation + verification.
 *
 * Format: `bvb_<mode>_<24 chars base62>` — e.g. `bvb_demo_Rq3k7Zp9ab4C1N2tL5M8yEwr`.
 *
 * The mode prefix is load-bearing: the verification layer enforces that a
 * `bvb_demo_` key can only hit demo sessions, `bvb_live_` only live. A
 * compromised demo key cannot cause real-money orders.
 *
 * Storage: we store SHA-256(fullKey) and a short prefix (for UI
 * identification). The raw key is shown to the user exactly once, at
 * creation. We never log it and it never leaves the creation response.
 *
 * Verification is constant-time via timingSafeEqual to avoid leaking
 * information via response-time differences.
 */

import 'server-only';
import crypto from 'node:crypto';
import { ApiError } from '../errors';
import {
  findApiKeyByHash,
  listApiKeys,
  touchApiKey,
  type ApiKeyFilters,
  type BtMode,
  type TenantRef,
  tenantFromAuthedUid,
} from '../store';
import { checkRateLimit } from '../rate-limit';
import type { NextRequest } from 'next/server';

const PREFIX_DEMO = 'bvb_demo_';
const PREFIX_LIVE = 'bvb_live_';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomBase62(length: number): string {
  const buf = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += BASE62[buf[i] % 62];
  return out;
}

export function generateApiKey(mode: BtMode): { key: string; hash: string; prefix: string } {
  const prefix = mode === 'demo' ? PREFIX_DEMO : PREFIX_LIVE;
  const tail = randomBase62(24);
  const key = prefix + tail;
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return {
    key,
    hash,
    // prefix we store for UI identification (first 12 chars — enough to
    // disambiguate, small enough not to be useful for guessing).
    prefix: key.slice(0, 12),
  };
}

function modeFromKey(raw: string): BtMode | null {
  if (raw.startsWith(PREFIX_DEMO)) return 'demo';
  if (raw.startsWith(PREFIX_LIVE)) return 'live';
  return null;
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function hashKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Parse `Authorization: Bearer <key>` (or `X-Api-Key`) and return the raw key.
 * Returns null if absent.
 */
export function extractApiKey(req: NextRequest): string | null {
  const auth = req.headers.get('authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  const alt = req.headers.get('x-api-key');
  return alt?.trim() || null;
}

export interface AuthenticatedCaller {
  tenant: TenantRef;
  mode: BtMode;
  keyId: string;
  /** Per-key filters. Undefined for keys created before the feature shipped. */
  filters?: ApiKeyFilters;
  /**
   * Permission scope. Legacy keys with no `access` field default to `rw`.
   * Mutating routes (e.g. POST /api/v1/orders) reject `read` callers.
   */
  access: 'read' | 'rw';
}

/**
 * Find the tenant + key record that matches this raw key and return the
 * authenticated caller. Throws ApiError on any failure path.
 *
 * One indexed point-read on the UNIQUE `hash` column resolves the bearer to
 * its owning row. Under Firestore this needed a hand-maintained root-level
 * `key_hashes` index doc plus a collectionGroup scan to cover keys the index
 * had missed; a real unique index makes both disappear.
 *
 * The mode carried in the key's prefix must match the mode stored on the row.
 * That check is what stops a `bvb_demo_` bearer from ever reaching live.
 */
export async function authenticateApiKey(raw: string): Promise<AuthenticatedCaller> {
  const mode = modeFromKey(raw);
  if (!mode) throw new ApiError('UNAUTHORIZED', 'API key format invalid');
  const expectedHash = hashKey(raw);

  const keyDoc = await findApiKeyByHash(expectedHash);
  if (!keyDoc || keyDoc.revokedAt || keyDoc.mode !== mode) {
    throw new ApiError('UNAUTHORIZED', 'API key not recognized');
  }
  // Constant-time re-check of the value we looked up by. The lookup itself is
  // an equality match the database resolved, so this guards against a row
  // whose stored hash drifted from its key rather than against timing.
  if (!timingSafeEqualStrings(keyDoc.hash, expectedHash)) {
    throw new ApiError('UNAUTHORIZED', 'API key not recognized');
  }

  const tenant = tenantFromAuthedUid(keyDoc.uid);
  return finalizeAuth(tenant, mode, keyDoc.id, keyDoc.filters, keyDoc.access);
}

function finalizeAuth(
  tenant: TenantRef,
  mode: BtMode,
  keyId: string,
  filters: ApiKeyFilters | undefined,
  access: 'read' | 'rw' | undefined,
): AuthenticatedCaller {
  // Rate limit per key.
  const rl = checkRateLimit(`apikey:${keyId}`);
  if (!rl.ok) {
    throw new ApiError('RATE_LIMITED', 'Too many requests', {
      context: { retryAfterSec: rl.retryAfterSec, kid: keyId },
    });
  }

  // Fire-and-forget touch so the "last used" column updates. Awaiting
  // would add ~50ms to every authed call; we don't need it to block.
  void touchApiKey(tenant, keyId).catch(() => { /* swallow */ });

  return { tenant, mode, keyId, filters, access: access ?? 'rw' };
}

/**
 * Extract + authenticate in one step. Use this at the top of every
 * `/api/v1/*` route handler.
 */
export async function requireApiKey(req: NextRequest): Promise<AuthenticatedCaller> {
  const raw = extractApiKey(req);
  if (!raw) throw new ApiError('UNAUTHORIZED', 'Missing API key');
  return authenticateApiKey(raw);
}

/**
 * Reject read-only callers from mutating routes. Call at the top of every
 * POST/PUT/PATCH/DELETE handler after `requireApiKey`.
 */
export function assertWriteAccess(caller: AuthenticatedCaller): void {
  if (caller.access !== 'rw') {
    throw new ApiError('FORBIDDEN', 'This API key is read-only');
  }
}

// Re-export for UI pages that need the shape.
export { PREFIX_DEMO, PREFIX_LIVE };
export const _internals = { listApiKeys }; // only used by tests + the API-key UI
