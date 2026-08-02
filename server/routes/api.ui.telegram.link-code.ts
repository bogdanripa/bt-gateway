/**
 * POST /api/ui/telegram/link-code
 *
 * Generates a short-lived (10 min) link code. The user sends `/start <code>`
 * to their own bot (configured via /api/ui/telegram/bot) to prove to the
 * webhook that the Telegram chat belongs to the same person as the
 * bt-gateway account.
 *
 * Regenerating overwrites the previous code — only the latest pending
 * code works. This lets the user "try again" if they've lost the code
 * without leaving multiple valid codes in the wild.
 */

import crypto from 'node:crypto';
import { requireFirebaseUser } from '@/lib/auth/session';
import { getTelegramBot, setPendingTelegramLink } from '@/lib/store';
import { ApiError } from '@/lib/errors';
import { ok, withRoute } from '@/lib/route-handler';


// Human-friendly code: 8 upper-case alphanumerics, unambiguous glyphs only.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/l
function makeCode(length = 8): string {
  const buf = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}

export const POST = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);

  // Per-user bots: the user must configure their bot before we can hand out
  // a link code. Otherwise the deep link would have nowhere to point.
  const bot = await getTelegramBot(caller.tenant);
  if (!bot) {
    throw new ApiError(
      'CONFLICT',
      'Configure your Telegram bot first (Settings → Telegram).',
    );
  }

  const code = makeCode();
  await setPendingTelegramLink(caller.tenant, code);

  return ok({
    code,
    ttlMs: 10 * 60 * 1000,
    botUsername: bot.username,
    deepLink: `https://t.me/${bot.username}?start=${code}`,
  });
});
