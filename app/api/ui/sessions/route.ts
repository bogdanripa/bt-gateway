/**
 * GET /api/ui/sessions
 *
 * Returns, for each mode (demo + live), the stored BT session metadata and
 * the last-known cached portfolio state. Used by the dashboard to show:
 *   - when the access token expires (short-lived, ~30 min)
 *   - when the refresh token expires (long-lived, ~hours/days)
 *   - the most recent cash + holdings snapshot written by bt_executor status
 *
 * This route does NOT touch BT Trade — it only reads the database. Nothing here
 * is auditable; it's a pure read of our own cached state. Tokens themselves
 * are never returned, only their expiry metadata.
 */

import { requireFirebaseUser } from '@/lib/auth/session';
import { ok, withRoute } from '@/lib/route-handler';
import { getBtSession, getPortfolioState, type BtMode } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SessionInfo {
  mode: BtMode;
  hasSession: boolean;
  sessionUpdatedAt: string | null;
  /** ISO datetime — access token expiry (from bt-trade snapshot.expiresAt, epoch ms). */
  accessTokenExpiresAt: string | null;
  /** ISO datetime — refresh token expiry (from bt-trade snapshot.refreshTokenExpires). */
  refreshTokenExpiresAt: string | null;
  /** Opaque session ID from bt-trade, if present — useful for correlating broker-side logs. */
  sessionId: string | null;
  /** The cached portfolio-state doc that bt_executor writes after each status call. */
  lastKnownState: Record<string, unknown> | null;
}

function toIso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    // Already ISO or parseable — normalize to ISO if possible.
    const t = Date.parse(value);
    return Number.isFinite(t) ? new Date(t).toISOString() : value;
  }
  return null;
}

function pickString(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

async function loadOne(tenant: { uid: string }, mode: BtMode): Promise<SessionInfo> {
  const [sessionDoc, state] = await Promise.all([
    getBtSession(tenant, mode),
    getPortfolioState(tenant, mode),
  ]);

  let accessExp: string | null = null;
  let refreshExp: string | null = null;
  let sessionId: string | null = null;

  if (sessionDoc?.snapshot && typeof sessionDoc.snapshot === 'object') {
    const snap = sessionDoc.snapshot as Record<string, unknown>;
    accessExp = toIso(snap['expiresAt']);
    refreshExp = toIso(snap['refreshTokenExpires']);
    sessionId = pickString(snap, 'sessionId');
  }

  return {
    mode,
    hasSession: !!sessionDoc,
    sessionUpdatedAt: sessionDoc?.updatedAt ?? null,
    accessTokenExpiresAt: accessExp,
    refreshTokenExpiresAt: refreshExp,
    sessionId,
    lastKnownState: state,
  };
}

export const GET = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const [demo, live] = await Promise.all([
    loadOne(caller.tenant, 'demo'),
    loadOne(caller.tenant, 'live'),
  ]);
  return ok({ sessions: [demo, live] });
});
