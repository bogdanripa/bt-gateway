/**
 * Postgres connection pool + schema bootstrap.
 *
 * This replaces Firestore. The database is the one attached to the
 * `bt-gateway` app on the Pi; its connection string arrives as `DATABASE_URL`
 * and is only resolvable from inside the app's own container network.
 *
 * Schema is applied at runtime, not by a separate migration step: the DDL
 * below is entirely `IF NOT EXISTS` and runs once per process, guarded by a
 * module-level promise that every query awaits. That keeps deploys to a
 * single moving part (push the image, the container brings its own schema
 * forward) which is the right trade at this size — one box, one instance.
 *
 * ## Timestamps are ISO-8601 `text`, deliberately
 *
 * The Firestore code stored every timestamp as an ISO string and compared
 * them with plain `>=` / `<=`, relying on the fact that ISO-8601 in UTC sorts
 * correctly as a string. Keeping them as `text` here means the ported queries
 * have byte-identical ordering and range semantics to what they replaced, and
 * the migration copies values across untouched. Switching to `timestamptz`
 * would be tidier but would silently change how mixed-offset legacy rows sort.
 */

import { Pool, type PoolClient, type QueryResultRow } from 'pg';

let poolInstance: Pool | null = null;

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set — the app cannot reach its Postgres database. ' +
        'On the Pi this is injected automatically on deploy; locally, point it ' +
        'at your own Postgres instance.',
    );
  }
  return url;
}

