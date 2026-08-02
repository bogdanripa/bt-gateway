/**
 * GET  /api/ui/me   → { email, isAdmin, user: {...} | null }
 * POST /api/ui/me   → idempotent upsert of the user doc on first sign-in
 *
 * Every UI page's first action is `POST /me` so `users/{uid}` exists before
 * anything else writes under it.
 */

import { requireFirebaseUser } from '@/lib/auth/session';
import { getUser, upsertUser } from '@/lib/store';
import { ok, withRoute } from '@/lib/route-handler';


export const GET = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const user = await getUser(caller.tenant);
  return ok({ email: caller.email, isAdmin: caller.isAdmin, user });
});

export const POST = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  await upsertUser(caller.tenant, {
    email: caller.email,
    isAdmin: caller.isAdmin,
  });
  const user = await getUser(caller.tenant);
  return ok({ email: caller.email, isAdmin: caller.isAdmin, user });
});
