/**
 * POST /oauth/register — RFC 7591 Dynamic Client Registration.
 *
 * Public clients only (PKCE-based). The body the MCP client sends is:
 *   {
 *     "client_name": "Claude",
 *     "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
 *     "grant_types": ["authorization_code"],
 *     "response_types": ["code"],
 *     "token_endpoint_auth_method": "none"
 *   }
 *
 * We validate redirect_uris against an allowlist (HTTPS, or localhost for
 * desktop apps), generate a random `client_id`, and persist a tiny
 * `OauthClientDoc` in the global `oauth_clients` table. No `client_secret` is issued —
 * security comes from PKCE + the redirect_uri match, not a shared secret.
 *
 * Unauthenticated by design: anyone can register a client. We assume the
 * actual security boundary is the user consent step (`/oauth/authorize`),
 * which requires Firebase sign-in.
 */

import { ApiError, json } from '@/lib/errors';
import { createOauthClient } from '@/lib/store';
import { isValidRedirectUri, randomId } from '@/lib/oauth/state';


interface RegistrationRequest {
  client_name?: unknown;
  redirect_uris?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  token_endpoint_auth_method?: unknown;
}

function clientError(error: string, description: string, status = 400): Response {
  // RFC 7591 §3.2.2 error envelope.
  return json({ error, error_description: description }, { status });
}

export async function POST(req: Request): Promise<Response> {
  let body: RegistrationRequest;
  try {
    body = (await req.json()) as RegistrationRequest;
  } catch {
    return clientError('invalid_client_metadata', 'Body must be JSON');
  }
  if (!body || typeof body !== 'object') {
    return clientError('invalid_client_metadata', 'Body must be a JSON object');
  }

  const rawUris = body.redirect_uris;
  if (!Array.isArray(rawUris) || rawUris.length === 0) {
    return clientError('invalid_redirect_uri', 'redirect_uris must be a non-empty array');
  }
  if (rawUris.length > 8) {
    return clientError('invalid_redirect_uri', 'too many redirect_uris');
  }
  const redirectUris: string[] = [];
  for (const u of rawUris) {
    if (typeof u !== 'string' || !isValidRedirectUri(u)) {
      return clientError(
        'invalid_redirect_uri',
        `redirect_uri not allowed: ${typeof u === 'string' ? u : '<non-string>'}`,
      );
    }
    redirectUris.push(u);
  }

  if (body.grant_types !== undefined) {
    if (!Array.isArray(body.grant_types) || !body.grant_types.includes('authorization_code')) {
      return clientError(
        'invalid_client_metadata',
        'only the authorization_code grant is supported',
      );
    }
  }
  if (body.response_types !== undefined) {
    if (!Array.isArray(body.response_types) || !body.response_types.includes('code')) {
      return clientError(
        'invalid_client_metadata',
        'only response_type=code is supported',
      );
    }
  }
  if (
    body.token_endpoint_auth_method !== undefined &&
    body.token_endpoint_auth_method !== 'none'
  ) {
    return clientError(
      'invalid_client_metadata',
      'only public clients (token_endpoint_auth_method=none) are supported',
    );
  }

  const clientName =
    typeof body.client_name === 'string' && body.client_name.trim().length > 0
      ? body.client_name.trim().slice(0, 120)
      : 'MCP client';

  const clientId = `mcp_${randomId(16)}`;
  try {
    await createOauthClient({
      clientId,
      clientName,
      redirectUris,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    // Surface as a generic server error per RFC; details to logs only.
    console.error(
      JSON.stringify({
        severity: 'ERROR',
        msg: 'oauth.register.firestore_failed',
        err: (e as Error).message,
      }),
    );
    throw new ApiError('INTERNAL', 'Failed to register client');
  }

  return json(
    {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    { status: 201 },
  );
}
