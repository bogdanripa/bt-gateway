/**
 * Shared Telegram bot notifier.
 *
 * One bot serves every tenant. Each user links their account by running
 * `/start <linkCode>` against @<BOT_USERNAME>; the /api/v1/telegram/link
 * webhook (M3) stores the chat_id under users/{uid}/integrations/telegram.
 *
 * Notifications are opportunistic — if the user hasn't linked yet, or has
 * unlinked, `notifyTenant()` is a silent no-op. It never causes the caller
 * to fail.
 *
 * Only used for sign-in / refresh failure alerts. Trading events stay in
 * the audit UI; Telegram is reserved for "you need to do something" signals.
 */

import 'server-only';
import { getTelegramLink, type TenantRef } from './firestore';

function botToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN ?? null;
}

export async function notifyTenant(tenant: TenantRef, text: string): Promise<void> {
  const token = botToken();
  if (!token) return; // service-wide bot not configured — silent no-op

  const link = await getTelegramLink(tenant).catch(() => null);
  if (!link?.chatId) return; // user hasn't linked — silent no-op

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: link.chatId, text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error(
        JSON.stringify({
          severity: 'WARNING',
          msg: 'telegram.notify_http_error',
          uid: tenant.uid,
          status: res.status,
        }),
      );
    }
  } catch (e) {
    console.error(
      JSON.stringify({
        severity: 'WARNING',
        msg: 'telegram.notify_failed',
        uid: tenant.uid,
        err: (e as Error).message,
      }),
    );
  }
}
