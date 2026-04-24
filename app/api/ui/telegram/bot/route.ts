/**
 * GET    /api/ui/telegram/bot
 * PUT    /api/ui/telegram/bot   { token: string }
 * DELETE /api/ui/telegram/bot
 *
 * Per-user Telegram bot configuration. The user pastes a bot token from
 * @BotFather; the server probes Telegram's getMe endpoint to:
 *   1. Confirm the token is valid (bad tokens would make every later
 *      sendMessage silently no-op).
 *   2. Pull the canonical @username so we don't have to ask the user.
 * Then it encrypts the token (KMS envelope) and persists alongside a
 * freshly-minted webhookSecret.
 *
 * We NEVER return the token on GET — only presence + username + the
 * webhook URL the user must point Telegram at. The UI shows a copy-paste
 * `setWebhook` curl command using the returned URL.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { NextResponse } from 'next/server';
import { requireFirebaseUser } from '@/lib/auth/session';
import {
  getTelegramBot,
  setTelegramBot,
  deleteTelegramBot,
  clearTelegramLink,
} from '@/lib/firestore';
import { ApiError } from '@/lib/errors';
import { ok, withRoute } from '@/lib/route-handler';
import { decrypt, encrypt } from '@/lib/kms';
import { getBotProfile, getWebhookInfo, setWebhook } from '@/lib/telegram-bot';
import { audit } from '@/lib/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PutBody = z.object({
  token: z
    .string()
    .trim()
    .min(20, 'token is too short')
    .max(200, 'token is too long'),
});

function webhookUrl(req: Request, secret: string): string {
  // Prefer an explicit override (useful for custom domains).
  const configured = process.env.BT_GATEWAY_PUBLIC_URL?.replace(/\/+$/, '');
  if (configured) return `${configured}/api/v1/telegram/webhook/${secret}`;

  // req.url on Cloud Run is the internal container address (0.0.0.0:8080).
  // The real public hostname comes from x-forwarded-host (set by the Google
  // Front End) or the Host header. Fall back to req.url only in local dev.
  const headers = req.headers as Headers;
  const host =
    headers.get('x-forwarded-host') ??
    headers.get('host') ??
    new URL(req.url).host;
  const proto =
    headers.get('x-forwarded-proto')?.split(',')[0].trim() ?? 'https';
  return `${proto}://${host}/api/v1/telegram/webhook/${secret}`;
}

export const GET = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const bot = await getTelegramBot(caller.tenant);
  if (!bot) return ok({ configured: false });
  const expectedUrl = webhookUrl(req, bot.webhookSecret);

  // Ask Telegram what it thinks about the webhook so the UI can show whether
  // Telegram has the URL we expect and surface last-delivery errors. The
  // token is decrypted only in-memory and never returned in the response.
  const token = await decrypt(bot.tokenCipher).catch(() => '');
  const webhookInfo = token ? await getWebhookInfo(token) : null;

  return ok({
    configured: true,
    username: bot.username,
    webhookUrl: expectedUrl,
    updatedAt: bot.updatedAt,
    webhookInfo: webhookInfo
      ? {
          url: webhookInfo.url,
          matches: webhookInfo.url === expectedUrl,
          pendingUpdateCount: webhookInfo.pendingUpdateCount,
          lastErrorDate: webhookInfo.lastErrorDate,
          lastErrorMessage: webhookInfo.lastErrorMessage,
          ipAddress: webhookInfo.ipAddress,
        }
      : null,
  });
});

export const PUT = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const body = PutBody.parse(await req.json().catch(() => ({})));

  // Verify the token with Telegram before storing anything.
  const profile = await getBotProfile(body.token);
  if (!profile) {
    throw new ApiError(
      'UPSTREAM_UNAVAILABLE',
      'Telegram did not accept that token. Double-check you copied the full token from @BotFather.',
    );
  }

  // Preserve the existing webhookSecret when replacing the token so the
  // user doesn't have to re-run setWebhook just to rotate a token.
  const existing = await getTelegramBot(caller.tenant);
  const webhookSecret = existing?.webhookSecret ?? crypto.randomBytes(24).toString('base64url');

  const { ciphertext, keyVersion } = await encrypt(body.token);
  const now = new Date().toISOString();
  await setTelegramBot(caller.tenant, {
    _type: 'telegram_bot',
    username: profile.username,
    tokenCipher: ciphertext,
    keyVersion,
    webhookSecret,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  // If the bot @handle changed (user swapped to a different bot), clear
  // any stale chat link — the old link points to a chat on a bot that is
  // no longer ours.
  if (existing && existing.username !== profile.username) {
    await clearTelegramLink(caller.tenant).catch(() => { /* best-effort */ });
  }

  // Register the webhook with Telegram automatically — no manual curl needed.
  const wUrl = webhookUrl(req, webhookSecret);
  const webhookOk = await setWebhook(body.token, wUrl);

  await audit({
    tenant: caller.tenant,
    type: 'telegram.linked',
    actor: 'user',
    status: 'ok',
    detail: {
      step: 'bot_configured',
      username: profile.username,
      rotated: !!existing,
      webhookRegistered: webhookOk,
    },
  });

  return ok({
    configured: true,
    username: profile.username,
    webhookUrl: wUrl,
    webhookRegistered: webhookOk,
    updatedAt: now,
  });
});

export const DELETE = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  await deleteTelegramBot(caller.tenant);
  // Also drop the chat link — without a bot, there's no way to message the
  // user anyway, and leaving a stale chatId would be confusing.
  await clearTelegramLink(caller.tenant).catch(() => { /* best-effort */ });
  await audit({
    tenant: caller.tenant,
    type: 'telegram.unlinked',
    actor: 'user',
    status: 'ok',
    detail: { step: 'bot_removed' },
  });
  return NextResponse.json({ ok: true });
});
