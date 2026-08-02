/**
 * Telegram notifier — outbound side, per-user bot.
 *
 * Each tenant brings their own bot via @BotFather. Settings stores the bot
 * token (envelope-encrypted via KMS) and the chat_id the user linked via
 * `/start <code>`. Notifications are opportunistic: if the user hasn't
 * configured a bot, hasn't linked a chat, or Telegram itself errors, this
 * function is a silent no-op. It NEVER throws — a failed alert must not
 * bubble into the caller (cron, webhook) and surface as a 500.
 *
 * Only used for sign-in / refresh failure alerts. Routine events stay in
 * the audit UI; Telegram is reserved for "you need to do something" signals.
 */

import { getTelegramBot, getTelegramLink, type TenantRef } from './store';
import { decrypt } from './secret-box';
import { sendMessageWithToken } from './telegram-bot';

export async function notifyTenant(tenant: TenantRef, text: string): Promise<void> {
  const bot = await getTelegramBot(tenant).catch(() => null);
  if (!bot?.tokenCipher) return; // user hasn't configured a bot — silent no-op

  const link = await getTelegramLink(tenant).catch(() => null);
  if (!link?.chatId) return; // user hasn't linked their chat yet — silent no-op

  const token = await decrypt(bot.tokenCipher).catch(() => '');
  if (!token) {
    console.error(
      JSON.stringify({
        severity: 'WARNING',
        msg: 'telegram.notify_decrypt_failed',
        uid: tenant.uid,
      }),
    );
    return;
  }

  await sendMessageWithToken(token, link.chatId, text);
}
