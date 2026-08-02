/**
 * POST /mcp — Model Context Protocol over Streamable HTTP.
 *
 * Authenticated by an `Authorization: Bearer bvb_<mode>_…` token issued by
 * the OAuth code-exchange step. Unauthenticated requests get 401 with the
 * RFC 9728 `WWW-Authenticate` resource_metadata pointer so clients can
 * discover the OAuth flow.
 *
 * Protocol surface implemented:
 *   - `initialize`            — capability negotiation, echoes back the
 *                               client's protocol version when supported.
 *   - `tools/list`            — enumerate the catalog from lib/mcp/tools.ts.
 *   - `tools/call`            — dispatch one call to the matching tool;
 *                               the tool issues an authenticated HTTP
 *                               request to the matching `/api/v1/*` route.
 *   - `ping`                  — health check.
 *   - `notifications/*`       — accepted with 202 and no body.
 *
 * No SSE streams (GET return 405). Tool results are wrapped as
 * `content: [{ type: 'text', text: <stringified JSON> }]` so the model
 * sees the raw payload it would have received from REST.
 */

import { ApiError, json, newRequestId } from '@/lib/errors';
import {
  authenticateApiKey,
  extractApiKey,
  type AuthenticatedCaller,
} from '@/lib/auth/api-key';
import { publicBaseUrl } from '@/lib/oauth/state';
import { MCP_TOOLS, findTool } from '@/lib/mcp/tools';


const SERVER_INFO = { name: 'bt-gateway', version: '1' };
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc?: string;
  method?: string;
  params?: unknown;
  id?: JsonRpcId;
}

function challenge(req: Request, description?: string): Response {
  const base = publicBaseUrl(req);
  const params = [
    'realm="bt-gateway"',
    `resource_metadata="${base}/.well-known/oauth-protected-resource"`,
  ];
  if (description) params.push(`error_description="${description.replace(/"/g, '\\"')}"`);
  return new Response(
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

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return json({ jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
  status?: number,
): Response {
  const body: Record<string, unknown> = {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
  return json(body, status !== undefined ? { status } : {});
}

function toolErrorContent(text: string, code?: string): unknown {
  return {
    content: [
      { type: 'text', text: code ? `[${code}] ${text}` : text },
    ],
    isError: true,
  };
}

function toolOkContent(payload: unknown): unknown {
  // Stringify the upstream JSON so the model gets the raw shape it would
  // see via REST. We pretty-print so a reader can scan it.
  return {
    content: [
      { type: 'text', text: JSON.stringify(payload, null, 2) },
    ],
    isError: false,
  };
}

async function handleInitialize(msg: JsonRpcRequest): Promise<Response> {
  const params = (msg.params ?? {}) as { protocolVersion?: string };
  const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
  const protocolVersion =
    requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : DEFAULT_PROTOCOL_VERSION;
  return rpcResult(msg.id ?? null, {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
  });
}

function handleToolsList(msg: JsonRpcRequest): Response {
  return rpcResult(msg.id ?? null, {
    tools: MCP_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  });
}

async function handleToolCall(
  msg: JsonRpcRequest,
  caller: AuthenticatedCaller,
  req: Request,
  bearer: string,
): Promise<Response> {
  const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  const name = typeof params.name === 'string' ? params.name : '';
  const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
  const tool = findTool(name);
  if (!tool) {
    return rpcResult(msg.id ?? null, toolErrorContent(`Unknown tool: ${name}`, 'TOOL_NOT_FOUND'));
  }
  if (tool.mutating && caller.access !== 'rw') {
    return rpcResult(
      msg.id ?? null,
      toolErrorContent(
        `Tool "${tool.name}" requires read+write access. This connection is read-only — reconnect via OAuth and choose "Read & place orders" to enable it.`,
        'FORBIDDEN',
      ),
    );
  }

  let plan: ReturnType<typeof tool.invoke>;
  try {
    plan = tool.invoke(args);
  } catch (e) {
    return rpcResult(
      msg.id ?? null,
      toolErrorContent(`Bad arguments for ${tool.name}: ${(e as Error).message}`, 'BAD_REQUEST'),
    );
  }

  const base = publicBaseUrl(req);
  const url = `${base}${plan.path}`;
  const headers: Record<string, string> = { authorization: `Bearer ${bearer}` };
  let body: string | undefined;
  if (plan.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(plan.body);
  }

  let res: Response;
  try {
    res = await fetch(url, { method: plan.method, headers, body, cache: 'no-store' });
  } catch (e) {
    return rpcResult(
      msg.id ?? null,
      toolErrorContent(`Network error calling BT Gateway: ${(e as Error).message}`, 'NETWORK_ERROR'),
    );
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); }
    catch { /* keep raw text below */ }
  }

  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message = `Request failed with status ${res.status}`;
    if (parsed && typeof parsed === 'object') {
      const env = (parsed as { error?: { code?: string; message?: string } }).error;
      if (env?.code) code = env.code;
      if (env?.message) message = env.message;
    }
    return rpcResult(msg.id ?? null, toolErrorContent(message, code));
  }

  return rpcResult(msg.id ?? null, toolOkContent(parsed ?? text));
}

/**
 * Mutable slot `dispatch` fills in once it has parsed the JSON-RPC envelope,
 * so the wrapper below can name the method in its log line and echo the id
 * back on an error. Parsing stays *after* authentication — an unauthenticated
 * caller must not get a parse-error reply that a challenge would not give.
 */
interface RpcContext {
  rpcMethod?: string;
  id: JsonRpcId;
}

async function dispatch(req: Request, ctx: RpcContext): Promise<Response> {
  if (req.method !== 'POST') {
    // GET (SSE) is not implemented. Reply with a JSON-RPC-shaped error so
    // an MCP client surfaces something readable instead of HTML.
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Only POST is supported on /mcp' },
        id: null,
      }),
      { status: 405, headers: { 'content-type': 'application/json', allow: 'POST' } },
    );
  }

  const bearer = extractApiKey(req);
  if (!bearer) return challenge(req);

  let caller: AuthenticatedCaller;
  try {
    caller = await authenticateApiKey(bearer);
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'UNAUTHORIZED' || e.code === 'RATE_LIMITED')) {
      return challenge(req, e.message);
    }
    throw e;
  }

  let msg: JsonRpcRequest;
  try {
    msg = (await req.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }
  if (!msg || typeof msg !== 'object') {
    return rpcError(null, -32600, 'Invalid Request');
  }
  ctx.id = msg.id ?? null;
  if (typeof msg.method === 'string') ctx.rpcMethod = msg.method;
  if (typeof msg.method !== 'string') {
    return rpcError(msg.id ?? null, -32600, 'Invalid Request: method missing');
  }

  // Notifications: no response per JSON-RPC spec — 202 with no body is safe.
  if (msg.method.startsWith('notifications/')) {
    return new Response(null, { status: 202 });
  }

  switch (msg.method) {
    case 'initialize':
      return handleInitialize(msg);
    case 'tools/list':
      return handleToolsList(msg);
    case 'tools/call':
      return handleToolCall(msg, caller, req, bearer);
    case 'ping':
      return rpcResult(msg.id ?? null, {});
    case 'prompts/list':
      // Not supported; return empty list rather than method-not-found so
      // clients that probe for prompts don't error.
      return rpcResult(msg.id ?? null, { prompts: [] });
    case 'resources/list':
      return rpcResult(msg.id ?? null, { resources: [] });
    default:
      return rpcError(msg.id ?? null, -32601, `Method not found: ${msg.method}`);
  }
}

