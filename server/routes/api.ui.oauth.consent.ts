/**
 * POST /api/ui/oauth/consent
 *
 * The OAuth consent page calls this AFTER the user picks mode + key + access.
 * We persist a one-shot authorization code bound to the user's uid and the
 * chosen scope/filters, then return the redirect URL containing
 *   ?code=...&state=<echoed>
 * The browser then `location.replace`s into the client's redirect_uri to
 * complete the flow.
 *
 * Body:
 *   {
 *     client_id, redirect_uri, code_challenge, code_challenge_method, state,
 *     mode: 'demo'|'live',
 *     access: 'read'|'rw',
 *     keyId?: string   // optional: when set, the new MCP key inherits this key's filters
 *   }
 *
 * The raw code is returned in the redirect URL — we only store its sha256
 * hash on the OauthCodeDoc.
 */

import { z } from 'zod';
import { requireFirebaseUser } from '@/lib/auth/session';
import { ok, withRoute } from '@/lib/route-handler';
import { ApiError, json } from '@/lib/errors';
import {
  createOauthCode,
  getBtCreds,
  getOauthClient,
  listApiKeys,
  type ApiKeyFilters,
  type BtMode,
} from '@/lib/store';
import { hashCode, OAUTH_CODE_TTL_MS, randomId } from '@/lib/oauth/state';


const Schema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(512).default(''),
  mode: z.enum(['demo', 'live']),
  access: z.enum(['read', 'rw']),
  keyId: z.string().min(1).optional(),
});

export const POST = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);

  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('BAD_REQUEST', 'Invalid consent body', {
      context: { issues: parsed.error.issues },
    });
  }
  const { client_id, redirect_uri, code_challenge, code_challenge_method, state, access, keyId } =
    parsed.data;
  const mode = parsed.data.mode as BtMode;

  const client = await getOauthClient(client_id);
  if (!client) throw new ApiError('NOT_FOUND', 'Unknown client_id');
  if (!client.redirectUris.includes(redirect_uri)) {
    throw new ApiError('BAD_REQUEST', 'redirect_uri does not match registration');
  }

  // The user can only consent to a mode they actually have BT credentials for —
  // otherwise the resulting MCP key would 502 on the first call.
  const creds = await getBtCreds(caller.tenant, mode);
  if (!creds) {
    throw new ApiError(
      'BAD_REQUEST',
      `No ${mode} BT credentials configured. Set them up before connecting MCP.`,
    );
  }

  // If the user chose to inherit filters from an existing key, find it.
  // Otherwise the MCP key gets no filters (full access within the mode).
  let sourceFilters: ApiKeyFilters | undefined;
  let sourceLabel: string | undefined;
  if (keyId) {
    const keys = await listApiKeys(caller.tenant);
    const src = keys.find((k) => k.id === keyId);
    if (!src) throw new ApiError('NOT_FOUND', 'API key not found for filter inheritance');
    if (src.revokedAt) throw new ApiError('BAD_REQUEST', 'Source API key is revoked');
    if (src.mode !== mode) {
      throw new ApiError(
        'BAD_REQUEST',
        `Source API key is ${src.mode} but the chosen mode is ${mode}`,
      );
    }
    sourceFilters = src.filters;
    sourceLabel = src.label;
  }

  const rawCode = randomId(32);
  const codeHash = hashCode(rawCode);
  const now = new Date();
  await createOauthCode({
    codeHash,
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    uid: caller.tenant.uid,
    mode,
    access,
    filters: sourceFilters,
    sourceKeyLabel: sourceLabel,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + OAUTH_CODE_TTL_MS).toISOString(),
  });

  // Build the redirect URL — preserve existing query params on the callback,
  // then append code + state. RFC 6749 §4.1.2.
  const url = new URL(redirect_uri);
  url.searchParams.set('code', rawCode);
  if (state) url.searchParams.set('state', state);

  return ok({ redirect: url.toString() });
});
