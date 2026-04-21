/**
 * Telegram Bot API helpers — the outbound HTTP wrapper.
 *
 * We're multi-tenant with per-user bots, so these helpers take the bot
 * token as an explicit argument (there is no service-wide token anymore).
 * `notifyTenant` in lib/telegram.ts is the normal entrypoint — it looks up
 * the per-user bot doc, decrypts the token, and calls `sendMessageWithToken`.
 * The webhook handler uses `sendMessageWithToken` directly since it already
 * has the token in hand from the bot-doc lookup.
 *
 * Errors are logged but never thrown — a failed Telegram reply must not
 * turn a webhook response into a 500 (Telegram retries 500s, which would
 * flood us).
 */

import 'server-only';

export async function sendMessageWithToken(
  botToken: string,
  chatId: number,
  text: string,
): Promise<boolean> {
  if (!botToken) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
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

/**
 * One-shot probe: ask Telegram for the bot's own profile. Used when the
 * user saves a new bot token so we can confirm the token is valid (and
 * surface the @username it actually belongs to) before persisting.
 *
 * Returns null on any failure — never throws.
 */
export async function getBotProfile(
  botToken: string,
): Promise<{ id: number; username: string } | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      ok: boolean;
      result?: { id: number; username?: string };
    };
    if (!body.ok || !body.result?.username) return null;
    return { id: body.result.id, username: body.result.username };
  } catch {
    return null;
  }
}
