/**
 * Tiny fetch wrapper for browser → /api/ui/* calls.
 *
 * Every call needs `Authorization: Bearer <Firebase ID token>`. This wrapper
 * attaches it, parses JSON, and throws an Error with the server's error
 * envelope when the response isn't 2xx.
 */

'use client';

import { getIdToken } from './firebase/client';

export class UiError extends Error {
  code: string;
  requestId?: string;
  status: number;
  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export async function uiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await getIdToken();
  if (!token) throw new UiError(401, 'UNAUTHENTICATED', 'Not signed in');

  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const res = await fetch(path, { ...init, headers, cache: 'no-store' });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON response */
    }
  }

  if (!res.ok) {
    const env = data as { error?: { code?: string; message?: string; requestId?: string } } | null;
    throw new UiError(
      res.status,
      env?.error?.code ?? 'HTTP_ERROR',
      env?.error?.message ?? `HTTP ${res.status}`,
      env?.error?.requestId,
    );
  }

  return data as T;
}
