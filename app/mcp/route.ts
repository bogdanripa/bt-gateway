/**
 * POST /mcp — Model Context Protocol Streamable HTTP transport (stub).
 *
 * This commit ships only the OAuth surface around this endpoint:
 *   - Unauthenticated requests return 401 with
 *       WWW-Authenticate: Bearer realm="bt-gateway",
 *         resource_metadata="<base>/.well-known/oauth-protected-resource"
 *     which tells Claude.ai's connector to walk the OAuth discovery flow.
 *   - Authenticated requests get a JSON-RPC error saying tools are coming.
 *
 * Commit 2 will replace the authenticated branch with the real JSON-RPC
 * dispatcher (initialize, tools/list, tools/call) and the 8 tools.
 */

import { NextResponse } from 'next/server';
import { ApiError } from '@/lib/errors';
import { authenticateApiKey, extractApiKey } from '@/lib/auth/api-key';
import { publicBaseUrl } from '@/lib/oauth/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function challenge(req: Request, description?: string): NextResponse {
  const base = publicBaseUrl(req);
  const params = [
    'realm="bt-gateway"',
    `resource_metadata="${base}/.well-known/oauth-protected-resource"`,
  ];
  if (description) params.push(`error_description="${description.replace(/"/g, '\\"')}"`);
  return new NextResponse(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: description ?? 'Authentication required' },
      id: null,
    }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': `Bearer ${params.join(', ')}`,
      },
    },
  );
}

async function handle(req: Request): Promise<NextResponse> {
  const raw = extractApiKey(req as never);
  if (!raw) return challenge(req);

  try {
    await authenticateApiKey(raw);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'UNAUTHORIZED') {
      return challenge(req, 'Invalid token');
    }
    throw e;
  }

  // Authenticated, but the JSON-RPC dispatcher isn't wired yet.
  return NextResponse.json(
    {
      jsonrpc: '2.0',
      error: {
        code: -32601,
        message: 'MCP transport not implemented yet — tools ship in the next deploy',
      },
      id: null,
    },
    { status: 501 },
  );
}

export const GET = handle;
export const POST = handle;