/**
 * Error boundary + access logging for `/mcp`.
 *
 * This route cannot use `withRoute`: that emits the REST envelope
 * `{ error: { code, message, requestId } }`, which an MCP client cannot
 * parse — it expects JSON-RPC. So the same two log lines (`route.error`,
 * `route.access`) are emitted here by hand, deliberately matching
 * withRoute's field names so `/check-logs` and every requestId grep work
 * on `/mcp` exactly as they do on the REST routes. Before this existed,
 * `/mcp` was the one route invisible to the access log, and a failure
 * surfaced only as a bare `server.unhandled` from the HTTP bridge.
 *
 * On what can actually land here: `dispatch` converts every expected
 * failure — bad arguments, unknown method, upstream/BT errors, auth — into
 * a 200 or a 401 challenge. The one rethrow is a non-`ApiError` escaping
 * `authenticateApiKey`, and since that helper only ever throws
 * UNAUTHORIZED/RATE_LIMITED itself, in practice that means the database
 * read threw: a cold-start pool reconnect, or Postgres genuinely down.
 *
 * That is transient, so it answers 503 (not 500) with JSON-RPC -32603, to
 * tell the client to retry rather than treat the session as broken. The
 * raw message never reaches the caller — only the requestId, which ties
 * the reply to the logged stack.
 */
async function handle(req: Request): Promise<Response> {
  const requestId = newRequestId();
  const ctx: RpcContext = { id: null };
  const start = Date.now();
  let status = 500;
  let errCode: string | undefined;

  try {
    const res = await dispatch(req, ctx);
    status = res.status;
    res.headers.set('x-request-id', requestId);
    return res;
  } catch (e) {
    status = e instanceof ApiError ? e.status : 503;
    errCode = e instanceof ApiError ? e.code : 'INTERNAL';
    console.error(
      JSON.stringify({
        severity: 'ERROR',
        msg: 'route.error',
        requestId,
        path: '/mcp',
        method: req.method,
        rpcMethod: ctx.rpcMethod,
        code: errCode,
        message: (e as Error)?.message,
        context: e instanceof ApiError ? e.context : undefined,
        stack: e instanceof Error && !(e instanceof ApiError) ? e.stack : undefined,
      }),
    );
    const res = rpcError(
      ctx.id,
      -32603,
      'Internal error — the gateway could not serve this request. Retry shortly.',
      { requestId },
      status,
    );
    res.headers.set('x-request-id', requestId);
    return res;
  } finally {
    console.log(
      JSON.stringify({
        severity: status >= 500 ? 'ERROR' : 'INFO',
        msg: 'route.access',
        requestId,
        path: '/mcp',
        method: req.method,
        rpcMethod: ctx.rpcMethod,
        status,
        code: errCode,
        latencyMs: Date.now() - start,
      }),
    );
  }
}

export const GET = handle;
export const POST = handle;
