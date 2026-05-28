/**
 * POST /oauth/revoke — RFC 7009 token revocation.
 *
 * Body (form or JSON):
 *   token=<access_token>
 *   token_type_hint=access_token   (ignored — we only mint access_tokens)
 *
 * The token we issued IS the API key. Revoking marks the corresponding
 * ApiKeyDoc as revoked, which causes every subsequent /api/v1/* call with
 * the same bearer to fail UNAUTHORIZED. Unknown tokens always return 200
 * per RFC 7009 §2.2 (no enumeration leak).
 */

import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { audit } from '@/lib/events';
import { revokeApiKey, tenantFromAuthedUid } from '@/lib/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function parseBody(req: Request): Promise<URLSearchParams | null> {
  const ct = (req.headers.get('content-type') ?? '').toLowerCase();
  if (ct.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(await req.text());
  }
  if (ct.includes('application/json')) {
    try {
      const obj = (await req.json()) as Record<string, string>;
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') p.set(k, v);
      }
      return p;
    } catch {
      return null;
    }
  }
  return null;
}

export async function POST(req: Request): Promise<NextResponse> {
  // Be lenient on body shape; some clients send empty bodies on bad days.
  const params = await parseBody(req);
  const raw = params?.get('token')?.trim() ?? '';

  // RFC 7009 §2.2: respond 200 even for unknown tokens. Only do real work
  // when we can match the bearer to an ApiKeyDoc.
  if (raw) {
    try {
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      const { getFirestore } = await import('firebase-admin/firestore');
      const { adminApp } = await import('@/lib/firebase/admin');
      const db = getFirestore(adminApp());
      const snap = await db
        .collectionGroup('api_keys')
        .where('hash', '==', hash)
        .limit(1)
        .get();
      if (!snap.empty) {
        const doc = snap.docs[0];
        const data = doc.data() as { revokedAt?: string; mode?: 'demo' | 'live'; mcpClientId?: string };
        if (!data.revokedAt) {
          const parts = doc.ref.path.split('/');
          const uid = parts[1];
          const kid = doc.id;
          const tenant = tenantFromAuthedUid(uid);
          await revokeApiKey(tenant, kid);
          await audit({
            tenant,
            type: data.mcpClientId ? 'mcp.revoked' : 'apikey.revoked',
            actor: 'mcp_client',
            mode: data.mode,
            status: 'ok',
            detail: { keyId: kid, via: 'oauth/revoke' },
          });
        }
      }
    } catch (e) {
      // Never leak details — still return 200.
      console.error(
        JSON.stringify({
          severity: 'WARNING',
          msg: 'oauth.revoke.failed',
          err: (e as Error).message,
        }),
      );
    }
  }
  return new NextResponse(null, { status: 200, headers: { 'cache-control': 'no-store' } });
}
