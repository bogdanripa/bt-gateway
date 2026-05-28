/**
 * POST /oauth/token — RFC 6749 §4.1.3 authorization code exchange.
 *
 * application/x-www-form-urlencoded body:
 *   grant_type=authorization_code
 *   code=<one-shot from /oauth/authorize>
 *   redirect_uri=<must match code>
 *   client_id=<must match code>
 *   code_verifier=<PKCE verifier; SHA256 → must match code_challenge>
 *
 * On success we MINT a fresh API key bound to the tenant + chosen mode +
 * chosen access + cloned filters, mark this code as redeemed (one-shot),
 * and return the key as the OAuth `access_token`. The key is a normal
 * `bvb_<mode>_…` bearer that the MCP server validates the same way as any
 * other `/api/v1/*` consumer — no special-case verification path.
 *
 * "One MCP connection at a time": any prior un-revoked MCP-sourced key for
 * the same (tenant, mode) is revoked before the new key is created.
 *
 * No refresh tokens: MCP clients re-enter the authorization flow if the
 * token is revoked. The session refresh loop inside bt-gateway handles
 * keeping the underlying BT session alive.
 */

import { NextResponse } from 'next/server';
import { audit } from '@/lib/events';
import {
  consumeOauthCode,
  createApiKey,
  findActiveMcpKey,
  getOauthClient,
  revokeApiKey,
  tenantFromAuthedUid,
} from '@/lib/firestore';
import { generateApiKey } from '@/lib/auth/api-key';
import { hashCode, verifyPkceS256 } from '@/lib/oauth/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, description: string, status = 400): NextResponse {
  // RFC 6749 §5.2 error envelope.
  return NextResponse.json(
    { error, error_description: description },
    {
      status,
      headers: {
        'cache-control': 'no-store',
        pragma: 'no-cache',
      },
    },
  );
}

async function parseBody(req: Request): Promise<URLSearchParams | null> {
  const ct = (req.headers.get('content-type') ?? '').toLowerCase();
  if (ct.includes('application/x-www-form-urlencoded')) {
    const text = await req.text();
    return new URLSearchParams(text);
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
  const params = await parseBody(req);
  if (!params) return err('invalid_request', 'Body must be form-encoded or JSON');

  const grantType = params.get('grant_type');
  if (grantType !== 'authorization_code') {
    return err('unsupported_grant_type', `grant_type=${grantType} not supported`);
  }

  const rawCode = params.get('code') ?? '';
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const codeVerifier = params.get('code_verifier') ?? '';
  if (!rawCode) return err('invalid_request', 'code missing');
  if (!clientId) return err('invalid_request', 'client_id missing');
  if (!redirectUri) return err('invalid_request', 'redirect_uri missing');
  if (!codeVerifier) return err('invalid_request', 'code_verifier missing');

  const client = await getOauthClient(clientId);
  if (!client) return err('invalid_client', 'Unknown client_id', 401);

  // One-shot consume — second redemption returns null.
  const codeDoc = await consumeOauthCode(hashCode(rawCode));
  if (!codeDoc) return err('invalid_grant', 'Code unknown, expired, or already redeemed');
  if (codeDoc.clientId !== clientId) {
    return err('invalid_grant', 'code/client_id mismatch');
  }
  if (codeDoc.redirectUri !== redirectUri) {
    return err('invalid_grant', 'redirect_uri does not match the code');
  }
  if (!verifyPkceS256(codeVerifier, codeDoc.codeChallenge)) {
    return err('invalid_grant', 'PKCE verification failed');
  }

  // Build the MCP-sourced API key.
  const tenant = tenantFromAuthedUid(codeDoc.uid);
  const { key, hash, prefix } = generateApiKey(codeDoc.mode);
  const label = codeDoc.sourceKeyLabel
    ? `MCP (${client.clientName}) — ${codeDoc.sourceKeyLabel}`
    : `MCP (${client.clientName})`;
  const nowIso = new Date().toISOString();

  // "One MCP connection at a time" per (tenant, mode): revoke prior MCP key
  // if any. Best-effort; failure here doesn't block the new key.
  try {
    const prior = await findActiveMcpKey(tenant, codeDoc.mode);
    if (prior) {
      await revokeApiKey(tenant, prior.id);
      await audit({
        tenant,
        type: 'mcp.revoked',
        actor: 'system',
        mode: codeDoc.mode,
        status: 'ok',
        detail: { keyId: prior.id, reason: 'superseded by new MCP grant' },
      });
    }
  } catch (e) {
    console.error(
      JSON.stringify({
        severity: 'WARNING',
        msg: 'oauth.token.prior_revoke_failed',
        uid: codeDoc.uid,
        mode: codeDoc.mode,
        err: (e as Error).message,
      }),
    );
  }

  const newKeyId = await createApiKey(tenant, {
    prefix,
    hash,
    mode: codeDoc.mode,
    label: label.slice(0, 80),
    createdAt: nowIso,
    filters: codeDoc.filters,
    access: codeDoc.access,
    mcpClientId: codeDoc.clientId,
    mcpCreatedAt: nowIso,
  });

  await audit({
    tenant,
    type: 'mcp.connected',
    actor: 'user',
    mode: codeDoc.mode,
    status: 'ok',
    detail: {
      keyId: newKeyId,
      clientId: codeDoc.clientId,
      clientName: client.clientName,
      access: codeDoc.access,
      hasFilters: !!codeDoc.filters,
      sourceKeyLabel: codeDoc.sourceKeyLabel,
    },
  });

  return NextResponse.json(
    {
      access_token: key,
      token_type: 'Bearer',
      // No expiry: keys are revocable but don't expire by clock. MCP clients
      // re-authorize when the user revokes from Settings.
      scope: codeDoc.access === 'rw' ? 'read write' : 'read',
    },
    {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        pragma: 'no-cache',
      },
    },
  );
}
