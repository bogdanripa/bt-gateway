/**
 * node:http ↔ Web-standard Request/Response bridge.
 *
 * Node 20 ships undici's `Request`/`Response`/`Headers` as globals, so route
 * handlers can be written against the Web platform rather than against this
 * server. That is what let the handlers survive dropping Next.js essentially
 * unchanged, and it is why nothing below this file knows what an
 * `IncomingMessage` is.
 *
 * Binding notes (these are load-bearing on the Pi — see the Dockerfile):
 * the container healthcheck runs INSIDE the container against
 * http://localhost:80, which resolves to ::1 first, while the proxy connects
 * from OUTSIDE over IPv4. `HOST` defaults to `::`, which in Node is genuinely
 * dual-stack; binding 0.0.0.0 fails the healthcheck and binding IPv6-only
 * passes it while 502-ing every real request.
 */

import http from 'node:http';
import { Readable } from 'node:stream';
import type { Router } from './router';
import { json, newRequestId } from '../lib/errors';

/** Requests without a body per RFC 9110. */
const BODYLESS = new Set(['GET', 'HEAD']);

async function readBody(req: http.IncomingMessage): Promise<Buffer | undefined> {
  if (BODYLESS.has(req.method ?? 'GET')) return undefined;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  return body.length ? body : undefined;
}

function toRequest(req: http.IncomingMessage, body: Buffer | undefined): Request {
  // The Host header is what the caller addressed us as; the proxy forwards the
  // app's real hostname, which matters because handlers derive their public
  // origin from it (OAuth metadata, Telegram webhook registration).
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0].trim() ??
    'http';
  const url = `${proto}://${Array.isArray(host) ? host[0] : host}${req.url ?? '/'}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const one of v) headers.append(k, one);
    else headers.set(k, v);
  }

  return new Request(url, {
    method: req.method ?? 'GET',
    headers,
    body: body as unknown as BodyInit | undefined,
  });
}

async function send(res: http.ServerResponse, out: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  out.headers.forEach((value, key) => {
    // set-cookie is the one header that legitimately repeats.
    if (key.toLowerCase() === 'set-cookie') {
      headers[key] = (headers[key] ? [headers[key]].flat() : []).concat(value) as string[];
    } else {
      headers[key] = value;
    }
  });
  res.writeHead(out.status, headers);
  if (!out.body) {
    res.end();
    return;
  }
  // Stream it through rather than buffering: snapshot payloads are large enough
  // that materialising them twice is a waste.
  Readable.fromWeb(out.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
}

export function createServer(router: Router): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      const request = toRequest(req, body);
      const { pathname } = new URL(request.url);
      const { handler, params, allowed } = router.match(req.method ?? 'GET', pathname);

      if (!handler) {
        const requestId = newRequestId();
        if (allowed.length) {
          await send(
            res,
            json(
              {
                error: {
                  code: 'BAD_REQUEST',
                  message: `Method ${req.method} not allowed on ${pathname}`,
                  requestId,
                },
              },
              { status: 405, headers: { allow: allowed.sort().join(', ') } },
            ),
          );
          return;
        }
        await send(
          res,
          json(
            { error: { code: 'NOT_FOUND', message: 'No such endpoint', requestId } },
            { status: 404 },
          ),
        );
        return;
      }

      await send(res, await handler(request, { params }));
    } catch (e) {
      // Anything reaching here escaped withRoute — a bug in the bridge itself,
      // or a malformed request undici rejected. Never leak the message.
      const requestId = newRequestId();
      console.error(
        JSON.stringify({
          severity: 'ERROR',
          msg: 'server.unhandled',
          requestId,
          path: req.url,
          method: req.method,
          message: (e as Error)?.message,
          stack: (e as Error)?.stack,
        }),
      );
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      }
      res.end(
        JSON.stringify({
          error: { code: 'INTERNAL', message: 'Internal error', requestId },
        }),
      );
    }
  });
}

export function listen(server: http.Server): void {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '::';
  server.listen(port, host, () => {
    console.log(
      JSON.stringify({ severity: 'INFO', msg: 'server.listening', port, host }),
    );
  });
}
