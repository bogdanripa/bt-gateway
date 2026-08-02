/**
 * RFC 9728 Protected Resource Metadata for `/mcp`.
 *
 * Walk-through:
 *   1. Claude hits /mcp without a token → gets 401 with
 *      `WWW-Authenticate: Bearer resource_metadata="<this URL>"`.
 *   2. Claude fetches this endpoint to discover which authorization server
 *      can mint tokens for the resource.
 *   3. Claude fetches /.well-known/oauth-authorization-server on that
 *      authorization server to learn its endpoints, then walks the OAuth
 *      flow with PKCE.
 *
 * We declare the gateway itself as both the protected resource and the
 * authorization server — it's a single container serving both.
 */

import { json } from '@/lib/errors';
import { publicBaseUrl } from '@/lib/oauth/state';


export async function GET(req: Request) {
  const base = publicBaseUrl(req);
  return json(
    {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      resource_documentation: `${base}/`,
    },
    {
      headers: {
        'cache-control': 'public, max-age=300',
      },
    },
  );
}
