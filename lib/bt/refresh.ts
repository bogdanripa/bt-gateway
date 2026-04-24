/**
 * Lightweight session refresher for the 45-min cron.
 *
 * Unlike `getBtClient()`, this path never triggers a fresh `login()`. If a
 * tenant's refresh token has expired server-side there's nothing the cron
 * can do — a new login requires an SMS OTP which only the user can supply.
 * The cron audits + Telegrams the failure and moves on.
 *
 * Semantics:
 *   - No stored session for (uid, mode) → skip (nothing to refresh).
 *   - Session exists, refresh succeeds → persist new snapshot, audit 'ok'.
 *   - Session exists, refresh fails → audit 'err', Telegram alert, clear
 *     both the stored snapshot AND the in-memory pool entry so the next
 *     user-initiated API call retries via full login.
 */

import 'server-only';
import { BTTradeClient, ntfyOtpProvider, defaultNtfyTopic, type SessionSnapshot } from '@bogdanripa/bt-trade';
import {
  getBtCreds,
  getBtSession,
  setBtSession,
  deleteBtSession,
  listActiveTenantUids,
  tenantFromAuthedUid,
  type BtMode,
  type TenantRef,
} from '../firestore';
import { decrypt } from '../kms';
import { audit } from '../events';
import { notifyTenant } from '../telegram';
import { disableAutoRefresh, evictBtClient } from './client-pool';

/**
 * If the current refresh token still has more headroom than this, the cron
 * skips refreshing — refreshing "just because" rotates the RT for no reason
 * and opens the door to concurrent-consumer races with user traffic. With
 * BT's 4-hour RT lifetime, this means we typically refresh once every
 * ~3h20m when idle, and not at all when user traffic is keeping the session
 * warm via the transport's 401-retry.
 */
const CRON_REFRESH_WINDOW_MS = 40 * 60 * 1000;

interface RefreshOne {
  uid: string;
  mode: BtMode;
  status: 'skipped' | 'ok' | 'err';
  message?: string;
}