export function pool(): Pool {
  if (!poolInstance) {
    poolInstance = new Pool({
      connectionString: connectionString(),
      // One always-warm instance serving a handful of requests a minute. A
      // small pool is plenty and keeps idle connections off the Pi.
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    poolInstance.on('error', (err) => {
      // A pooled client dying in the background must not take the process
      // down — the next query just opens a fresh connection.
      console.error(
        JSON.stringify({ severity: 'ERROR', msg: 'db.pool.error', err: err.message }),
      );
    });
  }
  return poolInstance;
}

// ---- schema ---------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  uid           text PRIMARY KEY,
  email         text NOT NULL,
  display_name  text,
  is_admin      boolean NOT NULL DEFAULT false,
  created_at    text NOT NULL,
  updated_at    text NOT NULL
);

CREATE TABLE IF NOT EXISTS bt_creds (
  uid              text NOT NULL,
  mode             text NOT NULL CHECK (mode IN ('demo','live')),
  username_cipher  text NOT NULL,
  password_cipher  text NOT NULL,
  key_version      text NOT NULL,
  updated_at       text NOT NULL,
  PRIMARY KEY (uid, mode)
);

CREATE TABLE IF NOT EXISTS bt_sessions (
  uid         text NOT NULL,
  mode        text NOT NULL CHECK (mode IN ('demo','live')),
  snapshot    jsonb NOT NULL,
  updated_at  text NOT NULL,
  PRIMARY KEY (uid, mode)
);

-- The old root-level key_hashes index collapses into this table's UNIQUE
-- constraint on hash: one indexed point-read resolves a bearer token to its
-- owning tenant, which is exactly what the Firestore index existed to fake.
CREATE TABLE IF NOT EXISTS api_keys (
  id              text PRIMARY KEY,
  uid             text NOT NULL,
  prefix          text NOT NULL,
  hash            text NOT NULL UNIQUE,
  mode            text NOT NULL CHECK (mode IN ('demo','live')),
  label           text NOT NULL DEFAULT '',
  created_at      text NOT NULL,
  last_used_at    text,
  revoked_at      text,
  filters         jsonb,
  access          text,
  mcp_client_id   text,
  mcp_created_at  text
);
CREATE INDEX IF NOT EXISTS api_keys_uid_created_idx ON api_keys (uid, created_at DESC);
CREATE INDEX IF NOT EXISTS api_keys_uid_mode_idx ON api_keys (uid, mode);

CREATE TABLE IF NOT EXISTS events (
  id      bigserial PRIMARY KEY,
  uid     text NOT NULL,
  type    text NOT NULL,
  actor   text NOT NULL,
  mode    text,
  status  text NOT NULL,
  detail  jsonb,
  error   jsonb,
  ts      text NOT NULL
);
CREATE INDEX IF NOT EXISTS events_uid_ts_idx ON events (uid, ts DESC);

CREATE TABLE IF NOT EXISTS telegram_links (
  uid        text PRIMARY KEY,
  chat_id    bigint NOT NULL,
  linked_at  text NOT NULL,
  username   text
);

CREATE TABLE IF NOT EXISTS telegram_pending (
  uid         text PRIMARY KEY,
  code        text NOT NULL,
  created_at  text NOT NULL
);
CREATE INDEX IF NOT EXISTS telegram_pending_code_idx ON telegram_pending (code);

CREATE TABLE IF NOT EXISTS telegram_bots (
  uid             text PRIMARY KEY,
  username        text NOT NULL,
  token_cipher    text NOT NULL,
  key_version     text NOT NULL,
  webhook_secret  text NOT NULL UNIQUE,
  created_at      text NOT NULL,
  updated_at      text NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_state (
  uid         text NOT NULL,
  mode        text NOT NULL CHECK (mode IN ('demo','live')),
  state       jsonb NOT NULL,
  updated_at  text NOT NULL,
  PRIMARY KEY (uid, mode)
);

-- journal / fills / considered are append-only record streams. The sort key
-- is pulled out of the JSON as a stored generated column so ORDER BY and the
-- range filters stay indexable while the record itself keeps whatever shape
-- the auto-trading client sends.
CREATE TABLE IF NOT EXISTS journal (
  uid     text NOT NULL,
  mode    text NOT NULL CHECK (mode IN ('demo','live')),
  id      text NOT NULL,
  record  jsonb NOT NULL,
  ts      text GENERATED ALWAYS AS (record->>'timestamp') STORED,
  type    text GENERATED ALWAYS AS (record->>'type') STORED,
  PRIMARY KEY (uid, mode, id)
);
CREATE INDEX IF NOT EXISTS journal_stream_idx ON journal (uid, mode, ts DESC);

CREATE TABLE IF NOT EXISTS fills (
  uid        text NOT NULL,
  mode       text NOT NULL CHECK (mode IN ('demo','live')),
  id         text NOT NULL,
  record     jsonb NOT NULL,
  filled_at  text GENERATED ALWAYS AS (record->>'filled_at') STORED,
  PRIMARY KEY (uid, mode, id)
);
CREATE INDEX IF NOT EXISTS fills_stream_idx ON fills (uid, mode, filled_at DESC);

CREATE TABLE IF NOT EXISTS considered (
  uid        text NOT NULL,
  mode       text NOT NULL CHECK (mode IN ('demo','live')),
  id         text NOT NULL,
  record     jsonb NOT NULL,
  logged_at  text GENERATED ALWAYS AS (record->>'logged_at') STORED,
  PRIMARY KEY (uid, mode, id)
);
CREATE INDEX IF NOT EXISTS considered_stream_idx ON considered (uid, mode, logged_at DESC);

CREATE TABLE IF NOT EXISTS snapshots (
  uid       text NOT NULL,
  mode      text NOT NULL CHECK (mode IN ('demo','live')),
  date      text NOT NULL,
  snapshot  jsonb NOT NULL,
  saved_at  text NOT NULL,
  PRIMARY KEY (uid, mode, date)
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id      text PRIMARY KEY,
  client_name    text NOT NULL,
  redirect_uris  jsonb NOT NULL,
  created_at     text NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash              text PRIMARY KEY,
  client_id              text NOT NULL,
  redirect_uri           text NOT NULL,
  code_challenge         text NOT NULL,
  code_challenge_method  text NOT NULL,
  uid                    text NOT NULL,
  mode                   text NOT NULL CHECK (mode IN ('demo','live')),
  access                 text NOT NULL,
  filters                jsonb,
  source_key_label       text,
  created_at             text NOT NULL,
  expires_at             text NOT NULL,
  redeemed_at            text
);
`;

let schemaReady: Promise<void> | null = null;

/**
 * Apply the schema once per process. Concurrent first-callers share the same
 * promise, so the DDL runs exactly once even if a burst of requests arrives
 * before it finishes.
 */
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool().query(SCHEMA);
      console.log(JSON.stringify({ severity: 'INFO', msg: 'db.schema.ready' }));
    })().catch((e) => {
      // Reset so the next request retries rather than caching the failure for
      // the lifetime of the container.
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

// ---- query helpers --------------------------------------------------------

/** Run a query, applying the schema first if this is the process's first call. */
export async function q<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  await ensureSchema();
  const res = await pool().query<T>(text, params);
  return res.rows;
}

/** Run a query expecting at most one row. */
export async function q1<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

/** Run `fn` inside a transaction, rolling back on throw. */
export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensureSchema();
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => { /* connection already gone */ });
    throw e;
  } finally {
    client.release();
  }
}

/** Test seam — drops the cached pool so a suite can point at a fresh database. */
export async function _resetPool(): Promise<void> {
  const p = poolInstance;
  poolInstance = null;
  schemaReady = null;
  await p?.end().catch(() => { /* nothing to close */ });
}
