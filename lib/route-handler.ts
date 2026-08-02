/**
 * Shared wrapper for API route handlers.
 *
 * Responsibilities:
 *   - Assign a requestId up front so every log line in this request shares it.
 *   - Catch any thrown error and turn it into the standard JSON envelope.
 *   - Emit a single structured log line per request (access log), including
 *     latency, outcome, and requestId.
 *
 * Route handlers should throw `ApiError` on any failure. Non-ApiError throws
 * get flattened to INTERNAL with the real message in the log only.
 *
 * Everything here is Web-standard `Request`/`Response` (built into Node 20 via
 * undici), so handlers stay framework-agnostic — this used to sit on
 * NextRequest/NextResponse, and the contract deliberately did not change when
 * Next.js came out.
 */

import { ApiError, json, newRequestId, toErrorResponse } from './errors';

export type RouteFn<P = unknown> = (
  req: Request,
  ctx: { params: P; requestId: string },
) => Promise<Response> | Response;

export function withRoute<P = unknown>(fn: RouteFn<P>) {
  return async (req: Request, ctx: { params: P }): Promise<Response> => {
    const requestId = newRequestId();
    const start = Date.now();
    let status = 200;
    let errCode: string | undefined;
    const path = new URL(req.url).pathname;

    try {
      const res = await fn(req, { params: ctx.params, requestId });
      status = res.status;
      // Add requestId to the response so clients can correlate.
      res.headers.set('x-request-id', requestId);
      return res;
    } catch (e) {
      const res = toErrorResponse(e, requestId);
      status = res.status;
      errCode = e instanceof ApiError ? e.code : 'INTERNAL';
      console.error(
        JSON.stringify({
          severity: e instanceof ApiError && e.status < 500 ? 'WARNING' : 'ERROR',
          msg: 'route.error',
          requestId,
          path,
          method: req.method,
          code: errCode,
          message: (e as Error)?.message,
          context: e instanceof ApiError ? e.context : undefined,
          stack: e instanceof Error && !(e instanceof ApiError) ? e.stack : undefined,
        }),
      );
      res.headers.set('x-request-id', requestId);
      return res;
    } finally {
      console.log(
        JSON.stringify({
          severity: status >= 500 ? 'ERROR' : 'INFO',
          msg: 'route.access',
          requestId,
          path,
          method: req.method,
          status,
          code: errCode,
          latencyMs: Date.now() - start,
        }),
      );
    }
  };
}

/**
 * Helper for JSON responses: `ok({ foo: 1 })` → status 200 JSON.
 */
export function ok(data: unknown, init: ResponseInit = {}): Response {
  return json(data, init);
}

/**
 * Parse a request body as a JSON object (not array, not primitive). Throws
 * BAD_REQUEST on invalid JSON, non-object top-level, or array top-level.
 *
 * Most mutating routes want the same guard; use this instead of re-rolling
 * the `try/catch` + `typeof === 'object'` + `Array.isArray` check.
 */
export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ApiError('BAD_REQUEST', 'Body must be JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError('BAD_REQUEST', 'Body must be a JSON object');
  }
  return body as Record<string, unknown>;
}