export async function refreshTenantMode(
  t: TenantRef,
  mode: BtMode,
  requestId?: string,
): Promise<RefreshOne> {
  const session = await getBtSession(t, mode);
  if (!session?.snapshot) {
    return { uid: t.uid, mode, status: 'skipped', message: 'no session' };
  }

  // Headroom skip: if the RT still has plenty of time left, don't refresh.
  // BT's refresh tokens are single-use — each refresh rotates. Rotating
  // "just because" on a cron tick risks invalidating an RT that a
  // concurrent user call is about to use (or has just used).
  const snap = session.snapshot as SessionSnapshot;
  if (snap.refreshTokenExpires) {
    const expMs = new Date(snap.refreshTokenExpires).getTime();
    if (!Number.isNaN(expMs)) {
      const remainMs = expMs - Date.now();
      if (remainMs > CRON_REFRESH_WINDOW_MS) {
        const mins = Math.round(remainMs / 60_000);
        return {
          uid: t.uid,
          mode,
          status: 'skipped',
          message: `refresh token valid for ${mins}m (>${CRON_REFRESH_WINDOW_MS / 60_000}m headroom)`,
        };
      }
    }
  }

  // Build a throwaway client just for the refresh. No OTP provider is ever
  // invoked (refresh() doesn't prompt) but we pass a no-op one so the client
  // doesn't try to touch stdin/ntfy if something unexpected happens.
  const creds = await getBtCreds(t, mode);
  const username = creds ? await decrypt(creds.usernameCipher).catch(() => '') : '';
  const otpProvider = ntfyOtpProvider({
    topic: username ? defaultNtfyTopic(username) : 'bt-gateway-cron-dummy',
    timeoutMs: 1_000, // we never expect to enter this path from cron
  });

  // The throwaway client used in this path ONLY does a refresh — no portfolio
  // calls, no order placement. When BT_REFRESH_DEBUG=1 we enable bt-trade's
  // unredacted transport logging and forward http:request/http:response as
  // structured Cloud Logging lines (full URL, method, headers, body). That
  // captures refresh_token values in plaintext — gated behind the env flag so
  // normal production runs don't leak tokens to Cloud Logging (a separate IAM
  // trust boundary from the KMS-encrypted Firestore snapshot).
  //
  // Turn on when diagnosing a refresh issue via:
  //   gcloud run services update bt-gateway \
  //     --update-env-vars BT_REFRESH_DEBUG=1 --region=$GCP_REGION
  // and turn off again with --remove-env-vars BT_REFRESH_DEBUG.
  const refreshDebug = process.env.BT_REFRESH_DEBUG === '1';
  const client = new BTTradeClient({
    demo: mode === 'demo',
    otpProvider,
    timeoutMs: 20_000,
    ...(refreshDebug
      ? {
          debug: true,
          log: (msg, data) => {
            if (msg !== 'http:request' && msg !== 'http:response') return;
            console.log(JSON.stringify({
              severity: 'INFO',
              msg: `bt.refresh.${msg.split(':')[1]}`,
              uid: t.uid,
              mode,
              requestId,
              data,
            }));
          },
        }
      : {}),
    onSessionChange: async (snap) => {
      if (snap) await setBtSession(t, mode, snap).catch(() => { /* best-effort */ });
    },
  });

  // Kill bt-trade's internal auto-refresh timer on this throwaway. Without
  // this, the timer keeps the client alive past this cron tick and later
  // fires with the now-stale refresh_token it had in memory, racing other
  // refresh paths and producing 'invalid_grant' zombies.
  disableAutoRefresh(client);

  try {
    client.restore(session.snapshot as SessionSnapshot);
  } catch (e) {
    return { uid: t.uid, mode, status: 'err', message: `restore failed: ${(e as Error).message}` };
  }

  const auth = (client as unknown as { auth: { refresh(): Promise<void> } }).auth;

  try {
    await auth.refresh();
  } catch (e) {
    const msg = (e as Error).message || 'refresh failed';
    await audit({
      tenant: t,
      type: 'refresh.failure',
      actor: 'cron',
      mode,
      status: 'err',
      requestId,
      error: { code: 'REFRESH_FAILED', message: msg },
    });
    // Session is dead — drop it so the next user call re-logs in via OTP.
    await deleteBtSession(t, mode).catch(() => { /* best-effort */ });
    evictBtClient(t, mode);
    await notifyTenant(
      t,
      `bt-gateway: ${mode} refresh failed (${msg}). The session was cleared; ` +
        `the next request will require a fresh SMS OTP via ntfy.`,
    );
    return { uid: t.uid, mode, status: 'err', message: msg };
  }

  await audit({
    tenant: t,
    type: 'refresh.success',
    actor: 'cron',
    mode,
    status: 'ok',
    requestId,
  });
  // No Telegram on success — per "don't message me every 45 minutes".
  return { uid: t.uid, mode, status: 'ok' };
}

/**
 * Walk every tenant that has any stored BT session and refresh each
 * (uid, mode) pair it owns. Errors never halt the walk — we want to
 * keep refreshing everyone else's sessions even if one tenant is broken.
 */
export async function refreshAllTenants(requestId?: string): Promise<RefreshOne[]> {
  const uids = await listActiveTenantUids();
  const results: RefreshOne[] = [];
  for (const uid of uids) {
    const t = tenantFromAuthedUid(uid);
    for (const mode of ['demo', 'live'] as BtMode[]) {
      try {
        const r = await refreshTenantMode(t, mode, requestId);
        results.push(r);
      } catch (e) {
        // Defensive — refreshTenantMode already catches, but a bug there
        // must not stop the whole cron.
        results.push({ uid, mode, status: 'err', message: (e as Error).message });
      }
    }
  }
  return results;
}
