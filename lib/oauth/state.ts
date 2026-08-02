/**
 * OAuth 2.1 helpers for the MCP authorization flow.
 *
 * Scope: this file is the only place we touch raw OAuth state. Routes under
 * `app/oauth/*` and `app/api/ui/oauth/*` import from here so the rules
 * (PKCE method, code TTL, redirect-uri allowlist, public-clients-only) live
 * in one spot.
 *
 * Public clients with PKCE only — no client_secret, no implicit grant, no
 * refresh tokens. The "token" we hand back is a fresh API key minted at
 * code-exchange time; the MCP server then authenticates each tool call with
 * that bearer the same way every other `/api/v1/*` consumer does.
 */

import crypto from 'node:crypto';

/** How long an authorization code stays valid before consumeOauthCode rejects it. */
export const OAUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 min

/** Only S256 is honored. Plain is explicitly rejected at the authorize step. */
export type CodeChallengeMethod = 'S256';

/** Random URL-safe identifier (base64url, no padding). */
export function randomId(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Hash an authorization code for storage lookup. We never store the raw code. */
export function hashCode(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Verify a PKCE `code_verifier` against a stored S256 `code_challenge`.
 *
 * Per RFC 7636: challenge = BASE64URL(SHA256(verifier)) without padding.
 * Comparison is timing-safe.
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) {
    // RFC 7636 mandates 43-128 ASCII chars.
    return false;
  }
  const computed = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');
  if (computed.length !== challenge.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
  } catch {
    return false;
  }
}

/**
 * Redirect URI allowlist for Dynamic Client Registration. We permit:
 *   - https:// of any host (real MCP clients live on the open web)
 *   - http://localhost or http://127.0.0.1 with any port (dev / desktop apps)
 *
 * No `file://`, no `app://`, no `javascript:`. No wildcards on the host.
 */
export function isValidRedirectUri(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.hash) return false; // RFC 6749: redirect_uri MUST NOT have a fragment.
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') {
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  }
  return false;
}

/**
 * Resolve the canonical base URL this service answers on. The edge proxy in
 * front of the container sets X-Forwarded-Host to the public hostname;
 * locally we fall back to the request URL.
 *
 * Set `BT_GATEWAY_PUBLIC_URL` in production and it beats both. That is the
 * recommended configuration, not just an escape hatch: this value ends up in
 * OAuth metadata and redirect URIs, where being silently wrong because a
 * proxy header changed shape is a bad failure mode.
 */
export function publicBaseUrl(req: Request): string {
  const configured = process.env.BT_GATEWAY_PUBLIC_URL?.replace(/\/+$/, '');
  if (configured) return configured;
  const h = req.headers;
  const host =
    h.get('x-forwarded-host') ?? h.get('host') ?? new URL(req.url).host;
  const proto =
    h.get('x-forwarded-proto')?.split(',')[0].trim() ?? 'https';
  return `${proto}://${host}`;
}
