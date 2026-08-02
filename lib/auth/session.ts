/**
 * Firebase ID token verification for UI (browser) requests.
 *
 * The client sends `Authorization: Bearer <ID token>` where the token comes
 * from Firebase Auth's client SDK (`user.getIdToken()`). We verify it via
 * the Admin SDK, which checks the signature against Google's rotated public
 * keys and the `iss`/`aud` claims.
 *
 * Returns the tenant + whether the caller has isAdmin custom claim. Throws
 * ApiError on any verification failure.
 */

import { ApiError } from '../errors';
import { adminAuth } from '../firebase/admin';
import { tenantFromAuthedUid, type TenantRef } from '../store';

export interface UiCaller {
  tenant: TenantRef;
  email: string;
  isAdmin: boolean;
}

export async function requireFirebaseUser(req: Request): Promise<UiCaller> {
  const auth = req.headers.get('authorization');
  const m = auth?.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new ApiError('UNAUTHORIZED', 'Missing ID token');
  const token = m[1].trim();

  try {
    const decoded = await adminAuth().verifyIdToken(token);
    const email = decoded.email ?? '';
    // Fail closed on unverified emails. ALLOW_UNVERIFIED_EMAIL=1 is an escape
    // hatch for local dev only — hard-refuse it in production, so a misconfigured
    // Cloud Run env var can't silently accept unverified tokens.
    const bypassEnabled =
      process.env.ALLOW_UNVERIFIED_EMAIL === '1' &&
      process.env.NODE_ENV !== 'production';
    if (!decoded.email_verified && !bypassEnabled) {
      throw new ApiError('FORBIDDEN', 'Email not verified');
    }
    return {
      tenant: tenantFromAuthedUid(decoded.uid),
      email,
      isAdmin: decoded.isAdmin === true,
    };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('UNAUTHORIZED', 'Invalid or expired ID token', {
      context: { err: (e as Error).message },
    });
  }
}

export async function requireAdmin(req: Request): Promise<UiCaller> {
  const caller = await requireFirebaseUser(req);
  if (!caller.isAdmin) throw new ApiError('FORBIDDEN', 'Admin access required');
  return caller;
}
