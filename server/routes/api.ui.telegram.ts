/**
 * GET    /api/ui/telegram — { linked, chatId?, username?, linkedAt? }
 * DELETE /api/ui/telegram — unlink
 *
 * Linking happens via the bot's `/start <linkCode>` flow (M4 — webhook at
 * /api/v1/telegram/link). This endpoint only exposes state + unlink.
 */

import { requireFirebaseUser } from '@/lib/auth/session';
import { getTelegramLink, clearTelegramLink } from '@/lib/store';
import { audit } from '@/lib/events';
import { ok, withRoute } from '@/lib/route-handler';


export const GET = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const link = await getTelegramLink(caller.tenant);
  if (!link) return ok({ linked: false });
  return ok({
    linked: true,
    chatId: link.chatId,
    username: link.username,
    linkedAt: link.linkedAt,
  });
});

export const DELETE = withRoute(async (req, { requestId }) => {
  const caller = await requireFirebaseUser(req);
  await clearTelegramLink(caller.tenant);
  await audit({
    tenant: caller.tenant,
    type: 'telegram.unlinked',
    actor: 'user',
    status: 'ok',
    requestId,
  });
  return ok({ linked: false });
});
