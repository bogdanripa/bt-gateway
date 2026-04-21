/**
 * POST /api/v1/telegram/webhook/:secret
 *
 * Per-user Telegram bot webhook. Each tenant brings their own bot via
 * @BotFather and registers its webhook at this URL with a random,
 * per-user secret stored on their bot doc. The secret in the path segment
 * doubles as the lookup key:
 *
 *   lookup users/{uid}/integrations/bot where _type='telegram_bot' and
 *   webhookSecret == <secret>
 *
 * No match → respond 200 silently (don't leak existence of valid secrets,
 * don't fan out into Cloud Logging errors when someone pokes a stale URL).
 *
 * Handles `/start <linkCode>`. The UI generates a short-lived code
 * (users/{uid}/integrations/telegram_pending). After resolving the uid
 * from the webhookSecret we also re-check the code matches THIS uid's
 * pending doc — a malicious stranger who finds both the bot and another
 * user's code still cannot hijack (different uid).
 *
 * We always respond 200 so Telegram doesn't retry on errors.
 */

import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/route-handler';
import {
  findTelegramBotByWebhookSecret,
  getPendingTelegramLinkForUid,
  clearPendingTelegramLink,
  setTelegramLink,
  tenantFromAuthedUid,
  PENDING_TELEGRAM_LINK_TTL_MS,
} from '@/lib/firestore';
import { audit } from '@/lib/events';
import { decrypt } from '@/lib/kms';
import { sendMessageWithToken } from '@/lib/telegram-bot';

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

// Always respond 200 so Telegram doesn't retry. Any error state is logged
// via console.error + the access log line emitted by `withRoute`.
const okAck = () => NextResponse.json({ ok: true });

export const POST = withRoute<{ secret: string }>(async (req, { params, requestId }) => {
  const bot = params.secret
    ? await findTelegramBotByWebhookSecret(params.secret).catch(() => null)
    : null;
  if (!bot) return okAck(); // no bot matches this secret — drop silently

  const t = tenantFromAuthedUid(bot.uid);

  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return okAck();
  }

  const msg = update.message;
  if (!msg?.text || !msg.chat?.id) return okAck();

  const startMatch = msg.text.trim().match(/^\/start(?:\s+(\S+))?/i);
  if (!startMatch) return okAck();

  const code = startMatch[1];
  const chatId = msg.chat.id;
  const tgUsername = msg.from?.username ?? msg.chat.username;

  // Decrypt the bot token once — we need it to reply below.
  const botToken = await decrypt(bot.tokenCipher).catch(() => '');
  if (!botToken) {
    console.error(
      JSON.stringify({
        severity: 'ERROR',
        msg: 'telegram.webhook_decrypt_failed',
        requestId,
        uid: bot.uid,
      }),
    );
    return okAck();
  }

  if (!code) {
    await sendMessageWithToken(
      botToken,
      chatId,
      'Welcome to bt-gateway. To link your chat, go to /settings in the web UI, ' +
        'tap "Generate link code", and send it here with /start <code>.',
    );
    return okAck();
  }

  const pending = await getPendingTelegramLinkForUid(t).catch(() => null);
  const codeMatches =
    !!pending &&
    pending.code === code &&
    Date.now() - new Date(pending.createdAt).getTime() <= PENDING_TELEGRAM_LINK_TTL_MS;

  if (!codeMatches) {
    await sendMessageWithToken(
      botToken,
      chatId,
      'That link code is invalid or expired. Generate a new one in the web UI ' +
        'and send it within 10 minutes.',
    );
    return okAck();
  }

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
    await sendMessageWithToken(
      botToken,
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
        uid: bot.uid,
        err: (e as Error).message,
      }),
    );
    await sendMessageWithToken(
      botToken,
      chatId,
      'Something went wrong saving the link. Please try again from the web UI.',
    );
  }

  return okAck();
});
