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

import { json } from '@/lib/errors';
import crypto from 'node:crypto';
import { audit } from '@/lib/events';
import { findApiKeyByHash, revokeApiKey, tenantFromAuthedUid } from '@/lib/store';


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

export async function POST(req: Request): Promise<Response> {
  // Be lenient on body shape; some clients send empty bodies on bad days.
  const params = await parseBody(req);
  const raw = params?.get('token')?.trim() ?? '';

  // RFC 7009 §2.2: respond 200 even for unknown tokens. Only do real work
  // when we can match the bearer to an ApiKeyDoc.
  if (raw) {
    try {
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      const found = await findApiKeyByHash(hash);
      if (found && !found.revokedAt) {
        const tenant = tenantFromAuthedUid(found.uid);
        await revokeApiKey(tenant, found.id);
        await audit({
          tenant,
          type: found.mcpClientId ? 'mcp.revoked' : 'apikey.revoked',
          actor: 'mcp_client',
          mode: found.mode,
          status: 'ok',
          detail: { keyId: found.id, via: 'oauth/revoke' },
        });
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
  return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
}
