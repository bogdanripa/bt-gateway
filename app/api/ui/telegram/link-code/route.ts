/**
 * POST /api/ui/telegram/link-code
 *
 * Generates a short-lived (10 min) link code. The UI shows it + the bot
 * @handle to the user; they send `/start <code>` to the bot to complete
 * the link.
 *
 * Regenerating overwrites the previous code — only the latest pending
 * code works. This lets the user "try again" if they've lost the code
 * without having multiple valid codes in the wild.
 */

import crypto from 'node:crypto';
import { requireFirebaseUser } from '@/lib/auth/session';
import { setPendingTelegramLink } from '@/lib/firestore';
import { ApiError } from '@/lib/errors';
import { ok, withRoute } from '@/lib/route-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  const code = makeCode();
  await setPendingTelegramLink(caller.tenant, code);

  // Bot username (without @) — if unset, the client will show generic copy.
  const botUsername = process.env.TELEGRAM_BOT_USERNAME ?? '';
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', 'Telegram bot not configured on this server');
  }

  return ok({
    code,
    ttlMs: 10 * 60 * 1000,
    botUsername,
    deepLink: botUsername ? `https://t.me/${botUsername}?start=${code}` : null,
  });
});
