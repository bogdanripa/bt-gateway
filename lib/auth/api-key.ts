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
  listApiKeys,
  touchApiKey,
  type ApiKeyFilters,
  type BtMode,
  type TenantRef,
  tenantFromAuthedUid,
} from '../firestore';
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
}

/**
 * Find the tenant + key record that matches this raw key and return the
 * authenticated caller. Throws ApiError on any failure path.
 *
 * M2 note: this is O(tenants × keys_per_tenant). Acceptable until we have
 * many tenants because key_count will stay small per tenant. When that stops
 * being true we'll add a `key_hashes/{sha256}` index doc that maps hash →
 * (uid, kid) for constant-time lookup. Not doing it now because it adds a
 * write during key creation and a read during auth, and complicates revoke.
 */
export async function authenticateApiKey(raw: string): Promise<AuthenticatedCaller> {
  const mode = modeFromKey(raw);
  if (!mode) throw new ApiError('UNAUTHORIZED', 'API key format invalid');
  const expectedHash = hashKey(raw);

  // Walk active tenants via a collectionGroup query.
  const { getFirestore } = await import('firebase-admin/firestore');
  const { adminApp } = await import('../firebase/admin');
  const db = getFirestore(adminApp());
  const snap = await db.collectionGroup('api_keys').get();

  for (const doc of snap.docs) {
    const data = doc.data() as {
      hash: string;
      mode: BtMode;
      revokedAt?: string;
      filters?: ApiKeyFilters;
    };
    if (data.mode !== mode) continue;
    if (data.revokedAt) continue;
    if (!timingSafeEqualStrings(data.hash, expectedHash)) continue;

    // path: users/{uid}/api_keys/{kid}
    const parts = doc.ref.path.split('/');
    const uid = parts[1];
    const kid = doc.id;
    const tenant = tenantFromAuthedUid(uid);

    // Rate limit per key.
    const rl = checkRateLimit(`apikey:${kid}`);
    if (!rl.ok) {
      throw new ApiError('RATE_LIMITED', 'Too many requests', {
        context: { retryAfterSec: rl.retryAfterSec, kid },
      });
    }

    // Fire-and-forget touch so the "last used" column updates. Awaiting
    // would add ~50ms to every authed call; we don't need it to block.
    void touchApiKey(tenant, kid).catch(() => { /* swallow */ });

    return { tenant, mode, keyId: kid, filters: data.filters };
  }

  throw new ApiError('UNAUTHORIZED', 'API key not recognized');
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

// Re-export for UI pages that need the shape.
export { PREFIX_DEMO, PREFIX_LIVE };
export const _internals = { listApiKeys }; // only used by tests + the API-key UI
