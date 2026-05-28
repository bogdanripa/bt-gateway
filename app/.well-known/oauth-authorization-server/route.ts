/**
 * RFC 8414 Authorization Server Metadata.
 *
 * Lists the endpoints + supported features for the MCP-facing OAuth flow:
 *   - PKCE (S256 only) is mandatory.
 *   - Public clients only — no client_secret, no implicit grant.
 *   - Single grant: authorization_code.
 *   - Tokens are opaque API keys (`bvb_<mode>_<24 chars>`); no JWT introspection.
 */

import { NextResponse } from 'next/server';
import { publicBaseUrl } from '@/lib/oauth/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const base = publicBaseUrl(req);
  return NextResponse.json(
    {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
    },
    {
      headers: {
        'cache-control': 'public, max-age=300',
      },
    },
  );
}
