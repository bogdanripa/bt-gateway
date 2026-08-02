/**
 * Entrypoint for the bt-gateway API server.
 *
 * Plain Node — no framework. The whole service is a route table
 * (`server/registry.ts`), a tiny matcher (`server/router.ts`) and a
 * node:http ↔ Web-standard bridge (`server/http.ts`). This replaced Next.js,
 * which was carrying an entire React SSR runtime to serve what is really just
 * JSON; the UI is now a static bundle the platform's frontend host serves, and
 * nothing here renders HTML.
 *
 * The database schema is applied lazily on the first query (see `lib/db.ts`),
 * NOT here. Two reasons: `/api/health` must answer before Postgres is
 * necessarily reachable — it is the container healthcheck and the deploy's
 * readiness gate, so making startup depend on the database turns a transient
 * blip into a rolled-back deploy — and the schema apply is idempotent anyway.
 */

import { buildRouter } from './registry';
import { createServer, listen } from './http';

const server = createServer(buildRouter());

// A dropped client mid-response is normal (proxy timeouts, browser navigation)
// and must not take the process down.
server.on('clientError', (_err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

process.on('unhandledRejection', (reason) => {
  console.error(
    JSON.stringify({
      severity: 'ERROR',
      msg: 'process.unhandledRejection',
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    }),
  );
});

/**
 * Coolify stops containers with SIGTERM. Close the listener so in-flight
 * requests finish, but do not wait forever — the BT client pool holds long-
 * lived upstream sessions that will never idle out on their own.
 */
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(JSON.stringify({ severity: 'INFO', msg: 'server.shutdown', sig }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

listen(server);
