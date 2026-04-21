/**
 * Simple in-memory sliding-window rate limiter.
 *
 * 60 requests/minute per API key is the default. At our volume (1 user, maybe
 * a handful of others later) an in-memory counter on the single always-warm
 * Cloud Run instance is fine. When we scale past min-instances=1 we'll need
 * to move this to Redis or rely on request counters in Firestore — but that's
 * M-something-later, not now.
 *
 * The window is a simple "bucket of timestamps" approach: we keep the last N
 * request timestamps per key; on each call we drop ones older than the
 * window and reject if the count is at the cap.
 *
 * Cold-start note: after a cold start the map is empty, so a key gets its
 * full budget from t=0. This is the intended behavior — we're protecting
 * the upstream broker from runaway loops, not strictly enforcing a quota.
 */

import 'server-only';

const WINDOW_MS = 60_000;
const DEFAULT_MAX = 60;

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();

/**
 * Throw-style rate limit check. Returns { ok } or throws is wrong shape for
 * route handlers that want to short-circuit with a 429. Route handlers should
 * use `checkRateLimit()` and return an ApiError on denial.
 */
export function checkRateLimit(
  key: string,
  opts: { max?: number } = {},
): { ok: true } | { ok: false; retryAfterSec: number } {
  const max = opts.max ?? DEFAULT_MAX;
  const now = Date.now();
  const bucket = buckets.get(key) ?? { timestamps: [] };
  // Drop timestamps older than the window.
  const cutoff = now - WINDOW_MS;
  let drop = 0;
  while (drop < bucket.timestamps.length && bucket.timestamps[drop] < cutoff) drop++;
  if (drop > 0) bucket.timestamps.splice(0, drop);

  if (bucket.timestamps.length >= max) {
    const oldest = bucket.timestamps[0];
    const retryAfterSec = Math.ceil((oldest + WINDOW_MS - now) / 1000);
    return { ok: false, retryAfterSec: Math.max(1, retryAfterSec) };
  }

  bucket.timestamps.push(now);
  buckets.set(key, bucket);
  return { ok: true };
}

/** For tests. */
export function _resetRateLimiter(): void {
  buckets.clear();
}
