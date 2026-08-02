/**
 * GET /api/ui/oauth/context — what the OAuth consent page needs to render.
 *
 * Inputs (query):
 *   client_id, redirect_uri, code_challenge, code_challenge_method, state,
 *   response_type, scope (ignored), resource (ignored — we only host /mcp).
 *
 * Returns:
 *   {
 *     client: { client_id, client_name, redirect_uri },
 *     modes: { demo: boolean, live: boolean },   // which modes have creds
 *     keys:  Array<{ id, label, mode, prefix, filters?, hasFilters }>,
 *     // echoed back so the page can post them to /api/ui/oauth/consent unchanged
 *     params: { client_id, redirect_uri, code_challenge, code_challenge_method, state }
 *   }
 *
 * Errors are returned via the standard `withRoute` envelope. The consent
 * page surfaces them to the user (e.g. "this redirect_uri isn't registered").
 *
 * Auth: requires a signed-in Firebase user. The consent decision will later
 * be made on behalf of that same user.
 */

import { requireFirebaseUser } from '@/lib/auth/session';
import { getBtCreds, getOauthClient, listApiKeys } from '@/lib/store';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError } from '@/lib/errors';


export const GET = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);

  const sp = new URL(req.url).searchParams;
  const clientId = sp.get('client_id') ?? '';
  const redirectUri = sp.get('redirect_uri') ?? '';
  const codeChallenge = sp.get('code_challenge') ?? '';
  const codeChallengeMethod = sp.get('code_challenge_method') ?? '';
  const state = sp.get('state') ?? '';
  const responseType = sp.get('response_type') ?? 'code';

  if (responseType !== 'code') {
    throw new ApiError('BAD_REQUEST', 'response_type must be "code"');
  }
  if (codeChallengeMethod !== 'S256') {
    throw new ApiError('BAD_REQUEST', 'code_challenge_method must be "S256"');
  }
  if (!codeChallenge || codeChallenge.length < 43 || codeChallenge.length > 128) {
    throw new ApiError('BAD_REQUEST', 'code_challenge missing or invalid');
  }
  if (!clientId) throw new ApiError('BAD_REQUEST', 'client_id missing');
  if (!redirectUri) throw new ApiError('BAD_REQUEST', 'redirect_uri missing');

  const client = await getOauthClient(clientId);
  if (!client) throw new ApiError('NOT_FOUND', 'Unknown client_id');
  if (!client.redirectUris.includes(redirectUri)) {
    throw new ApiError(
      'BAD_REQUEST',
      'redirect_uri does not match any URI registered for this client',
    );
  }

  const [demoCreds, liveCreds, keys] = await Promise.all([
    getBtCreds(caller.tenant, 'demo'),
    getBtCreds(caller.tenant, 'live'),
    listApiKeys(caller.tenant),
  ]);

  // Surface only non-revoked keys — revoked ones are not selectable as a
  // "borrow filters from" source.
  const rows = keys
    .filter((k) => !k.revokedAt)
    .map((k) => ({
      id: k.id,
      label: k.label,
      mode: k.mode,
      prefix: k.prefix,
      filters: k.filters,
      hasFilters: !!(
        k.filters &&
        (k.filters.markets.include.length ||
          k.filters.markets.exclude.length ||
          k.filters.currencies.include.length ||
          k.filters.currencies.exclude.length ||
          k.filters.stocks.include.length ||
          k.filters.stocks.exclude.length)
      ),
    }));

  return ok({
    client: {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uri: redirectUri,
    },
    modes: { demo: !!demoCreds, live: !!liveCreds },
    keys: rows,
    params: {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      state,
    },
  });
});
