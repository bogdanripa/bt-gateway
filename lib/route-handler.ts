/**
 * Shared wrapper for `/api/v1/*` route handlers.
 *
 * Responsibilities:
 *   - Assign a requestId up front so every log line in this request shares it.
 *   - Catch any thrown error and turn it into the standard JSON envelope.
 *   - Emit a single structured log line per request (access log), including
 *     latency, outcome, and requestId.
 *
 * Route handlers should throw `ApiError` on any failure. Non-ApiError throws
 * get flattened to INTERNAL with the real message in the log only.
 */

import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { ApiError, newRequestId, toErrorResponse } from './errors';

export type RouteFn<P = unknown> = (
  req: NextRequest,
  ctx: { params: P; requestId: string },
) => Promise<NextResponse | Response> | NextResponse | Response;

export function withRoute<P = unknown>(fn: RouteFn<P>) {
  return async (req: NextRequest, nextCtx: { params: Promise<P> }): Promise<Response> => {
    const requestId = newRequestId();
    const start = Date.now();
    let status = 200;
    let errCode: string | undefined;

    try {
      // Next 15 gives params as a Promise in route handlers.
      const params = await nextCtx.params;
      const res = await fn(req, { params, requestId });
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
          path: req.nextUrl.pathname,
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
          path: req.nextUrl.pathname,
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
 * Helper for 204-ish JSON responses: `ok({ foo: 1 })` → status 200 JSON.
 */
export function ok(data: unknown, init: ResponseInit = {}): NextResponse {
  return NextResponse.json(data, init);
}
