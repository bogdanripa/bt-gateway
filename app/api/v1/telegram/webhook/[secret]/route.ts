/**
 * POST /api/v1/telegram/webhook/:secret
 *
 * Telegram Bot webhook endpoint. The secret is a path segment so Telegram's
 * POST body carries no auth token and nothing else on the internet can hit
 * the endpoint by guessing a URL. Set the webhook once via:
 *
 *   curl -X POST "https://api.telegram.org/bot$TOKEN/setWebhook" \
 *        -d "url=https://bt-gateway.../api/v1/telegram/webhook/$SECRET"
 *
 * Handles a single command for now: `/start <linkCode>`. The UI generates
 * a short-lived code (stored in users/{uid}/integrations/telegram_pending)
 * and tells the user to send it to the bot. The webhook resolves the code
 * to a uid, writes the permanent `telegram` link doc with the chat_id from
 * the update, deletes the pending doc, and replies to the user.
 *
 * We never 500 — even on errors we 200 with an ok body so Telegram doesn't
 * retry. Errors go to stdout via the access log.
 */

import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { withRoute } from '@/lib/route-handler';
import {
  findPendingTelegramLink,
  clearPendingTelegramLink,
  setTelegramLink,
  tenantFromAuthedUid,
} from '@/lib/firestore';
import { audit } from '@/lib/events';
import { sendMessage } from '@/lib/telegram-bot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: string; username?: string };
  text?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Always respond 200 so Telegram doesn't retry. Any error state is logged
// via console.error + the access log line emitted by `withRoute`.
const okAck = () => NextResponse.json({ ok: true });

export const POST = withRoute<{ secret: string }>(async (req, { params, requestId }) => {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || !params.secret || !timingSafeEqual(params.secret, expected)) {
    // Respond 200 so random pokes don't fan out into Cloud Logging errors,
    // but do nothing. A real Telegram webhook with the wrong secret is
    // basically impossible — we set the URL ourselves.
    return okAck();
  }

  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return okAck();
  }

  const msg = update.message;
  if (!msg?.text || !msg.chat?.id) return okAck();

  const startMatch = msg.text.trim().match(/^\/start(?:\s+(\S+))?/i);
  if (!startMatch) {
    // Unknown command — ignore.
    return okAck();
  }

  const code = startMatch[1];
  const chatId = msg.chat.id;
  const tgUsername = msg.from?.username ?? msg.chat.username;

  if (!code) {
    await sendMessage(
      chatId,
      'Welcome to bt-gateway. To link your account, go to /settings in the web UI, ' +
        'tap "Generate link code", and send it here with /start <code>.',
    );
    return okAck();
  }

  const pending = await findPendingTelegramLink(code).catch(() => null);
  if (!pending) {
    await sendMessage(
      chatId,
      'That link code is invalid or expired. Generate a new one in the web UI ' +
        'and send it within 10 minutes.',
    );
    return okAck();
  }

  const t = tenantFromAuthedUid(pending.uid);
  try {
    await setTelegramLink(t, {
      chatId,
      username: tgUsername,
      linkedAt: new Date().toISOString(),
    });
    await clearPendingTelegramLink(t).catch(() => { /* best-effort */ });
    await audit({
      tenant: t,
      type: 'telegram.linked',
      actor: 'user',
      status: 'ok',
      requestId,
      detail: { chatId, username: tgUsername },
    });
    await sendMessage(
      chatId,
      'Linked. You will get an alert here when bt-gateway signs into BT Trade, ' +
        'or when a sign-in fails. Routine 45-minute refreshes will NOT be announced.',
    );
  } catch (e) {
    console.error(
      JSON.stringify({
        severity: 'ERROR',
        msg: 'telegram.link_write_failed',
        requestId,
        uid: pending.uid,
        err: (e as Error).message,
      }),
    );
    await sendMessage(
      chatId,
      'Something went wrong saving the link. Please try again from the web UI.',
    );
  }

  return okAck();
});
