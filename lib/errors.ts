/**
 * Typed error class + JSON error envelope for every API route.
 *
 * Every API route that fails should throw (or return) an ApiError. The route
 * handler's `try/catch` passes it through `toErrorResponse()` which turns it
 * into the standard JSON shape:
 *
 *   { error: { code: 'UNAUTHORIZED', message: '...', requestId: '...' } }
 *
 * Never leak raw Error.message for non-ApiError exceptions — those get
 * flattened to { code: 'INTERNAL', message: 'Internal error' } and the real
 * details go to the structured log only. A request ID is included so ops can
 * correlate a user-facing error with a log entry.
 */

import crypto from 'node:crypto';

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'CONFLICT'
  | 'UPSTREAM_UNAVAILABLE' // BT Trade returned non-2xx or network error
  | 'SESSION_EXPIRED' // BT session is dead and recovery needs an interactive OTP login
  | 'INTERNAL';

const DEFAULT_STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  CONFLICT: 409,
  UPSTREAM_UNAVAILABLE: 502,
  SESSION_EXPIRED: 503,
  INTERNAL: 500,
};

export class ApiError extends Error {
  code: ApiErrorCode;
  status: number;
  /** Structured context attached to the log line, never shown to the caller. */
  context?: Record<string, unknown>;

  constructor(
    code: ApiErrorCode,
    message: string,
    opts?: { status?: number; context?: Record<string, unknown> },
  ) {
    super(message);
    this.code = code;
    this.status = opts?.status ?? DEFAULT_STATUS[code];
    this.context = opts?.context;
  }
}

export function newRequestId(): string {
  // 12 bytes base32 → 19-char ID, collision-safe for well below our volume.
  return crypto.randomBytes(12).toString('base64url');
}

/** JSON response helper — the one place the envelope's content type is set. */
export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function toErrorResponse(err: unknown, requestId: string): Response {
  if (err instanceof ApiError) {
    return json(
      { error: { code: err.code, message: err.message, requestId } },
      { status: err.status },
    );
  }
  // Non-ApiError: do not leak .message to callers. Log it (caller's
  // responsibility — they have the request ID) and return a generic envelope.
  return json(
    { error: { code: 'INTERNAL', message: 'Internal error', requestId } },
    { status: 500 },
  );
}
