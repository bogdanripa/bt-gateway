/**
 * GET    /api/ui/creds/:mode   → { set: boolean, username?: string, updatedAt?: string }
 *    Returns metadata only — NEVER the password, and NEVER the raw username.
 *    We echo a redacted form of the username (first 2 + last 2 chars) so the
 *    user can recognize which login they stored without ever exposing it in
 *    full over the wire to the browser.
 *
 * PUT    /api/ui/creds/:mode   → { username, password } → stored encrypted
 *    Wipes any persisted session for this mode so the next API call re-logs in.
 *
 * DELETE /api/ui/creds/:mode   → removes creds AND the session for this mode.
 */

import { z } from 'zod';
import { requireFirebaseUser } from '@/lib/auth/session';
import {
  getBtCreds,
  setBtCreds,
  deleteBtCreds,
  deleteBtSession,
  type BtMode,
} from '@/lib/store';
import { encrypt, decrypt } from '@/lib/secret-box';
import { ApiError } from '@/lib/errors';
import { audit } from '@/lib/events';
import { ok, withRoute } from '@/lib/route-handler';
import { evictBtClient } from '@/lib/bt/client-pool';
import { evictEvaluationCurrency } from '@/lib/bt/currency';
import { evictMarkets } from '@/lib/bt/markets-cache';
import { evictPortfolioKey } from '@/lib/bt/portfolio-key';
import { defaultNtfyTopic } from '@bogdanripa/bt-trade';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseMode(raw: string): BtMode {
  if (raw !== 'demo' && raw !== 'live') {
    throw new ApiError('BAD_REQUEST', 'mode must be "demo" or "live"');
  }
  return raw;
}

function redact(s: string): string {
  if (!s) return '';
  if (s.length <= 4) return s[0] + '…' + s[s.length - 1];
  return `${s.slice(0, 2)}…${s.slice(-2)}`;
}

const PutSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

export const GET = withRoute<{ mode: string }>(async (req, { params }) => {
  const caller = await requireFirebaseUser(req);
  const mode = parseMode(params.mode);
  const doc = await getBtCreds(caller.tenant, mode);
  if (!doc) return ok({ mode, set: false });
  const username = await decrypt(doc.usernameCipher).catch(() => '');
  const ntfyTopic = username ? defaultNtfyTopic(username) : null;
  return ok({
    mode,
    set: true,
    usernameRedacted: redact(username),
    updatedAt: doc.updatedAt,
    ntfyTopic,
    ntfyUrl: ntfyTopic ? `https://ntfy.sh/${ntfyTopic}` : null,
  });
});

export const PUT = withRoute<{ mode: string }>(async (req, { params, requestId }) => {
  const caller = await requireFirebaseUser(req);
  const mode = parseMode(params.mode);
  const parsed = PutSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('BAD_REQUEST', 'Invalid body', { context: { issues: parsed.error.issues } });
  }

  const { username, password } = parsed.data;
  const [u, p] = await Promise.all([encrypt(username), encrypt(password)]);
  // Key version from `encrypt()` is echoed on the doc for future-proofing
  // (key rotation tracking). Both ciphers come from the same key so we store
  // one version — they're produced back-to-back.
  await setBtCreds(caller.tenant, {
    mode,
    usernameCipher: u.ciphertext,
    passwordCipher: p.ciphertext,
    keyVersion: u.keyVersion,
    updatedAt: new Date().toISOString(),
  });

  // Credentials changed → drop any persisted session, in-memory client, and
  // every BT-session-scoped cache (portfolio key, evaluation currency id,
  // markets list). All of them are keyed to a specific session snapshot, so
  // a fresh login under different creds must not reuse them.
  await deleteBtSession(caller.tenant, mode).catch(() => { /* best-effort */ });
  evictBtClient(caller.tenant, mode);
  evictPortfolioKey(caller.tenant, mode);
  evictEvaluationCurrency(caller.tenant, mode);
  evictMarkets(caller.tenant, mode);

  await audit({
    tenant: caller.tenant,
    type: 'creds.updated',
    actor: 'user',
    mode,
    status: 'ok',
    requestId,
    detail: { usernameRedacted: redact(username) },
  });

  return ok({ mode, set: true });
});

export const DELETE = withRoute<{ mode: string }>(async (req, { params, requestId }) => {
  const caller = await requireFirebaseUser(req);
  const mode = parseMode(params.mode);
  // Delete creds, session, and evict clients.
  await deleteBtCreds(caller.tenant, mode).catch(() => { /* already gone */ });
  await deleteBtSession(caller.tenant, mode).catch(() => { /* best-effort */ });
  evictBtClient(caller.tenant, mode);
  evictPortfolioKey(caller.tenant, mode);
  evictEvaluationCurrency(caller.tenant, mode);
  evictMarkets(caller.tenant, mode);

  await audit({
    tenant: caller.tenant,
    type: 'creds.updated',
    actor: 'user',
    mode,
    status: 'ok',
    requestId,
    detail: { action: 'deleted' },
  });

  return ok({ mode, set: false });
});
