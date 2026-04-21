/**
 * Telegram Bot API helpers — the outbound side of the bot.
 *
 * Thin wrappers over the Bot HTTP API. All use the shared bot token from
 * `TELEGRAM_BOT_TOKEN`. Errors are logged but never thrown — a failed
 * Telegram reply must not make a webhook respond 500 (Telegram retries
 * 500s, which would flood us).
 */

import 'server-only';

function token(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN ?? null;
}

export async function sendMessage(chatId: number, text: string): Promise<boolean> {
  const t = token();
  if (!t) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error(
        JSON.stringify({
          severity: 'WARNING',
          msg: 'telegram.sendMessage_http_error',
          chatId,
          status: res.status,
        }),
      );
      return false;
    }
    return true;
  } catch (e) {
    console.error(
      JSON.stringify({
        severity: 'WARNING',
        msg: 'telegram.sendMessage_failed',
        chatId,
        err: (e as Error).message,
      }),
    );
    return false;
  }
}
