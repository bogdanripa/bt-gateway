// server/router.ts
var Router = class {
  routes = [];
  add(method, path, handler) {
    const segments = split(path);
    this.routes.push({
      method: method.toUpperCase(),
      segments,
      literals: segments.filter((s) => !s.startsWith(":")).length,
      handler
    });
    this.routes.sort((a, b) => b.literals - a.literals);
    return this;
  }
  get(p, h) {
    return this.add("GET", p, h);
  }
  post(p, h) {
    return this.add("POST", p, h);
  }
  put(p, h) {
    return this.add("PUT", p, h);
  }
  patch(p, h) {
    return this.add("PATCH", p, h);
  }
  delete(p, h) {
    return this.add("DELETE", p, h);
  }
  /**
   * Resolve a request. Returns the handler plus its extracted params, or
   * `{ handler: null, allowed }` when the path exists under other methods —
   * which is a 405, not a 404, and the caller needs `allowed` for the `Allow`
   * header.
   */
  match(method, pathname) {
    const parts = split(pathname);
    const allowed = /* @__PURE__ */ new Set();
    for (const r of this.routes) {
      const params = matchSegments(r.segments, parts);
      if (!params) continue;
      allowed.add(r.method);
      if (r.method === method.toUpperCase()) {
        return { handler: r.handler, params, allowed: [...allowed] };
      }
    }
    return { handler: null, params: {}, allowed: [...allowed] };
  }
};
function split(path) {
  return path.split("/").filter(Boolean);
}
function matchSegments(pattern, parts) {
  if (pattern.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p.startsWith(":")) {
      try {
        params[p.slice(1)] = decodeURIComponent(parts[i]);
      } catch {
        return null;
      }
    } else if (p !== parts[i]) {
      return null;
    }
  }
  return params;
}

// lib/errors.ts
import crypto from "node:crypto";
var DEFAULT_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  CONFLICT: 409,
  UPSTREAM_UNAVAILABLE: 502,
  SESSION_EXPIRED: 503,
  INTERNAL: 500
};
var ApiError = class extends Error {
  code;
  status;
  /** Structured context attached to the log line, never shown to the caller. */
  context;
  constructor(code, message, opts) {
    super(message);
    this.code = code;
    this.status = opts?.status ?? DEFAULT_STATUS[code];
    this.context = opts?.context;
  }
};
function newRequestId() {
  return crypto.randomBytes(12).toString("base64url");
}
function json(body, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}
function toErrorResponse(err2, requestId) {
  if (err2 instanceof ApiError) {
    return json(
      { error: { code: err2.code, message: err2.message, requestId } },
      { status: err2.status }
    );
  }
  return json(
    { error: { code: "INTERNAL", message: "Internal error", requestId } },
    { status: 500 }
  );
}

// lib/oauth/state.ts
import crypto2 from "node:crypto";
var OAUTH_CODE_TTL_MS = 10 * 60 * 1e3;
function randomId(bytes = 16) {
  return crypto2.randomBytes(bytes).toString("base64url");
}
function hashCode(raw) {
  return crypto2.createHash("sha256").update(raw).digest("hex");
}
function verifyPkceS256(verifier, challenge2) {
  if (typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128) {
    return false;
  }
  const computed = crypto2.createHash("sha256").update(verifier).digest("base64url");
  if (computed.length !== challenge2.length) return false;
  try {
    return crypto2.timingSafeEqual(Buffer.from(computed), Buffer.from(challenge2));
  } catch {
    return false;
  }
}
function isValidRedirectUri(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return false;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") {
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  }
  return false;
}
function publicBaseUrl(req) {
  const configured = process.env.BT_GATEWAY_PUBLIC_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const h = req.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? new URL(req.url).host;
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim() ?? "https";
  return `${proto}://${host}`;
}

// server/routes/well-known.oauth-authorization-server.ts
async function GET(req) {
  const base = publicBaseUrl(req);
  return json(
    {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"]
    },
    {
      headers: {
        "cache-control": "public, max-age=300"
      }
    }
  );
}

// server/routes/well-known.oauth-protected-resource.ts
async function GET2(req) {
  const base = publicBaseUrl(req);
  return json(
    {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      resource_documentation: `${base}/`
    },
    {
      headers: {
        "cache-control": "public, max-age=300"
      }
    }
  );
}

// server/routes/api.health.ts
async function lookupEgressIp() {
  try {
    const res = await fetch("https://api.ipify.org?format=json", {
      // Short timeout — health checks fire on cold starts and from the
      // uptime monitor; we don't want a slow ipify request to make the
      // probe look unhealthy.
      // 8s, not 2s — cold-path VPC Connector adds a few seconds on first
      // egress. Tight timeouts here produce false "null" readings that are
      // indistinguishable from actual NAT/routing failure.
      signal: AbortSignal.timeout(8e3),
      cache: "no-store"
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.ip ?? null;
  } catch {
    return null;
  }
}
async function GET3() {
  const egressIp = await lookupEgressIp();
  return json(
    {
      ok: true,
      service: "bt-gateway",
      commit: process.env.BT_GATEWAY_COMMIT ?? "dev",
      egressIp,
      ts: (/* @__PURE__ */ new Date()).toISOString()
    },
    { headers: { "cache-control": "no-store" } }
  );
}

// lib/firebase/admin.ts
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
function projectId() {
  return process.env.FIREBASE_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? // Last-ditch fallback for local dev before we export the var.
  "auto-trader-493814";
}
var app = null;
function adminApp() {
  if (app) return app;
  if (getApps().length > 0) {
    app = getApps()[0];
    return app;
  }
  app = initializeApp({ projectId: projectId() });
  return app;
}
function adminAuth() {
  return getAuth(adminApp());
}

// lib/store.ts
import crypto3 from "node:crypto";

// lib/db.ts
import { Pool } from "pg";
var poolInstance = null;
function connectionString() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set \u2014 the app cannot reach its Postgres database. On the Pi this is injected automatically on deploy; locally, point it at your own Postgres instance."
    );
  }
  return url;
}
function pool() {
  if (!poolInstance) {
    poolInstance = new Pool({
      connectionString: connectionString(),
      // One always-warm instance serving a handful of requests a minute. A
      // small pool is plenty and keeps idle connections off the Pi.
      max: 8,
      idleTimeoutMillis: 3e4,
      connectionTimeoutMillis: 1e4
    });
    poolInstance.on("error", (err2) => {
      console.error(
        JSON.stringify({ severity: "ERROR", msg: "db.pool.error", err: err2.message })
      );
    });
  }
  return poolInstance;
}
var SCHEMA = `
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
var schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool().query(SCHEMA);
      console.log(JSON.stringify({ severity: "INFO", msg: "db.schema.ready" }));
    })().catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}
async function q(text, params = []) {
  await ensureSchema();
  const res = await pool().query(text, params);
  return res.rows;
}
async function q1(text, params = []) {
  const rows = await q(text, params);
  return rows[0] ?? null;
}

// lib/store.ts
var PENDING_TELEGRAM_LINK_TTL_MS = 10 * 60 * 1e3;
var TenantRef = class {
  /** @internal */
  constructor(uid) {
    this.uid = uid;
  }
  uid;
};
function tenantFromAuthedUid(uid) {
  if (!uid || typeof uid !== "string" || uid.length > 128) {
    throw new Error("invalid uid");
  }
  return new TenantRef(uid);
}
var BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function autoId() {
  const buf = crypto3.randomBytes(20);
  let out = "";
  for (let i = 0; i < 20; i++) out += BASE62[buf[i] % 62];
  return out;
}
var now = () => (/* @__PURE__ */ new Date()).toISOString();
async function getUser(t) {
  const row = await q1(
    `SELECT email, display_name, is_admin, created_at, updated_at
       FROM users WHERE uid = $1`,
    [t.uid]
  );
  if (!row) return null;
  return {
    email: row.email,
    displayName: row.display_name ?? void 0,
    isAdmin: row.is_admin,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
async function upsertUser(t, patch) {
  const ts = now();
  await q(
    `INSERT INTO users (uid, email, display_name, is_admin, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (uid) DO UPDATE
       SET email        = EXCLUDED.email,
           display_name = EXCLUDED.display_name,
           is_admin     = EXCLUDED.is_admin,
           updated_at   = EXCLUDED.updated_at`,
    [t.uid, patch.email, patch.displayName ?? null, patch.isAdmin, ts]
  );
}
async function getBtCreds(t, mode) {
  const row = await q1(
    `SELECT username_cipher, password_cipher, key_version, updated_at
       FROM bt_creds WHERE uid = $1 AND mode = $2`,
    [t.uid, mode]
  );
  if (!row) return null;
  return {
    mode,
    usernameCipher: row.username_cipher,
    passwordCipher: row.password_cipher,
    keyVersion: row.key_version,
    updatedAt: row.updated_at
  };
}
async function setBtCreds(t, doc) {
  await q(
    `INSERT INTO bt_creds (uid, mode, username_cipher, password_cipher, key_version, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (uid, mode) DO UPDATE
       SET username_cipher = EXCLUDED.username_cipher,
           password_cipher = EXCLUDED.password_cipher,
           key_version     = EXCLUDED.key_version,
           updated_at      = EXCLUDED.updated_at`,
    [t.uid, doc.mode, doc.usernameCipher, doc.passwordCipher, doc.keyVersion, now()]
  );
}
async function deleteBtCreds(t, mode) {
  await q(`DELETE FROM bt_creds WHERE uid = $1 AND mode = $2`, [t.uid, mode]);
}
async function getBtSession(t, mode) {
  const row = await q1(
    `SELECT snapshot, updated_at FROM bt_sessions WHERE uid = $1 AND mode = $2`,
    [t.uid, mode]
  );
  if (!row) return null;
  return { mode, snapshot: row.snapshot, updatedAt: row.updated_at };
}
async function setBtSession(t, mode, snapshot) {
  await q(
    `INSERT INTO bt_sessions (uid, mode, snapshot, updated_at)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (uid, mode) DO UPDATE
       SET snapshot = EXCLUDED.snapshot, updated_at = EXCLUDED.updated_at`,
    [t.uid, mode, JSON.stringify(snapshot ?? null), now()]
  );
}
async function deleteBtSession(t, mode) {
  await q(`DELETE FROM bt_sessions WHERE uid = $1 AND mode = $2`, [t.uid, mode]);
}
function toApiKeyDoc(row) {
  return {
    id: row.id,
    prefix: row.prefix,
    hash: row.hash,
    mode: row.mode,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? void 0,
    revokedAt: row.revoked_at ?? void 0,
    filters: row.filters ?? void 0,
    access: row.access ?? void 0,
    mcpClientId: row.mcp_client_id ?? void 0,
    mcpCreatedAt: row.mcp_created_at ?? void 0
  };
}
var API_KEY_COLS = `id, uid, prefix, hash, mode, label, created_at, last_used_at,
                      revoked_at, filters, access, mcp_client_id, mcp_created_at`;
async function createApiKey(t, doc) {
  const id = autoId();
  await q(
    `INSERT INTO api_keys (id, uid, prefix, hash, mode, label, created_at,
                           last_used_at, revoked_at, filters, access,
                           mcp_client_id, mcp_created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`,
    [
      id,
      t.uid,
      doc.prefix,
      doc.hash,
      doc.mode,
      doc.label,
      doc.createdAt,
      doc.lastUsedAt ?? null,
      doc.revokedAt ?? null,
      doc.filters ? JSON.stringify(doc.filters) : null,
      doc.access ?? null,
      doc.mcpClientId ?? null,
      doc.mcpCreatedAt ?? null
    ]
  );
  return id;
}
async function findApiKeyByHash(hash) {
  const row = await q1(
    `SELECT ${API_KEY_COLS} FROM api_keys WHERE hash = $1`,
    [hash]
  );
  return row ? { ...toApiKeyDoc(row), uid: row.uid } : null;
}
async function listApiKeys(t) {
  const rows = await q(
    `SELECT ${API_KEY_COLS} FROM api_keys WHERE uid = $1 ORDER BY created_at DESC`,
    [t.uid]
  );
  return rows.map(toApiKeyDoc);
}
async function revokeApiKey(t, id) {
  await q(`UPDATE api_keys SET revoked_at = $3 WHERE uid = $1 AND id = $2`, [
    t.uid,
    id,
    now()
  ]);
}
async function updateApiKeyFilters(t, id, filters) {
  await q(`UPDATE api_keys SET filters = $3::jsonb WHERE uid = $1 AND id = $2`, [
    t.uid,
    id,
    JSON.stringify(filters)
  ]);
}
async function touchApiKey(t, id) {
  await q(`UPDATE api_keys SET last_used_at = $3 WHERE uid = $1 AND id = $2`, [
    t.uid,
    id,
    now()
  ]);
}
async function findActiveMcpKey(t, mode) {
  const row = await q1(
    `SELECT ${API_KEY_COLS} FROM api_keys
      WHERE uid = $1 AND mode = $2 AND mcp_client_id IS NOT NULL AND revoked_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [t.uid, mode]
  );
  return row ? toApiKeyDoc(row) : null;
}
async function appendEvent(t, ev) {
  await q(
    `INSERT INTO events (uid, type, actor, mode, status, detail, error, ts)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
    [
      t.uid,
      ev.type,
      ev.actor,
      ev.mode ?? null,
      ev.status,
      ev.detail ? JSON.stringify(ev.detail) : null,
      ev.error ? JSON.stringify(ev.error) : null,
      ev.ts
    ]
  );
}
async function listEvents(t, opts = {}) {
  const params = [t.uid];
  let where = "uid = $1";
  if (opts.since) {
    params.push(opts.since);
    where += ` AND ts >= $${params.length}`;
  }
  params.push(opts.limit ?? 200);
  const rows = await q(
    `SELECT type, actor, mode, status, detail, error, ts
       FROM events WHERE ${where} ORDER BY ts DESC LIMIT $${params.length}`,
    params
  );
  const mapped = rows.map((r) => ({
    type: r.type,
    actor: r.actor,
    mode: r.mode ?? void 0,
    status: r.status,
    detail: r.detail ?? void 0,
    error: r.error ?? void 0,
    ts: r.ts
  }));
  if (opts.types?.length) return mapped.filter((r) => opts.types.includes(r.type));
  return mapped;
}
async function getTelegramLink(t) {
  const row = await q1(
    `SELECT chat_id, linked_at, username FROM telegram_links WHERE uid = $1`,
    [t.uid]
  );
  if (!row) return null;
  return {
    chatId: Number(row.chat_id),
    linkedAt: row.linked_at,
    username: row.username ?? void 0
  };
}
async function setTelegramLink(t, link) {
  await q(
    `INSERT INTO telegram_links (uid, chat_id, linked_at, username)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (uid) DO UPDATE
       SET chat_id = EXCLUDED.chat_id,
           linked_at = EXCLUDED.linked_at,
           username = EXCLUDED.username`,
    [t.uid, link.chatId, link.linkedAt, link.username ?? null]
  );
}
async function clearTelegramLink(t) {
  await q(`DELETE FROM telegram_links WHERE uid = $1`, [t.uid]);
}
async function setPendingTelegramLink(t, code) {
  await q(
    `INSERT INTO telegram_pending (uid, code, created_at)
     VALUES ($1,$2,$3)
     ON CONFLICT (uid) DO UPDATE
       SET code = EXCLUDED.code, created_at = EXCLUDED.created_at`,
    [t.uid, code, now()]
  );
}
async function clearPendingTelegramLink(t) {
  await q(`DELETE FROM telegram_pending WHERE uid = $1`, [t.uid]);
}
async function getPendingTelegramLinkForUid(t) {
  const row = await q1(
    `SELECT code, created_at FROM telegram_pending WHERE uid = $1`,
    [t.uid]
  );
  if (!row) return null;
  return {
    _type: "telegram_pending",
    code: row.code,
    uid: t.uid,
    createdAt: row.created_at
  };
}
function toBotDoc(row) {
  return {
    _type: "telegram_bot",
    username: row.username,
    tokenCipher: row.token_cipher,
    keyVersion: row.key_version,
    webhookSecret: row.webhook_secret,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
async function getTelegramBot(t) {
  const row = await q1(
    `SELECT uid, username, token_cipher, key_version, webhook_secret, created_at, updated_at
       FROM telegram_bots WHERE uid = $1`,
    [t.uid]
  );
  return row ? toBotDoc(row) : null;
}
async function setTelegramBot(t, doc) {
  await q(
    `INSERT INTO telegram_bots (uid, username, token_cipher, key_version,
                                webhook_secret, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (uid) DO UPDATE
       SET username       = EXCLUDED.username,
           token_cipher   = EXCLUDED.token_cipher,
           key_version    = EXCLUDED.key_version,
           webhook_secret = EXCLUDED.webhook_secret,
           updated_at     = EXCLUDED.updated_at`,
    [
      t.uid,
      doc.username,
      doc.tokenCipher,
      doc.keyVersion,
      doc.webhookSecret,
      doc.createdAt,
      doc.updatedAt
    ]
  );
}
async function deleteTelegramBot(t) {
  await q(`DELETE FROM telegram_bots WHERE uid = $1`, [t.uid]);
}
async function findTelegramBotByWebhookSecret(webhookSecret) {
  const row = await q1(
    `SELECT uid, username, token_cipher, key_version, webhook_secret, created_at, updated_at
       FROM telegram_bots WHERE webhook_secret = $1`,
    [webhookSecret]
  );
  return row ? { ...toBotDoc(row), uid: row.uid } : null;
}
async function getPortfolioState(t, mode) {
  const row = await q1(
    `SELECT state FROM portfolio_state WHERE uid = $1 AND mode = $2`,
    [t.uid, mode]
  );
  return row?.state ?? null;
}
async function setPortfolioState(t, mode, state) {
  await q(
    `INSERT INTO portfolio_state (uid, mode, state, updated_at)
     VALUES ($1,$2,$3::jsonb,$4)
     ON CONFLICT (uid, mode) DO UPDATE
       SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
    [t.uid, mode, JSON.stringify(state), now()]
  );
}
async function appendTo(table, t, mode, record, idField) {
  const explicit = record[idField];
  const id = typeof explicit === "string" && explicit.length > 0 ? explicit : autoId();
  await q(
    `INSERT INTO ${table} (uid, mode, id, record)
     VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (uid, mode, id) DO UPDATE SET record = EXCLUDED.record`,
    [t.uid, mode, id, JSON.stringify(record)]
  );
  return id;
}
async function listStream(table, sortCol, t, mode, opts, maxLimit) {
  const params = [t.uid, mode];
  let where = `uid = $1 AND mode = $2 AND ${sortCol} IS NOT NULL`;
  if (opts.since) {
    params.push(opts.since);
    where += ` AND ${sortCol} >= $${params.length}`;
  }
  if (opts.type) {
    params.push(opts.type);
    where += ` AND type = $${params.length}`;
  }
  params.push(Math.min(opts.limit ?? 500, maxLimit));
  const rows = await q(
    `SELECT record FROM ${table} WHERE ${where}
      ORDER BY ${sortCol} DESC LIMIT $${params.length}`,
    params
  );
  return rows.map((r) => r.record);
}
async function appendJournalEntry(t, mode, record) {
  return appendTo("journal", t, mode, record, "journal_id");
}
async function listJournalEntries(t, mode, opts = {}) {
  return listStream("journal", "ts", t, mode, opts, 5e3);
}
async function appendFillRecord(t, mode, record) {
  return appendTo("fills", t, mode, record, "fill_id");
}
async function listFillRecords(t, mode, opts = {}) {
  return listStream("fills", "filled_at", t, mode, opts, 5e3);
}
async function appendConsideredRecord(t, mode, record) {
  const enriched = { ...record, logged_at: record.logged_at ?? now() };
  return appendTo("considered", t, mode, enriched, "considered_id");
}
async function listConsideredRecords(t, mode, opts = {}) {
  return listStream("considered", "logged_at", t, mode, opts, 5e3);
}
async function saveMarketSnapshot(t, mode, date, snapshot) {
  await q(
    `INSERT INTO snapshots (uid, mode, date, snapshot, saved_at)
     VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT (uid, mode, date) DO UPDATE
       SET snapshot = EXCLUDED.snapshot, saved_at = EXCLUDED.saved_at`,
    [t.uid, mode, date, JSON.stringify(snapshot ?? null), now()]
  );
}
async function getMarketSnapshot(t, mode, date) {
  const row = await q1(
    `SELECT date, snapshot, saved_at FROM snapshots
      WHERE uid = $1 AND mode = $2 AND date = $3`,
    [t.uid, mode, date]
  );
  if (!row) return null;
  return { date: row.date, snapshot: row.snapshot, saved_at: row.saved_at };
}
async function listMarketSnapshots(t, mode, opts = {}) {
  const params = [t.uid, mode];
  let where = "uid = $1 AND mode = $2";
  if (opts.from) {
    params.push(opts.from);
    where += ` AND date >= $${params.length}`;
  }
  if (opts.to) {
    params.push(opts.to);
    where += ` AND date <= $${params.length}`;
  }
  params.push(Math.min(opts.limit ?? 90, 365));
  const rows = await q(
    `SELECT date, snapshot, saved_at FROM snapshots WHERE ${where}
      ORDER BY date DESC LIMIT $${params.length}`,
    params
  );
  return rows.map((r) => ({ date: r.date, snapshot: r.snapshot, saved_at: r.saved_at }));
}
async function createOauthClient(doc) {
  await q(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at)
     VALUES ($1,$2,$3::jsonb,$4)
     ON CONFLICT (client_id) DO UPDATE
       SET client_name   = EXCLUDED.client_name,
           redirect_uris = EXCLUDED.redirect_uris`,
    [doc.clientId, doc.clientName, JSON.stringify(doc.redirectUris), doc.createdAt]
  );
}
async function getOauthClient(clientId) {
  const row = await q1(
    `SELECT client_id, client_name, redirect_uris, created_at
       FROM oauth_clients WHERE client_id = $1`,
    [clientId]
  );
  if (!row) return null;
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: row.redirect_uris,
    createdAt: row.created_at
  };
}
async function createOauthCode(doc) {
  await q(
    `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge,
                              code_challenge_method, uid, mode, access, filters,
                              source_key_label, created_at, expires_at, redeemed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)`,
    [
      doc.codeHash,
      doc.clientId,
      doc.redirectUri,
      doc.codeChallenge,
      doc.codeChallengeMethod,
      doc.uid,
      doc.mode,
      doc.access,
      doc.filters ? JSON.stringify(doc.filters) : null,
      doc.sourceKeyLabel ?? null,
      doc.createdAt,
      doc.expiresAt,
      doc.redeemedAt ?? null
    ]
  );
}
async function consumeOauthCode(codeHash) {
  const row = await q1(
    `UPDATE oauth_codes
        SET redeemed_at = $2
      WHERE code_hash = $1
        AND redeemed_at IS NULL
        AND expires_at > $2
      RETURNING code_hash, client_id, redirect_uri, code_challenge,
                code_challenge_method, uid, mode, access, filters,
                source_key_label, created_at, expires_at, redeemed_at`,
    [codeHash, now()]
  );
  if (!row) return null;
  return {
    codeHash: row.code_hash,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    uid: row.uid,
    mode: row.mode,
    access: row.access,
    filters: row.filters ?? void 0,
    sourceKeyLabel: row.source_key_label ?? void 0,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at
  };
}

// lib/auth/session.ts
async function requireFirebaseUser(req) {
  const auth = req.headers.get("authorization");
  const m = auth?.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new ApiError("UNAUTHORIZED", "Missing ID token");
  const token = m[1].trim();
  try {
    const decoded = await adminAuth().verifyIdToken(token);
    const email = decoded.email ?? "";
    const bypassEnabled = process.env.ALLOW_UNVERIFIED_EMAIL === "1" && process.env.NODE_ENV !== "production";
    if (!decoded.email_verified && !bypassEnabled) {
      throw new ApiError("FORBIDDEN", "Email not verified");
    }
    return {
      tenant: tenantFromAuthedUid(decoded.uid),
      email,
      isAdmin: decoded.isAdmin === true
    };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("UNAUTHORIZED", "Invalid or expired ID token", {
      context: { err: e.message }
    });
  }
}

// lib/bt/client-pool.ts
import {
  BTTradeClient,
  ntfyOtpProvider,
  defaultNtfyTopic
} from "@bogdanripa/bt-trade";

// lib/bt/session-internals.ts
import { AuthError } from "@bogdanripa/bt-trade";
function isSessionExpired(e) {
  if (!e) return false;
  if (e instanceof AuthError) return true;
  const msg = e.message ?? "";
  if (!msg) return false;
  return /Session refresh failed|Refresh token has expired|NOT_LOGGED_IN|Cannot refresh/i.test(msg);
}
function rtTail(rt) {
  if (typeof rt !== "string" || rt.length < 8) return null;
  return rt.slice(-8);
}
function instrumentRefresh(client, ctx) {
  const auth = client.auth;
  const clearTimer = () => {
    if (auth._refreshTimer) {
      clearTimeout(auth._refreshTimer);
      auth._refreshTimer = null;
    }
  };
  clearTimer();
  const originalLogin = client.login.bind(client);
  client.login = async function(args) {
    try {
      return await originalLogin(args);
    } finally {
      clearTimer();
    }
  };
  const originalRestore = client.restore.bind(client);
  client.restore = function(snap) {
    try {
      return originalRestore(snap);
    } finally {
      clearTimer();
    }
  };
  const original = auth.refresh.bind(auth);
  auth.refresh = async function() {
    const before = client.toSnapshot();
    console.log(JSON.stringify({
      severity: "INFO",
      msg: "bt.refresh.summary.attempt",
      uid: ctx.uid,
      mode: ctx.mode,
      source: ctx.source,
      rtSentTail: rtTail(before?.refreshToken),
      rtSentExpiresAt: before?.refreshTokenExpires ?? null
    }));
    try {
      await original();
    } catch (e) {
      console.warn(JSON.stringify({
        severity: "WARNING",
        msg: "bt.refresh.summary.result",
        uid: ctx.uid,
        mode: ctx.mode,
        source: ctx.source,
        status: "err",
        rtSentTail: rtTail(before?.refreshToken),
        errMessage: e?.message ?? String(e)
      }));
      throw e;
    } finally {
      clearTimer();
    }
    const after = client.toSnapshot();
    console.log(JSON.stringify({
      severity: "INFO",
      msg: "bt.refresh.summary.result",
      uid: ctx.uid,
      mode: ctx.mode,
      source: ctx.source,
      status: "ok",
      rtSentTail: rtTail(before?.refreshToken),
      rtReceivedTail: rtTail(after?.refreshToken),
      rtRotated: !!after?.refreshToken && after.refreshToken !== before?.refreshToken,
      rtReceivedExpiresAt: after?.refreshTokenExpires ?? null,
      accessTokenExpiresAt: after?.expiresAt ? new Date(after.expiresAt).toISOString() : null
    }));
  };
}

// lib/secret-box.ts
import crypto4 from "node:crypto";
var VERSION = 1;
var IV_LEN = 12;
var TAG_LEN = 16;
var DEK_LEN = 32;
var WRAPPED_DEK_LEN = DEK_LEN + TAG_LEN;
function parseKey(raw) {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty master key");
  const key3 = Buffer.from(trimmed, "base64");
  if (key3.length !== 32) {
    throw new Error(
      `master key must be 32 bytes base64-encoded (got ${key3.length}); generate one with: openssl rand -base64 32`
    );
  }
  return key3;
}
function fingerprint(key3) {
  return "local:" + crypto4.createHash("sha256").update(key3).digest("hex").slice(0, 8);
}
var cached = null;
function keys() {
  if (cached) return cached;
  const raw = process.env.MASTER_KEY;
  if (!raw) {
    throw new Error(
      "MASTER_KEY is not set \u2014 cannot encrypt or decrypt stored credentials. Generate one with `openssl rand -base64 32` and set it on the app."
    );
  }
  const key3 = parseKey(raw);
  const primary = { key: key3, id: fingerprint(key3) };
  const previous = (process.env.MASTER_KEY_PREVIOUS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const k = parseKey(s);
    return { key: k, id: fingerprint(k) };
  });
  cached = { primary, previous };
  return cached;
}
function wrapDek(dek, kek) {
  const ivDek = crypto4.randomBytes(IV_LEN);
  const cipher = crypto4.createCipheriv("aes-256-gcm", kek, ivDek);
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final(), cipher.getAuthTag()]);
  return { ivDek, wrapped };
}
function unwrapDek(wrapped, ivDek, kek) {
  const body = wrapped.subarray(0, wrapped.length - TAG_LEN);
  const tag = wrapped.subarray(wrapped.length - TAG_LEN);
  const decipher = crypto4.createDecipheriv("aes-256-gcm", kek, ivDek);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
async function encrypt(plaintext) {
  const { primary } = keys();
  const dek = crypto4.randomBytes(DEK_LEN);
  try {
    const { ivDek, wrapped } = wrapDek(dek, primary.key);
    const ivBody = crypto4.randomBytes(IV_LEN);
    const cipher = crypto4.createCipheriv("aes-256-gcm", dek, ivBody);
    const body = Buffer.concat([
      cipher.update(Buffer.from(plaintext, "utf8")),
      cipher.final(),
      cipher.getAuthTag()
    ]);
    const blob = Buffer.concat([
      Buffer.from([VERSION]),
      ivDek,
      wrapped,
      ivBody,
      body
    ]);
    return { ciphertext: blob.toString("base64"), keyVersion: primary.id };
  } finally {
    dek.fill(0);
  }
}
async function decrypt(ciphertextB64) {
  const blob = Buffer.from(ciphertextB64, "base64");
  const minLen = 1 + IV_LEN + WRAPPED_DEK_LEN + IV_LEN + TAG_LEN;
  if (blob.length < minLen) throw new Error("ciphertext too short");
  const version = blob[0];
  if (version !== VERSION) {
    throw new Error(
      `unsupported ciphertext version ${version} \u2014 rows encrypted under Cloud KMS must be re-encrypted by the migration script`
    );
  }
  let off = 1;
  const ivDek = blob.subarray(off, off += IV_LEN);
  const wrapped = blob.subarray(off, off += WRAPPED_DEK_LEN);
  const ivBody = blob.subarray(off, off += IV_LEN);
  const bodyAndTag = blob.subarray(off);
  const body = bodyAndTag.subarray(0, bodyAndTag.length - TAG_LEN);
  const tag = bodyAndTag.subarray(bodyAndTag.length - TAG_LEN);
  const { primary, previous } = keys();
  let lastErr = null;
  for (const candidate of [primary, ...previous]) {
    let dek = null;
    try {
      dek = unwrapDek(wrapped, ivDek, candidate.key);
      const decipher = crypto4.createDecipheriv("aes-256-gcm", dek, ivBody);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch (e) {
      lastErr = e;
    } finally {
      dek?.fill(0);
    }
  }
  throw new Error(
    "could not decrypt with MASTER_KEY or any MASTER_KEY_PREVIOUS entry" + (lastErr instanceof Error ? `: ${lastErr.message}` : "")
  );
}

// lib/events.ts
async function audit(args) {
  const ev = {
    type: args.type,
    actor: args.actor,
    status: args.status,
    mode: args.mode,
    detail: args.detail,
    error: args.error,
    ts: (/* @__PURE__ */ new Date()).toISOString()
  };
  try {
    await appendEvent(args.tenant, ev);
  } catch (e) {
    console.error(
      JSON.stringify({
        severity: "ERROR",
        msg: "audit.firestore_write_failed",
        requestId: args.requestId,
        uid: args.tenant.uid,
        err: e.message
      })
    );
  }
  console.log(
    JSON.stringify({
      severity: args.status === "err" ? "WARNING" : "INFO",
      msg: `audit.${args.type}`,
      requestId: args.requestId,
      uid: args.tenant.uid,
      actor: args.actor,
      mode: args.mode,
      status: args.status,
      detail: args.detail,
      error: args.error,
      ts: ev.ts
    })
  );
}

// lib/telegram-bot.ts
async function sendMessageWithToken(botToken, chatId, text) {
  if (!botToken) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(5e3)
    });
    if (!res.ok) {
      console.error(
        JSON.stringify({
          severity: "WARNING",
          msg: "telegram.sendMessage_http_error",
          chatId,
          status: res.status
        })
      );
      return false;
    }
    return true;
  } catch (e) {
    console.error(
      JSON.stringify({
        severity: "WARNING",
        msg: "telegram.sendMessage_failed",
        chatId,
        err: e.message
      })
    );
    return false;
  }
}
async function setWebhook(botToken, url) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(8e3)
    });
    const body = await res.json();
    if (!body.ok) {
      console.error(
        JSON.stringify({
          severity: "WARNING",
          msg: "telegram.setWebhook_failed",
          description: body.description
        })
      );
      return false;
    }
    return true;
  } catch (e) {
    console.error(
      JSON.stringify({
        severity: "WARNING",
        msg: "telegram.setWebhook_error",
        err: e.message
      })
    );
    return false;
  }
}
async function getBotProfile(botToken) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      method: "GET",
      signal: AbortSignal.timeout(5e3)
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body.ok || !body.result?.username) return null;
    return { id: body.result.id, username: body.result.username };
  } catch {
    return null;
  }
}
async function getWebhookInfo(botToken) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, {
      method: "GET",
      signal: AbortSignal.timeout(5e3)
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body.ok || !body.result) return null;
    const r = body.result;
    return {
      url: r.url,
      pendingUpdateCount: r.pending_update_count,
      lastErrorDate: r.last_error_date ? new Date(r.last_error_date * 1e3).toISOString() : void 0,
      lastErrorMessage: r.last_error_message,
      ipAddress: r.ip_address,
      maxConnections: r.max_connections
    };
  } catch {
    return null;
  }
}

// lib/telegram.ts
async function notifyTenant(tenant, text) {
  const bot = await getTelegramBot(tenant).catch(() => null);
  if (!bot?.tokenCipher) return;
  const link = await getTelegramLink(tenant).catch(() => null);
  if (!link?.chatId) return;
  const token = await decrypt(bot.tokenCipher).catch(() => "");
  if (!token) {
    console.error(
      JSON.stringify({
        severity: "WARNING",
        msg: "telegram.notify_decrypt_failed",
        uid: tenant.uid
      })
    );
    return;
  }
  await sendMessageWithToken(token, link.chatId, text);
}

// lib/bt/client-pool.ts
var loginInProgress = /* @__PURE__ */ new Set();
var pool2 = /* @__PURE__ */ new Map();
var inflight = /* @__PURE__ */ new Map();
function key(t, mode) {
  return `${t.uid}:${mode}`;
}
function btLog(uid, mode) {
  if (process.env.BT_CLIENT_DEBUG !== "1") return () => {
  };
  return (msg, data) => {
    console.log(
      JSON.stringify({ severity: "DEBUG", msg: `bt.${msg}`, uid, mode, data })
    );
  };
}
function sessionExpiredError(t, mode, stage) {
  const message = stage === "login-in-progress" ? `BT ${mode} sign-in already in progress \u2014 retry shortly` : `BT ${mode} session expired \u2014 sign in to restore live data`;
  return new ApiError("SESSION_EXPIRED", message, { context: { uid: t.uid, mode, stage } });
}
async function buildClient(t, mode, interactive) {
  const creds = await getBtCreds(t, mode);
  if (!creds) {
    throw new ApiError(
      "UPSTREAM_UNAVAILABLE",
      `No ${mode} credentials set for this account`,
      { context: { uid: t.uid, mode, stage: "no-creds" } }
    );
  }
  const [username, password] = await Promise.all([
    decrypt(creds.usernameCipher),
    decrypt(creds.passwordCipher)
  ]);
  const otpProvider = ntfyOtpProvider({
    topic: defaultNtfyTopic(username),
    timeoutMs: 5 * 60 * 1e3,
    log: btLog(t.uid, mode)
  });
  const client = new BTTradeClient({
    demo: mode === "demo",
    otpProvider,
    log: btLog(t.uid, mode),
    timeoutMs: 3e4,
    onSessionChange: async (snap) => {
      if (!snap) {
        await deleteBtSession(t, mode).catch(() => {
        });
        return;
      }
      try {
        await setBtSession(t, mode, snap);
      } catch (e) {
        console.error(
          JSON.stringify({
            severity: "WARNING",
            msg: "bt.session_persist_failed",
            uid: t.uid,
            mode,
            err: e.message
          })
        );
      }
    },
    onExpired: (err2) => {
      void audit({
        tenant: t,
        type: "signin.failure",
        actor: "system",
        mode,
        status: "err",
        error: { code: "SESSION_EXPIRED", message: err2.message }
      });
      void notifyTenant(
        t,
        `bt-gateway: ${mode} session expired and could not auto-recover. Next API call will prompt for SMS OTP via ntfy.`
      );
      pool2.delete(key(t, mode));
    }
  });
  instrumentRefresh(client, { uid: t.uid, mode, source: "pool" });
  const existing = await getBtSession(t, mode);
  if (existing?.snapshot) {
    try {
      client.restore(existing.snapshot);
      void audit({
        tenant: t,
        type: "signin.restored",
        actor: "system",
        mode,
        status: "ok",
        detail: { username }
      });
      return { client, username };
    } catch (e) {
      console.log(
        JSON.stringify({
          severity: "WARNING",
          msg: "bt.restore_failed",
          uid: t.uid,
          mode,
          err: e.message
        })
      );
    }
  }
  if (!interactive) {
    throw sessionExpiredError(t, mode, "login-required");
  }
  if (loginInProgress.has(t.uid)) {
    throw sessionExpiredError(t, mode, "login-in-progress");
  }
  loginInProgress.add(t.uid);
  try {
    await client.login({ username, password });
  } catch (e) {
    const msg = e.message || "login failed";
    await audit({
      tenant: t,
      type: "signin.failure",
      actor: "system",
      mode,
      status: "err",
      error: { code: "LOGIN_FAILED", message: msg }
    });
    await notifyTenant(
      t,
      `bt-gateway: ${mode} sign-in failed: ${msg}`
    );
    throw new ApiError("UPSTREAM_UNAVAILABLE", `BT ${mode} sign-in failed: ${msg}`, {
      context: { uid: t.uid, mode, stage: "login" }
    });
  } finally {
    loginInProgress.delete(t.uid);
  }
  await audit({
    tenant: t,
    type: "signin.success",
    actor: "system",
    mode,
    status: "ok",
    detail: { username }
  });
  await notifyTenant(t, `bt-gateway: ${mode} sign-in OK for ${username}.`);
  return { client, username };
}
async function getBtClient(t, mode, opts = {}) {
  const interactive = opts.interactive ?? true;
  const k = key(t, mode);
  const hit = pool2.get(k);
  if (hit) return hit.client;
  const pending = inflight.get(k);
  if (pending) return (await pending).client;
  const p = buildClient(t, mode, interactive).then((entry) => {
    pool2.set(k, entry);
    return entry;
  }).finally(() => {
    inflight.delete(k);
  });
  inflight.set(k, p);
  return (await p).client;
}
function evictBtClient(t, mode) {
  pool2.delete(key(t, mode));
}
async function runWithSession(tenant, mode, op, opts = {}) {
  const interactive = opts.interactive ?? true;
  const client = await getBtClient(tenant, mode, { interactive });
  try {
    return await op(client);
  } catch (e) {
    if (!isSessionExpired(e)) throw e;
    evictBtClient(tenant, mode);
    await deleteBtSession(tenant, mode);
    try {
      const fresh = await getBtClient(tenant, mode, { interactive });
      return await op(fresh);
    } catch (e2) {
      if (!interactive && isSessionExpired(e2)) {
        throw sessionExpiredError(tenant, mode, "refresh-failed");
      }
      throw e2;
    }
  }
}
async function runWithSessionMutating(tenant, mode, op, opts = {}) {
  const interactive = opts.interactive ?? true;
  const client = await getBtClient(tenant, mode, { interactive });
  return op(client);
}

// lib/bt/portfolio-key.ts
var cache = /* @__PURE__ */ new Map();
function key2(t, mode) {
  return `${t.uid}:${mode}`;
}
async function getPortfolioKey(t, mode, client) {
  const k = key2(t, mode);
  const hit = cache.get(k);
  if (hit) return hit;
  const accounts = await client.accounts.list();
  const pick = accounts.find((a) => a.selected) ?? accounts.find((a) => a.allowTrading) ?? accounts[0];
  if (!pick?.portfolioKey) {
    throw new ApiError(
      "UPSTREAM_UNAVAILABLE",
      "No tradable account found for this session",
      { context: { uid: t.uid, mode, accountsCount: accounts.length } }
    );
  }
  cache.set(k, pick.portfolioKey);
  return pick.portfolioKey;
}
function evictPortfolioKey(t, mode) {
  cache.delete(key2(t, mode));
}

// lib/bt/currency.ts
var cache2 = /* @__PURE__ */ new Map();
function cacheKey(t, mode) {
  return `${t.uid}:${mode}`;
}
function validId(v) {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}
function isRonCurrency(name) {
  return typeof name === "string" && name.toUpperCase().includes("RON");
}
async function listEvaluationCurrencies(client) {
  const accounts = await client.accounts.list();
  const account = accounts.find((a) => a.selected) ?? accounts.find((a) => a.allowTrading) ?? accounts[0];
  if (!account) return [];
  const byId = /* @__PURE__ */ new Map();
  for (const p of account.portfolios ?? []) {
    for (const c of p.currencies ?? []) {
      if (c.id === void 0 || c.id === null || c.id === "") continue;
      const name = typeof c.name === "string" && c.name.trim() ? c.name.trim() : String(c.id);
      if (!byId.has(c.id)) byId.set(c.id, { id: c.id, name });
    }
  }
  return [...byId.values()];
}
async function getEvaluationCurrencyId(t, mode, client) {
  const k = cacheKey(t, mode);
  const hit = cache2.get(k);
  if (hit) return hit;
  try {
    const currencies2 = await listEvaluationCurrencies(client);
    const ron = currencies2.find((c) => isRonCurrency(c.name));
    const chosenId = validId(ron?.id ?? currencies2[0]?.id);
    if (chosenId) {
      cache2.set(k, chosenId);
      return chosenId;
    }
  } catch (e) {
    console.warn(
      JSON.stringify({ severity: "WARNING", msg: "currency.portfolio_currencies_failed", err: e.message })
    );
  }
  try {
    const profile = await client.profile.get();
    const id2 = validId(profile["selectedPortfolioPanelCurrencyID"]);
    if (id2) {
      cache2.set(k, id2);
      return id2;
    }
  } catch (e) {
    console.warn(
      JSON.stringify({ severity: "WARNING", msg: "currency.profile_failed", err: e.message })
    );
  }
  let currencies;
  try {
    const raw = await client.reference.listEvaluationCurrencies();
    currencies = Array.isArray(raw) ? raw : [];
  } catch (e) {
    throw new ApiError(
      "UPSTREAM_UNAVAILABLE",
      `Could not resolve evaluation currency: ${e.message}`,
      { context: { uid: t.uid, mode } }
    );
  }
  if (currencies.length === 0) {
    throw new ApiError(
      "UPSTREAM_UNAVAILABLE",
      "BT returned no evaluation currencies \u2014 cannot resolve currencyId",
      { context: { uid: t.uid, mode } }
    );
  }
  const isRon = (c) => {
    if (!c || typeof c !== "object") return false;
    const o = c;
    return ["Code", "code", "Symbol", "symbol", "Name", "name"].some(
      (f) => typeof o[f] === "string" && o[f].toUpperCase() === "RON"
    );
  };
  const chosen = currencies.find(isRon) ?? currencies[0];
  const idCandidate = chosen && typeof chosen === "object" ? chosen : null;
  const id = idCandidate ? validId(idCandidate["ID"] ?? idCandidate["Id"] ?? idCandidate["id"] ?? idCandidate["CurrencyID"] ?? idCandidate["currencyId"]) : null;
  if (!id) {
    throw new ApiError(
      "UPSTREAM_UNAVAILABLE",
      "BT evaluation currency has no usable id field",
      { context: { uid: t.uid, mode, sampleKeys: idCandidate ? Object.keys(idCandidate) : [] } }
    );
  }
  cache2.set(k, id);
  return id;
}
function evictEvaluationCurrency(t, mode) {
  cache2.delete(cacheKey(t, mode));
}

// lib/route-handler.ts
function withRoute(fn) {
  return async (req, ctx) => {
    const requestId = newRequestId();
    const start = Date.now();
    let status = 200;
    let errCode;
    const path = new URL(req.url).pathname;
    try {
      const res = await fn(req, { params: ctx.params, requestId });
      status = res.status;
      res.headers.set("x-request-id", requestId);
      return res;
    } catch (e) {
      const res = toErrorResponse(e, requestId);
      status = res.status;
      errCode = e instanceof ApiError ? e.code : "INTERNAL";
      console.error(
        JSON.stringify({
          severity: e instanceof ApiError && e.status < 500 ? "WARNING" : "ERROR",
          msg: "route.error",
          requestId,
          path,
          method: req.method,
          code: errCode,
          message: e?.message,
          context: e instanceof ApiError ? e.context : void 0,
          stack: e instanceof Error && !(e instanceof ApiError) ? e.stack : void 0
        })
      );
      res.headers.set("x-request-id", requestId);
      return res;
    } finally {
      console.log(
        JSON.stringify({
          severity: status >= 500 ? "ERROR" : "INFO",
          msg: "route.access",
          requestId,
          path,
          method: req.method,
          status,
          code: errCode,
          latencyMs: Date.now() - start
        })
      );
    }
  };
}
function ok(data, init = {}) {
  return json(data, init);
}
async function readJsonObject(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    throw new ApiError("BAD_REQUEST", "Body must be JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("BAD_REQUEST", "Body must be a JSON object");
  }
  return body;
}

// server/routes/api.ui.account.ts
var GET4 = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const rawMode = new URL(req.url).searchParams.get("mode") ?? "demo";
  if (rawMode !== "demo" && rawMode !== "live") {
    throw new ApiError("BAD_REQUEST", "mode must be demo or live");
  }
  const mode = rawMode;
  const payload = await runWithSession(caller.tenant, mode, async (client) => {
    const portfolioKey = await getPortfolioKey(caller.tenant, mode, client);
    const currencyId = await getEvaluationCurrencyId(caller.tenant, mode, client);
    const [cashResult, holdingsResult] = await Promise.allSettled([
      client.portfolio.getCash({ portfolioKey, currencyId }),
      client.portfolio.getHoldings({ portfolioKey })
    ]);
    const rejected = [cashResult, holdingsResult].filter(
      (r) => r.status === "rejected"
    );
    if (rejected.length === 2 && rejected.every((r) => isSessionExpired(r.reason))) {
      throw rejected[0].reason;
    }
    const cash = cashResult.status === "fulfilled" ? cashResult.value : null;
    const cashError = cashResult.status === "rejected" ? cashResult.reason.message : null;
    const holdings = holdingsResult.status === "fulfilled" ? holdingsResult.value : null;
    const holdingsError = holdingsResult.status === "rejected" ? holdingsResult.reason.message : null;
    return { currencyId, cash, cashError, holdings, holdingsError };
  });
  if (!payload.cash && !payload.holdings) {
    throw new ApiError(
      "UPSTREAM_UNAVAILABLE",
      `BT fetch failed: cash=${payload.cashError}; holdings=${payload.holdingsError}`
    );
  }
  return ok({ mode, ...payload });
});

// server/routes/api.ui.creds.$mode.ts
import { z } from "zod";

// lib/bt/markets-cache.ts
var cache3 = /* @__PURE__ */ new Map();
function cacheKey2(t, mode) {
  return `${t.uid}:${mode}`;
}
function pickStr(o, ...keys2) {
  for (const k of keys2) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return void 0;
}
async function loadMarketsBundle(client) {
  const raw = await client.markets.list();
  const byId = /* @__PURE__ */ new Map();
  const options = [];
  const seenCodes = /* @__PURE__ */ new Set();
  if (!Array.isArray(raw)) return { byId, options, raw };
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const o = m;
    const rawId = o.id ?? o.Id ?? o.ID;
    const id = typeof rawId === "number" ? rawId : typeof rawId === "string" && rawId.trim() ? Number(rawId) : NaN;
    const code = pickStr(o, "name", "Name", "key", "Key", "code", "Code");
    const desc = pickStr(o, "description", "Description");
    if (Number.isFinite(id) && code) byId.set(id, code);
    if (code && !seenCodes.has(code)) {
      seenCodes.add(code);
      options.push({ code, label: desc && desc !== code ? `${code} \u2014 ${desc}` : code });
    }
  }
  return { byId, options, raw };
}
function getMarkets(t, mode, client) {
  const k = cacheKey2(t, mode);
  const existing = cache3.get(k);
  if (existing) return existing;
  const p = loadMarketsBundle(client).catch((e) => {
    cache3.delete(k);
    throw e;
  });
  cache3.set(k, p);
  return p;
}
async function getMarketsCache(t, mode, client) {
  return (await getMarkets(t, mode, client)).byId;
}
function evictMarkets(t, mode) {
  cache3.delete(cacheKey2(t, mode));
}

// server/routes/api.ui.creds.$mode.ts
import { defaultNtfyTopic as defaultNtfyTopic2 } from "@bogdanripa/bt-trade";
function parseMode(raw) {
  if (raw !== "demo" && raw !== "live") {
    throw new ApiError("BAD_REQUEST", 'mode must be "demo" or "live"');
  }
  return raw;
}
function redact(s) {
  if (!s) return "";
  if (s.length <= 4) return s[0] + "\u2026" + s[s.length - 1];
  return `${s.slice(0, 2)}\u2026${s.slice(-2)}`;
}
var PutSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128)
});
var GET5 = withRoute(async (req, { params }) => {
  const caller = await requireFirebaseUser(req);
  const mode = parseMode(params.mode);
  const doc = await getBtCreds(caller.tenant, mode);
  if (!doc) return ok({ mode, set: false });
  const username = await decrypt(doc.usernameCipher).catch(() => "");
  const ntfyTopic = username ? defaultNtfyTopic2(username) : null;
  return ok({
    mode,
    set: true,
    usernameRedacted: redact(username),
    updatedAt: doc.updatedAt,
    ntfyTopic,
    ntfyUrl: ntfyTopic ? `https://ntfy.sh/${ntfyTopic}` : null
  });
});
var PUT = withRoute(async (req, { params, requestId }) => {
  const caller = await requireFirebaseUser(req);
  const mode = parseMode(params.mode);
  const parsed = PutSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError("BAD_REQUEST", "Invalid body", { context: { issues: parsed.error.issues } });
  }
  const { username, password } = parsed.data;
  const [u, p] = await Promise.all([encrypt(username), encrypt(password)]);
  await setBtCreds(caller.tenant, {
    mode,
    usernameCipher: u.ciphertext,
    passwordCipher: p.ciphertext,
    keyVersion: u.keyVersion,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  await deleteBtSession(caller.tenant, mode).catch(() => {
  });
  evictBtClient(caller.tenant, mode);
  evictPortfolioKey(caller.tenant, mode);
  evictEvaluationCurrency(caller.tenant, mode);
  evictMarkets(caller.tenant, mode);
  await audit({
    tenant: caller.tenant,
    type: "creds.updated",
    actor: "user",
    mode,
    status: "ok",
    requestId,
    detail: { usernameRedacted: redact(username) }
  });
  return ok({ mode, set: true });
});
var DELETE = withRoute(async (req, { params, requestId }) => {
  const caller = await requireFirebaseUser(req);
  const mode = parseMode(params.mode);
  await deleteBtCreds(caller.tenant, mode).catch(() => {
  });
  await deleteBtSession(caller.tenant, mode).catch(() => {
  });
  evictBtClient(caller.tenant, mode);
  evictPortfolioKey(caller.tenant, mode);
  evictEvaluationCurrency(caller.tenant, mode);
  evictMarkets(caller.tenant, mode);
  await audit({
    tenant: caller.tenant,
    type: "creds.updated",
    actor: "user",
    mode,
    status: "ok",
    requestId,
    detail: { action: "deleted" }
  });
  return ok({ mode, set: false });
});

// server/routes/api.ui.events.ts
var GET6 = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const sp = new URL(req.url).searchParams;
  const limit = Math.min(Math.max(Number(sp.get("limit") ?? 200), 1), 1e3);
  const typesRaw = sp.get("types");
  const types = typesRaw ? typesRaw.split(",").map((s) => s.trim()).filter(Boolean) : void 0;
  const events = await listEvents(caller.tenant, { limit, types });
  return ok({ events });
});

// server/routes/api.ui.keys.$id.ts
import { z as z2 } from "zod";

// lib/filters.ts
var emptyAxis = () => ({ include: [], exclude: [] });
var EMPTY_AXIS = emptyAxis();
var EMPTY_FILTERS = {
  markets: emptyAxis(),
  currencies: emptyAxis(),
  stocks: emptyAxis()
};
function norm(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t ? t.toUpperCase() : null;
}
function axisOf(filters, axis) {
  return filters?.[axis] ?? EMPTY_AXIS;
}
function hasConstraints(a) {
  return a.include.length > 0 || a.exclude.length > 0;
}
function matcherFor(axis, recordValue) {
  if (axis === "currencies") return (filterVal) => recordValue.includes(filterVal);
  return (filterVal) => filterVal === recordValue;
}
function isAllowedOn(filters, axis, value) {
  const a = axisOf(filters, axis);
  if (!hasConstraints(a)) return true;
  const v = norm(value);
  if (v == null) {
    return a.include.length === 0;
  }
  const match = matcherFor(axis, v);
  for (const x of a.exclude) {
    const n = norm(x);
    if (n && match(n)) return false;
  }
  if (a.include.length > 0) {
    let ok2 = false;
    for (const x of a.include) {
      const n = norm(x);
      if (n && match(n)) {
        ok2 = true;
        break;
      }
    }
    if (!ok2) return false;
  }
  return true;
}
function assertAllowed(filters, picks) {
  const checks = [
    ["markets", picks.market],
    ["currencies", picks.currency],
    ["stocks", picks.symbol]
  ];
  for (const [axis, v] of checks) {
    const a = axisOf(filters, axis);
    if (!hasConstraints(a)) continue;
    if (!isAllowedOn(filters, axis, v)) {
      const label = axis === "stocks" ? "symbol" : axis.replace(/s$/, "");
      const displayValue = v ?? "<unknown>";
      throw new ApiError(
        "FORBIDDEN",
        `This API key is not permitted to access ${label}=${displayValue}`,
        { context: { axis, value: v ?? null } }
      );
    }
  }
}
function filterRecords(records, filters, pick) {
  if (!filters) return [...records];
  const m = axisOf(filters, "markets");
  const c = axisOf(filters, "currencies");
  const s = axisOf(filters, "stocks");
  if (!hasConstraints(m) && !hasConstraints(c) && !hasConstraints(s)) return [...records];
  return records.filter((r) => {
    const fields = pick(r);
    if (hasConstraints(m) && !isAllowedOn(filters, "markets", fields.market)) return false;
    if (hasConstraints(c) && !isAllowedOn(filters, "currencies", fields.currency)) return false;
    if (hasConstraints(s) && !isAllowedOn(filters, "stocks", fields.symbol)) return false;
    return true;
  });
}
function filterByCurrencyOnly(records, filters, pickCurrency) {
  return records.filter((r) => isAllowedOn(filters, "currencies", pickCurrency(r)));
}
function filterPaginatedPayload(payload, filters, pick) {
  if (Array.isArray(payload)) {
    return filterRecords(payload, filters, pick);
  }
  if (payload && typeof payload === "object") {
    const obj = payload;
    const itemsKey = Array.isArray(obj.Items) ? "Items" : Array.isArray(obj.items) ? "items" : null;
    if (itemsKey) {
      const filtered = filterRecords(obj[itemsKey], filters, pick);
      obj[itemsKey] = filtered;
      if (typeof obj.TotalItemCount === "number") obj.TotalItemCount = filtered.length;
      else if (typeof obj.totalItemCount === "number") obj.totalItemCount = filtered.length;
    }
  }
  return payload;
}
var SYMBOL_KEYS = ["symbol", "Symbol", "code", "Code", "ticker", "Ticker"];
var MARKET_KEYS = ["market", "Market"];
var CURRENCY_KEYS = ["currency", "Currency"];
var NESTED_CURRENCY_CONTAINERS = ["value", "Value"];
var MARKET_ID_KEYS = ["MarketId", "marketId", "ExchangeId", "exchangeId"];
function pickNumber(o, keys2) {
  for (const k of keys2) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim()) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return void 0;
}
function readRecordFields(r, opts) {
  if (!r || typeof r !== "object") return {};
  const o = r;
  const pickStr2 = (obj, keys2) => {
    for (const k of keys2) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return void 0;
  };
  const nestedCurrency = () => {
    for (const k of NESTED_CURRENCY_CONTAINERS) {
      const parent = o[k];
      if (parent && typeof parent === "object") {
        const v = pickStr2(parent, CURRENCY_KEYS);
        if (v) return v;
      }
    }
    return void 0;
  };
  let market = pickStr2(o, MARKET_KEYS);
  if (opts?.marketsCache) {
    const mid = pickNumber(o, MARKET_ID_KEYS);
    if (mid !== void 0) {
      const canonical = opts.marketsCache.get(mid);
      if (canonical) market = canonical;
    }
  }
  return {
    market,
    currency: pickStr2(o, CURRENCY_KEYS) ?? nestedCurrency(),
    symbol: pickStr2(o, SYMBOL_KEYS)
  };
}
function filterPortfolioSelectResponse(payload, filters, marketsCache) {
  if (!filters || !payload || typeof payload !== "object") return payload;
  const root = payload;
  const read = (r) => readRecordFields(r, { marketsCache });
  const positions = root["Positions"] ?? root["positions"];
  if (positions && typeof positions === "object") {
    const pp = positions;
    const itemsKey = "Items" in pp ? "Items" : "items" in pp ? "items" : null;
    if (itemsKey && Array.isArray(pp[itemsKey])) {
      const filtered = filterRecords(pp[itemsKey], filters, read);
      pp[itemsKey] = filtered;
      if (typeof pp.TotalItemCount === "number") pp.TotalItemCount = filtered.length;
      else if (typeof pp.totalItemCount === "number") pp.totalItemCount = filtered.length;
    }
  }
  const totalKey = "Total" in root ? "Total" : "total" in root ? "total" : null;
  if (totalKey) {
    const total = root[totalKey];
    if (total && typeof total === "object") {
      const t = total;
      const sumKey = "Positions" in t ? "Positions" : "positions" in t ? "positions" : null;
      if (sumKey && Array.isArray(t[sumKey])) {
        const kept = [];
        for (const pos of t[sumKey]) {
          const next = filterPosition(pos, filters, marketsCache);
          if (next !== null) kept.push(next);
        }
        t[sumKey] = kept;
      }
      const tmbKey = "MoneyBalances" in t ? "MoneyBalances" : "moneyBalances" in t ? "moneyBalances" : null;
      if (tmbKey && Array.isArray(t[tmbKey])) {
        t[tmbKey] = filterByCurrencyOnly(
          t[tmbKey],
          filters,
          (b) => readRecordFields(b).currency ?? null
        );
      }
      const ratesKey = "CurrencyRates" in t ? "CurrencyRates" : "currencyRates" in t ? "currencyRates" : null;
      if (ratesKey && Array.isArray(t[ratesKey])) {
        t[ratesKey] = filterByCurrencyOnly(
          t[ratesKey],
          filters,
          (r) => {
            if (!r || typeof r !== "object") return null;
            const o = r;
            return typeof o.Name === "string" ? o.Name : typeof o.name === "string" ? o.name : null;
          }
        );
      }
    }
  }
  return payload;
}
function filterPosition(pos, filters, marketsCache) {
  if (!pos || typeof pos !== "object") return pos;
  const p = pos;
  const assetType = typeof p.AssetType === "string" ? p.AssetType : typeof p.assetType === "string" ? p.assetType : "";
  const isCash = assetType === "Numerar";
  if (isCash) {
    const balKey = "MoneyBalances" in p ? "MoneyBalances" : "moneyBalances" in p ? "moneyBalances" : null;
    if (balKey && Array.isArray(p[balKey])) {
      const kept = filterByCurrencyOnly(
        p[balKey],
        filters,
        (b) => readRecordFields(b).currency ?? null
      );
      if (kept.length === 0) return null;
      p[balKey] = kept;
    }
    return p;
  }
  const fields = readRecordFields(p, { marketsCache });
  if (!isAllowedOn(filters, "markets", fields.market ?? null)) return null;
  if (!isAllowedOn(filters, "currencies", fields.currency ?? null)) return null;
  if (!isAllowedOn(filters, "stocks", fields.symbol ?? null)) return null;
  return p;
}
function sanitizeFilters(input) {
  const out = {
    markets: { include: [], exclude: [] },
    currencies: { include: [], exclude: [] },
    stocks: { include: [], exclude: [] }
  };
  if (!input || typeof input !== "object") return out;
  const src = input;
  for (const axis of ["markets", "currencies", "stocks"]) {
    const a = src[axis];
    if (!a || typeof a !== "object") continue;
    const rec = a;
    for (const side of ["include", "exclude"]) {
      const list = rec[side];
      if (!Array.isArray(list)) continue;
      out[axis][side] = list.filter((x) => typeof x === "string").map((x) => x.trim()).filter((x) => x.length > 0 && x.length <= 32);
    }
  }
  return out;
}

// server/routes/api.ui.keys.$id.ts
var AxisSchema = z2.object({
  include: z2.array(z2.string()).default([]),
  exclude: z2.array(z2.string()).default([])
});
var PatchSchema = z2.object({
  filters: z2.object({
    markets: AxisSchema.default({ include: [], exclude: [] }),
    currencies: AxisSchema.default({ include: [], exclude: [] }),
    stocks: AxisSchema.default({ include: [], exclude: [] })
  })
});
var DELETE2 = withRoute(async (req, { params, requestId }) => {
  const caller = await requireFirebaseUser(req);
  const id = params.id;
  if (!id) throw new ApiError("BAD_REQUEST", "id path segment required");
  const keys2 = await listApiKeys(caller.tenant);
  const target = keys2.find((k) => k.id === id);
  if (!target) throw new ApiError("NOT_FOUND", "API key not found");
  await revokeApiKey(caller.tenant, id);
  await audit({
    tenant: caller.tenant,
    type: "apikey.revoked",
    actor: "user",
    mode: target.mode,
    status: "ok",
    requestId,
    detail: { id, prefix: target.prefix, label: target.label }
  });
  return ok({ id, revoked: true });
});
var PATCH = withRoute(async (req, { params, requestId }) => {
  const caller = await requireFirebaseUser(req);
  const id = params.id;
  if (!id) throw new ApiError("BAD_REQUEST", "id path segment required");
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError("BAD_REQUEST", "Invalid body", { context: { issues: parsed.error.issues } });
  }
  const keys2 = await listApiKeys(caller.tenant);
  const target = keys2.find((k) => k.id === id);
  if (!target) throw new ApiError("NOT_FOUND", "API key not found");
  if (target.revokedAt) throw new ApiError("CONFLICT", "Cannot edit filters on a revoked key");
  const filters = sanitizeFilters(parsed.data.filters);
  await updateApiKeyFilters(caller.tenant, id, filters);
  await audit({
    tenant: caller.tenant,
    type: "apikey.updated",
    actor: "user",
    mode: target.mode,
    status: "ok",
    requestId,
    detail: { id, prefix: target.prefix, label: target.label, filters }
  });
  return ok({ id, filters });
});

// server/routes/api.ui.keys.ts
import { z as z3 } from "zod";

// lib/auth/api-key.ts
import crypto5 from "node:crypto";

// lib/rate-limit.ts
var WINDOW_MS = 6e4;
var DEFAULT_MAX = 60;
var buckets = /* @__PURE__ */ new Map();
function checkRateLimit(key3, opts = {}) {
  const max = opts.max ?? DEFAULT_MAX;
  const now2 = Date.now();
  const bucket = buckets.get(key3) ?? { timestamps: [] };
  const cutoff = now2 - WINDOW_MS;
  let drop = 0;
  while (drop < bucket.timestamps.length && bucket.timestamps[drop] < cutoff) drop++;
  if (drop > 0) bucket.timestamps.splice(0, drop);
  if (bucket.timestamps.length >= max) {
    const oldest = bucket.timestamps[0];
    const retryAfterSec = Math.ceil((oldest + WINDOW_MS - now2) / 1e3);
    return { ok: false, retryAfterSec: Math.max(1, retryAfterSec) };
  }
  bucket.timestamps.push(now2);
  buckets.set(key3, bucket);
  return { ok: true };
}

// lib/auth/api-key.ts
var PREFIX_DEMO = "bvb_demo_";
var PREFIX_LIVE = "bvb_live_";
var BASE622 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function randomBase62(length) {
  const buf = crypto5.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += BASE622[buf[i] % 62];
  return out;
}
function generateApiKey(mode) {
  const prefix = mode === "demo" ? PREFIX_DEMO : PREFIX_LIVE;
  const tail = randomBase62(24);
  const key3 = prefix + tail;
  const hash = crypto5.createHash("sha256").update(key3).digest("hex");
  return {
    key: key3,
    hash,
    // prefix we store for UI identification (first 12 chars — enough to
    // disambiguate, small enough not to be useful for guessing).
    prefix: key3.slice(0, 12)
  };
}
function modeFromKey(raw) {
  if (raw.startsWith(PREFIX_DEMO)) return "demo";
  if (raw.startsWith(PREFIX_LIVE)) return "live";
  return null;
}
function timingSafeEqualStrings(a, b) {
  if (a.length !== b.length) return false;
  return crypto5.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function hashKey(raw) {
  return crypto5.createHash("sha256").update(raw).digest("hex");
}
function extractApiKey(req) {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  const alt = req.headers.get("x-api-key");
  return alt?.trim() || null;
}
async function authenticateApiKey(raw) {
  const mode = modeFromKey(raw);
  if (!mode) throw new ApiError("UNAUTHORIZED", "API key format invalid");
  const expectedHash = hashKey(raw);
  const keyDoc = await findApiKeyByHash(expectedHash);
  if (!keyDoc || keyDoc.revokedAt || keyDoc.mode !== mode) {
    throw new ApiError("UNAUTHORIZED", "API key not recognized");
  }
  if (!timingSafeEqualStrings(keyDoc.hash, expectedHash)) {
    throw new ApiError("UNAUTHORIZED", "API key not recognized");
  }
  const tenant = tenantFromAuthedUid(keyDoc.uid);
  return finalizeAuth(tenant, mode, keyDoc.id, keyDoc.filters, keyDoc.access);
}
function finalizeAuth(tenant, mode, keyId, filters, access) {
  const rl = checkRateLimit(`apikey:${keyId}`);
  if (!rl.ok) {
    throw new ApiError("RATE_LIMITED", "Too many requests", {
      context: { retryAfterSec: rl.retryAfterSec, kid: keyId }
    });
  }
  void touchApiKey(tenant, keyId).catch(() => {
  });
  return { tenant, mode, keyId, filters, access: access ?? "rw" };
}
async function requireApiKey(req) {
  const raw = extractApiKey(req);
  if (!raw) throw new ApiError("UNAUTHORIZED", "Missing API key");
  return authenticateApiKey(raw);
}
function assertWriteAccess(caller) {
  if (caller.access !== "rw") {
    throw new ApiError("FORBIDDEN", "This API key is read-only");
  }
}

// server/routes/api.ui.keys.ts
var AxisSchema2 = z3.object({
  include: z3.array(z3.string()).default([]),
  exclude: z3.array(z3.string()).default([])
});
var FiltersSchema = z3.object({
  markets: AxisSchema2.default({ include: [], exclude: [] }),
  currencies: AxisSchema2.default({ include: [], exclude: [] }),
  stocks: AxisSchema2.default({ include: [], exclude: [] })
});
var Schema = z3.object({
  mode: z3.enum(["demo", "live"]),
  label: z3.string().min(1).max(80),
  filters: FiltersSchema.optional()
});
var GET7 = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const keys2 = await listApiKeys(caller.tenant);
  const rows = keys2.map(({ hash: _hash, ...rest }) => rest);
  return ok({ keys: rows });
});
var POST = withRoute(async (req, { requestId }) => {
  const caller = await requireFirebaseUser(req);
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError("BAD_REQUEST", "Invalid body", { context: { issues: parsed.error.issues } });
  }
  const mode = parsed.data.mode;
  const { key: key3, hash, prefix } = generateApiKey(mode);
  const filters = parsed.data.filters ? sanitizeFilters(parsed.data.filters) : void 0;
  const id = await createApiKey(caller.tenant, {
    prefix,
    hash,
    mode,
    label: parsed.data.label,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    ...filters ? { filters } : {}
  });
  await audit({
    tenant: caller.tenant,
    type: "apikey.created",
    actor: "user",
    mode,
    status: "ok",
    requestId,
    detail: { id, prefix, label: parsed.data.label, filters: filters ?? null }
  });
  return ok({
    id,
    key: key3,
    prefix,
    mode,
    label: parsed.data.label,
    warning: "Save this key now. It will not be shown again."
  });
});

// server/routes/api.ui.lookup.currencies.ts
function pickString(o, ...keys2) {
  for (const k of keys2) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return void 0;
}
function reshape(currencies) {
  if (!Array.isArray(currencies)) return [];
  const out = [];
  for (const c of currencies) {
    if (!c || typeof c !== "object") continue;
    const o = c;
    const code = pickString(o, "code", "Code", "currency", "Currency", "currencyCode", "CurrencyCode", "symbol", "Symbol");
    if (!code) continue;
    const name = pickString(o, "name", "Name", "displayName", "DisplayName", "description", "Description");
    const up = code.toUpperCase();
    out.push({ code: up, label: name ? `${up} \u2014 ${name}` : up });
  }
  const seen = /* @__PURE__ */ new Set();
  return out.filter((o) => seen.has(o.code) ? false : (seen.add(o.code), true));
}
var GET8 = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const modeRaw = new URL(req.url).searchParams.get("mode");
  if (modeRaw !== "demo" && modeRaw !== "live") {
    throw new ApiError("BAD_REQUEST", 'mode query param must be "demo" or "live"');
  }
  const mode = modeRaw;
  const client = await getBtClient(caller.tenant, mode);
  try {
    const currencies = await client.reference.listCurrencies();
    return ok({ mode, currencies: reshape(currencies) });
  } catch (e) {
    throw new ApiError("UPSTREAM_UNAVAILABLE", `listCurrencies failed: ${e.message}`);
  }
});

// server/routes/api.ui.lookup.instruments.ts
function reshape2(hits) {
  if (!Array.isArray(hits)) return [];
  const out = [];
  for (const h of hits) {
    if (!h || typeof h !== "object") continue;
    const o = h;
    const code = typeof o.code === "string" ? o.code : typeof o.symbol === "string" ? o.symbol : void 0;
    if (!code) continue;
    const market = typeof o.market === "string" ? o.market : void 0;
    const name = typeof o.name === "string" ? o.name : typeof o.description === "string" ? o.description : "";
    const parts = [code];
    if (market) parts.push(`(${market})`);
    if (name) parts.push(`\u2014 ${name}`);
    out.push({ code: code.toUpperCase(), market, label: parts.join(" ") });
  }
  const seen = /* @__PURE__ */ new Set();
  return out.filter((o) => {
    const k = `${o.code}::${o.market ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
var GET9 = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const modeRaw = new URL(req.url).searchParams.get("mode");
  if (modeRaw !== "demo" && modeRaw !== "live") {
    throw new ApiError("BAD_REQUEST", 'mode query param must be "demo" or "live"');
  }
  const mode = modeRaw;
  const q2 = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (!q2) return ok({ mode, instruments: [] });
  const client = await getBtClient(caller.tenant, mode);
  try {
    const hits = await client.markets.searchInstrument(q2);
    return ok({ mode, instruments: reshape2(hits) });
  } catch (e) {
    throw new ApiError("UPSTREAM_UNAVAILABLE", `searchInstrument failed: ${e.message}`);
  }
});

// server/routes/api.ui.lookup.markets.ts
var GET10 = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const modeRaw = new URL(req.url).searchParams.get("mode");
  if (modeRaw !== "demo" && modeRaw !== "live") {
    throw new ApiError("BAD_REQUEST", 'mode query param must be "demo" or "live"');
  }
  const mode = modeRaw;
  const q2 = (new URL(req.url).searchParams.get("q") ?? "").trim().toLowerCase();
  const client = await getBtClient(caller.tenant, mode);
  try {
    const { options } = await getMarkets(caller.tenant, mode, client);
    const markets = q2 ? options.filter((m) => m.code.toLowerCase().includes(q2) || m.label.toLowerCase().includes(q2)) : options;
    return ok({ mode, markets });
  } catch (e) {
    throw new ApiError("UPSTREAM_UNAVAILABLE", `markets.list failed: ${e.message}`);
  }
});

// server/routes/api.ui.me.ts
var GET11 = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const user = await getUser(caller.tenant);
  return ok({ email: caller.email, isAdmin: caller.isAdmin, user });
});
var POST2 = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  await upsertUser(caller.tenant, {
    email: caller.email,
    isAdmin: caller.isAdmin
  });
  const user = await getUser(caller.tenant);
  return ok({ email: caller.email, isAdmin: caller.isAdmin, user });
});

// server/routes/api.ui.oauth.consent.ts
import { z as z4 } from "zod";
var Schema2 = z4.object({
  client_id: z4.string().min(1),
  redirect_uri: z4.string().url(),
  code_challenge: z4.string().min(43).max(128),
  code_challenge_method: z4.literal("S256"),
  state: z4.string().max(512).default(""),
  mode: z4.enum(["demo", "live"]),
  access: z4.enum(["read", "rw"]),
  keyId: z4.string().min(1).optional()
});
var POST3 = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const parsed = Schema2.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError("BAD_REQUEST", "Invalid consent body", {
      context: { issues: parsed.error.issues }
    });
  }
  const { client_id, redirect_uri, code_challenge, code_challenge_method, state, access, keyId } = parsed.data;
  const mode = parsed.data.mode;
  const client = await getOauthClient(client_id);
  if (!client) throw new ApiError("NOT_FOUND", "Unknown client_id");
  if (!client.redirectUris.includes(redirect_uri)) {
    throw new ApiError("BAD_REQUEST", "redirect_uri does not match registration");
  }
  const creds = await getBtCreds(caller.tenant, mode);
  if (!creds) {
    throw new ApiError(
      "BAD_REQUEST",
      `No ${mode} BT credentials configured. Set them up before connecting MCP.`
    );
  }
  let sourceFilters;
  let sourceLabel;
  if (keyId) {
    const keys2 = await listApiKeys(caller.tenant);
    const src = keys2.find((k) => k.id === keyId);
    if (!src) throw new ApiError("NOT_FOUND", "API key not found for filter inheritance");
    if (src.revokedAt) throw new ApiError("BAD_REQUEST", "Source API key is revoked");
    if (src.mode !== mode) {
      throw new ApiError(
        "BAD_REQUEST",
        `Source API key is ${src.mode} but the chosen mode is ${mode}`
      );
    }
    sourceFilters = src.filters;
    sourceLabel = src.label;
  }
  const rawCode = randomId(32);
  const codeHash = hashCode(rawCode);
  const now2 = /* @__PURE__ */ new Date();
  await createOauthCode({
    codeHash,
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    uid: caller.tenant.uid,
    mode,
    access,
    filters: sourceFilters,
    sourceKeyLabel: sourceLabel,
    createdAt: now2.toISOString(),
    expiresAt: new Date(now2.getTime() + OAUTH_CODE_TTL_MS).toISOString()
  });
  const url = new URL(redirect_uri);
  url.searchParams.set("code", rawCode);
  if (state) url.searchParams.set("state", state);
  return ok({ redirect: url.toString() });
});

// server/routes/api.ui.oauth.context.ts
var GET12 = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const sp = new URL(req.url).searchParams;
  const clientId = sp.get("client_id") ?? "";
  const redirectUri = sp.get("redirect_uri") ?? "";
  const codeChallenge = sp.get("code_challenge") ?? "";
  const codeChallengeMethod = sp.get("code_challenge_method") ?? "";
  const state = sp.get("state") ?? "";
  const responseType = sp.get("response_type") ?? "code";
  if (responseType !== "code") {
    throw new ApiError("BAD_REQUEST", 'response_type must be "code"');
  }
  if (codeChallengeMethod !== "S256") {
    throw new ApiError("BAD_REQUEST", 'code_challenge_method must be "S256"');
  }
  if (!codeChallenge || codeChallenge.length < 43 || codeChallenge.length > 128) {
    throw new ApiError("BAD_REQUEST", "code_challenge missing or invalid");
  }
  if (!clientId) throw new ApiError("BAD_REQUEST", "client_id missing");
  if (!redirectUri) throw new ApiError("BAD_REQUEST", "redirect_uri missing");
  const client = await getOauthClient(clientId);
  if (!client) throw new ApiError("NOT_FOUND", "Unknown client_id");
  if (!client.redirectUris.includes(redirectUri)) {
    throw new ApiError(
      "BAD_REQUEST",
      "redirect_uri does not match any URI registered for this client"
    );
  }
  const [demoCreds, liveCreds, keys2] = await Promise.all([
    getBtCreds(caller.tenant, "demo"),
    getBtCreds(caller.tenant, "live"),
    listApiKeys(caller.tenant)
  ]);
  const rows = keys2.filter((k) => !k.revokedAt).map((k) => ({
    id: k.id,
    label: k.label,
    mode: k.mode,
    prefix: k.prefix,
    filters: k.filters,
    hasFilters: !!(k.filters && (k.filters.markets.include.length || k.filters.markets.exclude.length || k.filters.currencies.include.length || k.filters.currencies.exclude.length || k.filters.stocks.include.length || k.filters.stocks.exclude.length))
  }));
  return ok({
    client: {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uri: redirectUri
    },
    modes: { demo: !!demoCreds, live: !!liveCreds },
    keys: rows,
    params: {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      state
    }
  });
});

// server/routes/api.ui.sessions.ts
function toIso(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? new Date(t).toISOString() : value;
  }
  return null;
}
function pickString2(o, key3) {
  const v = o[key3];
  return typeof v === "string" && v.length > 0 ? v : null;
}
async function loadOne(tenant, mode) {
  const [sessionDoc, state] = await Promise.all([
    getBtSession(tenant, mode),
    getPortfolioState(tenant, mode)
  ]);
  let accessExp = null;
  let refreshExp = null;
  let sessionId = null;
  if (sessionDoc?.snapshot && typeof sessionDoc.snapshot === "object") {
    const snap = sessionDoc.snapshot;
    accessExp = toIso(snap["expiresAt"]);
    refreshExp = toIso(snap["refreshTokenExpires"]);
    sessionId = pickString2(snap, "sessionId");
  }
  return {
    mode,
    hasSession: !!sessionDoc,
    sessionUpdatedAt: sessionDoc?.updatedAt ?? null,
    accessTokenExpiresAt: accessExp,
    refreshTokenExpiresAt: refreshExp,
    sessionId,
    lastKnownState: state
  };
}
var GET13 = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const [demo, live] = await Promise.all([
    loadOne(caller.tenant, "demo"),
    loadOne(caller.tenant, "live")
  ]);
  return ok({ sessions: [demo, live] });
});

// server/routes/api.ui.telegram.bot.ts
import crypto6 from "node:crypto";
import { z as z5 } from "zod";
var PutBody = z5.object({
  token: z5.string().trim().min(20, "token is too short").max(200, "token is too long")
});
function webhookUrl(req, secret) {
  const configured = process.env.BT_GATEWAY_PUBLIC_URL?.replace(/\/+$/, "");
  if (configured) return `${configured}/api/v1/telegram/webhook/${secret}`;
  const headers = req.headers;
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? new URL(req.url).host;
  const proto = headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? "https";
  return `${proto}://${host}/api/v1/telegram/webhook/${secret}`;
}
var GET14 = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const bot = await getTelegramBot(caller.tenant);
  if (!bot) return ok({ configured: false });
  const expectedUrl = webhookUrl(req, bot.webhookSecret);
  const token = await decrypt(bot.tokenCipher).catch(() => "");
  const webhookInfo = token ? await getWebhookInfo(token) : null;
  return ok({
    configured: true,
    username: bot.username,
    webhookUrl: expectedUrl,
    updatedAt: bot.updatedAt,
    webhookInfo: webhookInfo ? {
      url: webhookInfo.url,
      matches: webhookInfo.url === expectedUrl,
      pendingUpdateCount: webhookInfo.pendingUpdateCount,
      lastErrorDate: webhookInfo.lastErrorDate,
      lastErrorMessage: webhookInfo.lastErrorMessage,
      ipAddress: webhookInfo.ipAddress
    } : null
  });
});
var PUT2 = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const body = PutBody.parse(await req.json().catch(() => ({})));
  const profile = await getBotProfile(body.token);
  if (!profile) {
    throw new ApiError(
      "UPSTREAM_UNAVAILABLE",
      "Telegram did not accept that token. Double-check you copied the full token from @BotFather."
    );
  }
  const existing = await getTelegramBot(caller.tenant);
  const webhookSecret = existing?.webhookSecret ?? crypto6.randomBytes(24).toString("base64url");
  const { ciphertext, keyVersion } = await encrypt(body.token);
  const now2 = (/* @__PURE__ */ new Date()).toISOString();
  await setTelegramBot(caller.tenant, {
    _type: "telegram_bot",
    username: profile.username,
    tokenCipher: ciphertext,
    keyVersion,
    webhookSecret,
    createdAt: existing?.createdAt ?? now2,
    updatedAt: now2
  });
  if (existing && existing.username !== profile.username) {
    await clearTelegramLink(caller.tenant).catch(() => {
    });
  }
  const wUrl = webhookUrl(req, webhookSecret);
  const webhookOk = await setWebhook(body.token, wUrl);
  await audit({
    tenant: caller.tenant,
    type: "telegram.linked",
    actor: "user",
    status: "ok",
    detail: {
      step: "bot_configured",
      username: profile.username,
      rotated: !!existing,
      webhookRegistered: webhookOk
    }
  });
  return ok({
    configured: true,
    username: profile.username,
    webhookUrl: wUrl,
    webhookRegistered: webhookOk,
    updatedAt: now2
  });
});
var DELETE3 = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  await deleteTelegramBot(caller.tenant);
  await clearTelegramLink(caller.tenant).catch(() => {
  });
  await audit({
    tenant: caller.tenant,
    type: "telegram.unlinked",
    actor: "user",
    status: "ok",
    detail: { step: "bot_removed" }
  });
  return json({ ok: true });
});

// server/routes/api.ui.telegram.link-code.ts
import crypto7 from "node:crypto";
var ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode(length = 8) {
  const buf = crypto7.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}
var POST4 = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const bot = await getTelegramBot(caller.tenant);
  if (!bot) {
    throw new ApiError(
      "CONFLICT",
      "Configure your Telegram bot first (Settings \u2192 Telegram)."
    );
  }
  const code = makeCode();
  await setPendingTelegramLink(caller.tenant, code);
  return ok({
    code,
    ttlMs: 10 * 60 * 1e3,
    botUsername: bot.username,
    deepLink: `https://t.me/${bot.username}?start=${code}`
  });
});

// server/routes/api.ui.telegram.ts
var GET15 = withRoute(async (req) => {
  const caller = await requireFirebaseUser(req);
  const link = await getTelegramLink(caller.tenant);
  if (!link) return ok({ linked: false });
  return ok({
    linked: true,
    chatId: link.chatId,
    username: link.username,
    linkedAt: link.linkedAt
  });
});
var DELETE4 = withRoute(async (req, { requestId }) => {
  const caller = await requireFirebaseUser(req);
  await clearTelegramLink(caller.tenant);
  await audit({
    tenant: caller.tenant,
    type: "telegram.unlinked",
    actor: "user",
    status: "ok",
    requestId
  });
  return ok({ linked: false });
});

// server/routes/api.v1.cash.ts
function cashCurrency(entry) {
  if (!entry || typeof entry !== "object") return void 0;
  const e = entry;
  const v = e.value;
  if (v && typeof v === "object") {
    const c = v.currency;
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  const direct = e.currency ?? e.currencyId ?? e.currencyCode;
  return typeof direct === "string" && direct.trim() ? direct.trim() : void 0;
}
var GET16 = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const { portfolioKey, cash, errors } = await runWithSession(caller.tenant, caller.mode, async (client) => {
    const pk = await getPortfolioKey(caller.tenant, caller.mode, client);
    const currencies = await listEvaluationCurrencies(client);
    if (currencies.length === 0) {
      throw new ApiError(
        "UPSTREAM_UNAVAILABLE",
        "No evaluation currencies available on this portfolio",
        { context: { uid: caller.tenant.uid, mode: caller.mode } }
      );
    }
    const toFetch = [];
    for (const c of currencies) {
      if (isAllowedOn(caller.filters, "currencies", c.name)) toFetch.push(c);
    }
    if (toFetch.length === 0) {
      return { portfolioKey: pk, cash: [], errors: [] };
    }
    const results = await Promise.allSettled(
      toFetch.map((c) => client.portfolio.getCash({ portfolioKey: pk, currencyId: c.id }))
    );
    const rejected = results.filter((r) => r.status === "rejected");
    if (rejected.length === results.length && rejected.some((r) => isSessionExpired(r.reason))) {
      throw rejected.find((r) => isSessionExpired(r.reason)).reason;
    }
    const cashAcc = [];
    const errorsAcc = [];
    for (let i = 0; i < toFetch.length; i++) {
      const r = results[i];
      const cur = toFetch[i];
      if (r.status === "fulfilled") {
        const v = r.value;
        if (Array.isArray(v)) {
          for (const entry of v) cashAcc.push(entry);
        } else if (v !== null && v !== void 0) {
          cashAcc.push(v);
        }
      } else {
        errorsAcc.push({
          currency: cur.name,
          message: r.reason?.message ?? String(r.reason)
        });
      }
    }
    return { portfolioKey: pk, cash: cashAcc, errors: errorsAcc };
  });
  const filtered = filterByCurrencyOnly(
    cash,
    caller.filters,
    (entry) => cashCurrency(entry) ?? null
  );
  return ok({
    mode: caller.mode,
    portfolioKey,
    cash: filtered,
    ...errors.length ? { errors } : {}
  });
});

// server/routes/api.v1.considered.ts
var POST5 = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  assertWriteAccess(caller);
  const record = await readJsonObject(req);
  assertAllowed(caller.filters, readRecordFields(record));
  const id = await appendConsideredRecord(caller.tenant, caller.mode, record);
  return ok({ mode: caller.mode, id });
});
var GET17 = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const sp = new URL(req.url).searchParams;
  const records = await listConsideredRecords(caller.tenant, caller.mode, {
    since: sp.get("since") ?? void 0,
    limit: sp.get("limit") ? Number(sp.get("limit")) : void 0
  });
  return ok({ mode: caller.mode, records: filterRecords(records, caller.filters, readRecordFields) });
});

// server/routes/api.v1.fills.ts
var POST6 = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  assertWriteAccess(caller);
  const record = await readJsonObject(req);
  assertAllowed(caller.filters, readRecordFields(record));
  if (typeof record.filled_at !== "string" || !record.filled_at) {
    record.filled_at = (/* @__PURE__ */ new Date()).toISOString();
  }
  const id = await appendFillRecord(caller.tenant, caller.mode, record);
  return ok({ mode: caller.mode, id });
});
var GET18 = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const sp = new URL(req.url).searchParams;
  const records = await listFillRecords(caller.tenant, caller.mode, {
    since: sp.get("since") ?? void 0,
    limit: sp.get("limit") ? Number(sp.get("limit")) : void 0
  });
  return ok({ mode: caller.mode, records: filterRecords(records, caller.filters, readRecordFields) });
});

// server/routes/api.v1.holdings.ts
var GET19 = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const market = new URL(req.url).searchParams.get("market") ?? void 0;
  const endDate = new URL(req.url).searchParams.get("endDate") ?? void 0;
  if (market) assertAllowed(caller.filters, { market });
  let portfolioKey;
  let holdings;
  let marketsCache;
  try {
    ({ portfolioKey, holdings, marketsCache } = await runWithSession(
      caller.tenant,
      caller.mode,
      async (client) => {
        const pk = await getPortfolioKey(caller.tenant, caller.mode, client);
        const [h, mc] = await Promise.all([
          client.portfolio.getHoldings({ portfolioKey: pk, market, endDate }),
          getMarketsCache(caller.tenant, caller.mode, client)
        ]);
        return { portfolioKey: pk, holdings: h, marketsCache: mc };
      }
    ));
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("UPSTREAM_UNAVAILABLE", `BT getHoldings failed: ${e.message}`, {
      context: { uid: caller.tenant.uid, mode: caller.mode }
    });
  }
  const read = (r) => readRecordFields(r, { marketsCache });
  holdings = filterPortfolioSelectResponse(holdings, caller.filters, marketsCache);
  holdings = filterPaginatedPayload(holdings, caller.filters, read);
  return ok({ mode: caller.mode, portfolioKey, holdings });
});

// server/routes/api.v1.instruments.$symbol.ts
var GET20 = withRoute(async (req, { params }) => {
  const caller = await requireApiKey(req);
  const symbol = params.symbol?.toUpperCase();
  if (!symbol) throw new ApiError("BAD_REQUEST", "symbol path segment required");
  assertAllowed(caller.filters, { symbol });
  const overrideMarketId = new URL(req.url).searchParams.get("marketId");
  try {
    const { code, marketId, instrument, instruments, marketsCache } = await runWithSession(
      caller.tenant,
      caller.mode,
      async (client) => {
        const [portfolioKey, hits, marketsCache2] = await Promise.all([
          getPortfolioKey(caller.tenant, caller.mode, client),
          client.markets.searchInstrument(symbol),
          getMarketsCache(caller.tenant, caller.mode, client)
        ]);
        if (!Array.isArray(hits) || hits.length === 0) {
          throw new ApiError("NOT_FOUND", `Instrument not found: ${symbol}`);
        }
        const read = (r) => readRecordFields(r, { marketsCache: marketsCache2 });
        const allowed = filterRecords(hits, caller.filters, read);
        if (allowed.length === 0) {
          throw new ApiError(
            "FORBIDDEN",
            `Instrument ${symbol} has no listings accessible under this key's filters`,
            { context: { symbol, totalHits: hits.length } }
          );
        }
        const pick = overrideMarketId ? allowed.find((h) => String(h.marketId) === String(overrideMarketId)) : allowed[0];
        if (!pick) {
          const existsUnfiltered = hits.some(
            (h) => String(h.marketId) === String(overrideMarketId)
          );
          throw new ApiError(
            existsUnfiltered ? "FORBIDDEN" : "NOT_FOUND",
            existsUnfiltered ? `Listing ${symbol} on marketId=${overrideMarketId} is blocked by this key's filters` : `Instrument ${symbol} not listed on marketId=${overrideMarketId}`
          );
        }
        if (!pick.marketId) {
          throw new ApiError("UPSTREAM_UNAVAILABLE", "searchInstrument hit missing marketId");
        }
        const resolvedCode = pick.code ?? symbol;
        const inst = await client.markets.getInstrument({
          portfolioKey,
          code: resolvedCode,
          marketId: pick.marketId
        });
        return {
          code: resolvedCode,
          marketId: pick.marketId,
          instrument: inst,
          instruments: allowed,
          marketsCache: marketsCache2
        };
      }
    );
    assertAllowed(caller.filters, readRecordFields(instrument, { marketsCache }));
    return ok({
      mode: caller.mode,
      symbol: code,
      marketId,
      instruments,
      instrument
    });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("UPSTREAM_UNAVAILABLE", `getInstrument failed: ${e.message}`);
  }
});

// server/routes/api.v1.journal.ts
var POST7 = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  assertWriteAccess(caller);
  const record = await readJsonObject(req);
  assertAllowed(caller.filters, readRecordFields(record));
  if (typeof record.timestamp !== "string" || !record.timestamp) {
    record.timestamp = (/* @__PURE__ */ new Date()).toISOString();
  }
  const id = await appendJournalEntry(caller.tenant, caller.mode, record);
  return ok({ mode: caller.mode, id });
});
var GET21 = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const sp = new URL(req.url).searchParams;
  const records = await listJournalEntries(caller.tenant, caller.mode, {
    since: sp.get("since") ?? void 0,
    type: sp.get("type") ?? void 0,
    limit: sp.get("limit") ? Number(sp.get("limit")) : void 0
  });
  return ok({ mode: caller.mode, records: filterRecords(records, caller.filters, readRecordFields) });
});

// server/routes/api.v1.markets.ts
function marketCode(r) {
  if (!r || typeof r !== "object") return void 0;
  const o = r;
  for (const k of ["code", "market", "marketCode", "id"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return void 0;
}
var GET22 = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  try {
    let markets = await runWithSession(caller.tenant, caller.mode, (client) => client.markets.list());
    if (Array.isArray(markets)) {
      markets = filterRecords(markets, caller.filters, (m) => ({
        market: marketCode(m) ?? null
      }));
    }
    return ok({ mode: caller.mode, markets });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("UPSTREAM_UNAVAILABLE", `BT markets.list failed: ${e.message}`);
  }
});

// server/routes/api.v1.orders.$id.ts
var GET23 = withRoute(async (req, { params }) => {
  const caller = await requireApiKey(req);
  const id = params.id;
  if (!id) throw new ApiError("BAD_REQUEST", "order id path segment required");
  try {
    const { order, history, actions, marketsCache } = await runWithSession(
      caller.tenant,
      caller.mode,
      async (client) => {
        const [o, h, a, mc] = await Promise.all([
          client.orders.get(id),
          client.orders.getHistory(id).catch(() => null),
          client.orders.getActions(id).catch(() => null),
          getMarketsCache(caller.tenant, caller.mode, client)
        ]);
        return { order: o, history: h, actions: a, marketsCache: mc };
      }
    );
    assertAllowed(caller.filters, readRecordFields(order, { marketsCache }));
    return ok({ mode: caller.mode, order, history, actions });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("UPSTREAM_UNAVAILABLE", `orders.get failed: ${e.message}`);
  }
});

// server/routes/api.v1.orders.preview.ts
import { z as z6 } from "zod";

// lib/bt/instruments.ts
async function resolveInstrument(client, symbol, overrideMarketId) {
  const hits = await client.markets.searchInstrument(symbol);
  if (!Array.isArray(hits) || hits.length === 0) {
    throw new ApiError("NOT_FOUND", `Instrument not found: ${symbol}`);
  }
  const pick = overrideMarketId != null && overrideMarketId !== "" ? hits.find((h) => String(h.marketId) === String(overrideMarketId)) : hits[0];
  if (!pick) {
    throw new ApiError(
      "NOT_FOUND",
      `Instrument ${symbol} not listed on marketId=${overrideMarketId}`
    );
  }
  if (pick.marketId === void 0 || pick.marketId === null) {
    throw new ApiError("UPSTREAM_UNAVAILABLE", "searchInstrument hit missing marketId");
  }
  return {
    code: pick.code ?? symbol,
    marketId: pick.marketId,
    market: pick.market,
    currency: pick.currency
  };
}

// server/routes/api.v1.orders.preview.ts
var Schema3 = z6.object({
  symbol: z6.string().min(1).max(32),
  marketId: z6.union([z6.string(), z6.number()]).optional(),
  quantity: z6.number().positive().optional(),
  price: z6.number().positive(),
  side: z6.enum(["buy", "sell"]),
  type: z6.enum(["limit", "market"]).default("limit")
});
var POST8 = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const body = await req.json().catch(() => null);
  const parsed = Schema3.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("BAD_REQUEST", "Invalid preview body", {
      context: { issues: parsed.error.issues }
    });
  }
  const args = parsed.data;
  const symbolUp = args.symbol.toUpperCase();
  assertAllowed(caller.filters, { symbol: symbolUp });
  try {
    const { preview, resolvedCode, resolvedMarketId } = await runWithSession(
      caller.tenant,
      caller.mode,
      async (client) => {
        const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);
        const resolved = await resolveInstrument(client, symbolUp, args.marketId);
        assertAllowed(caller.filters, {
          symbol: resolved.code,
          market: resolved.market,
          currency: resolved.currency
        });
        const p = await client.orders.preview({
          portfolioKey,
          symbol: resolved.code,
          marketId: resolved.marketId,
          quantity: args.quantity ?? null,
          price: args.price,
          side: args.side,
          type: args.type
        });
        return { preview: p, resolvedCode: resolved.code, resolvedMarketId: resolved.marketId };
      }
    );
    return ok({ mode: caller.mode, symbol: resolvedCode, marketId: resolvedMarketId, preview });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("UPSTREAM_UNAVAILABLE", `preview failed: ${e.message}`);
  }
});

// server/routes/api.v1.orders.ts
import { z as z7 } from "zod";
var PlaceSchema = z7.object({
  symbol: z7.string().min(1).max(32),
  marketId: z7.union([z7.string(), z7.number()]).optional(),
  quantity: z7.number().int().positive(),
  price: z7.number().positive().optional(),
  side: z7.enum(["buy", "sell"]),
  type: z7.enum(["limit", "market"]).default("limit"),
  valability: z7.enum(["day", "gtc"]).default("day")
});
var POST9 = withRoute(async (req, { requestId }) => {
  const caller = await requireApiKey(req);
  assertWriteAccess(caller);
  const body = await req.json().catch(() => null);
  const parsed = PlaceSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("BAD_REQUEST", "Invalid order body", {
      context: { issues: parsed.error.issues }
    });
  }
  const args = parsed.data;
  if (args.type !== "market" && !args.price) {
    throw new ApiError("BAD_REQUEST", "price is required for non-market orders");
  }
  const symbolUp = args.symbol.toUpperCase();
  assertAllowed(caller.filters, { symbol: symbolUp });
  let symbol = symbolUp;
  let marketId = args.marketId;
  let result;
  try {
    result = await runWithSessionMutating(caller.tenant, caller.mode, async (client) => {
      const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);
      const resolved = await resolveInstrument(client, symbol, marketId);
      symbol = resolved.code;
      marketId = resolved.marketId;
      assertAllowed(caller.filters, {
        symbol: resolved.code,
        market: resolved.market,
        currency: resolved.currency
      });
      return client.orders.placeOrder({
        portfolioKey,
        symbol: resolved.code,
        marketId: resolved.marketId,
        quantity: args.quantity,
        price: args.price,
        side: args.side,
        type: args.type,
        valability: args.valability
      });
    });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const msg = e.message || "placeOrder failed";
    await audit({
      tenant: caller.tenant,
      type: "order.rejected",
      actor: `api_key:${caller.keyId}`,
      mode: caller.mode,
      status: "err",
      requestId,
      detail: { symbol, marketId, quantity: args.quantity, price: args.price, side: args.side, type: args.type },
      error: { code: "PLACE_FAILED", message: msg }
    });
    throw new ApiError("UPSTREAM_UNAVAILABLE", `placeOrder failed: ${msg}`);
  }
  await audit({
    tenant: caller.tenant,
    type: "order.placed",
    actor: `api_key:${caller.keyId}`,
    mode: caller.mode,
    status: "ok",
    requestId,
    detail: {
      symbol,
      marketId,
      quantity: args.quantity,
      price: args.price,
      side: args.side,
      type: args.type,
      valability: args.valability,
      // JSON round-trip strips any non-serializable values (Dates → strings,
      // functions dropped) so the audit write never silently fails.
      result: JSON.parse(JSON.stringify(result ?? null))
    }
  });
  return ok({ mode: caller.mode, order: result });
});
var GET24 = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const sp = new URL(req.url).searchParams;
  const statusesRaw = sp.get("statuses");
  const statuses = statusesRaw ? statusesRaw.split(",").map((s) => s.trim()).filter(Boolean) : void 0;
  const sideRaw = sp.get("side");
  const side = sideRaw === "buy" || sideRaw === "sell" ? sideRaw : void 0;
  const symbolParam = sp.get("symbol") ?? void 0;
  if (symbolParam) assertAllowed(caller.filters, { symbol: symbolParam });
  try {
    const { orders: rawOrders, marketsCache } = await runWithSession(
      caller.tenant,
      caller.mode,
      async (client) => {
        const portfolioKey = await getPortfolioKey(caller.tenant, caller.mode, client);
        const [o, mc] = await Promise.all([
          client.orders.search({
            portfolioKey,
            statuses,
            side,
            symbol: symbolParam,
            startDate: sp.get("startDate") ?? void 0,
            endDate: sp.get("endDate") ?? void 0
          }),
          getMarketsCache(caller.tenant, caller.mode, client)
        ]);
        return { orders: o, marketsCache: mc };
      }
    );
    const read = (r) => readRecordFields(r, { marketsCache });
    const orders = filterPaginatedPayload(rawOrders, caller.filters, read);
    return ok({ mode: caller.mode, orders });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("UPSTREAM_UNAVAILABLE", `orders.search failed: ${e.message}`);
  }
});

// server/routes/api.v1.session.refresh.ts
var POST10 = withRoute(async (req, { requestId }) => {
  const caller = await requireApiKey(req);
  const client = await getBtClient(caller.tenant, caller.mode, { interactive: false });
  try {
    await client.auth.refresh();
  } catch (e) {
    const msg = e.message || "refresh failed";
    await audit({
      tenant: caller.tenant,
      type: "refresh.failure",
      actor: `api_key:${caller.keyId}`,
      mode: caller.mode,
      status: "err",
      requestId,
      error: { code: "REFRESH_FAILED", message: msg }
    });
    throw new ApiError("UPSTREAM_UNAVAILABLE", `BT refresh failed: ${msg}`);
  }
  await audit({
    tenant: caller.tenant,
    type: "refresh.success",
    actor: `api_key:${caller.keyId}`,
    mode: caller.mode,
    status: "ok",
    requestId
  });
  return ok({ mode: caller.mode, refreshed: true });
});

// server/routes/api.v1.snapshots.$date.ts
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
var GET25 = withRoute(async (req, { params }) => {
  const caller = await requireApiKey(req);
  if (!DATE_RE.test(params.date)) {
    throw new ApiError("BAD_REQUEST", "date must be YYYY-MM-DD");
  }
  const record = await getMarketSnapshot(caller.tenant, caller.mode, params.date);
  return ok({ mode: caller.mode, date: params.date, record });
});
var PUT3 = withRoute(async (req, { params }) => {
  const caller = await requireApiKey(req);
  assertWriteAccess(caller);
  if (!DATE_RE.test(params.date)) {
    throw new ApiError("BAD_REQUEST", "date must be YYYY-MM-DD");
  }
  const body = await readJsonObject(req);
  await saveMarketSnapshot(caller.tenant, caller.mode, params.date, body);
  return ok({ mode: caller.mode, date: params.date, saved: true });
});

// server/routes/api.v1.snapshots.ts
var GET26 = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const sp = new URL(req.url).searchParams;
  const records = await listMarketSnapshots(caller.tenant, caller.mode, {
    from: sp.get("from") ?? void 0,
    to: sp.get("to") ?? void 0,
    limit: sp.get("limit") ? Number(sp.get("limit")) : void 0
  });
  return ok({ mode: caller.mode, records });
});

// server/routes/api.v1.state.portfolio.ts
var GET27 = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  const state = await getPortfolioState(caller.tenant, caller.mode);
  return ok({ mode: caller.mode, state });
});
var PUT4 = withRoute(async (req) => {
  const caller = await requireApiKey(req);
  assertWriteAccess(caller);
  const body = await readJsonObject(req);
  await setPortfolioState(caller.tenant, caller.mode, body);
  return ok({ mode: caller.mode, saved: true });
});

// server/routes/api.v1.telegram.webhook.$secret.ts
var okAck = () => json({ ok: true });
var POST11 = withRoute(async (req, { params, requestId }) => {
  if (!params.secret) {
    console.warn(
      JSON.stringify({
        severity: "WARNING",
        msg: "telegram.webhook_missing_secret",
        requestId
      })
    );
    return okAck();
  }
  let bot;
  try {
    bot = await findTelegramBotByWebhookSecret(params.secret);
  } catch (e) {
    console.error(
      JSON.stringify({
        severity: "ERROR",
        msg: "telegram.webhook_lookup_failed",
        requestId,
        err: e.message
      })
    );
    return okAck();
  }
  if (!bot) {
    console.warn(
      JSON.stringify({
        severity: "WARNING",
        msg: "telegram.webhook_no_bot_for_secret",
        requestId
      })
    );
    return okAck();
  }
  const t = tenantFromAuthedUid(bot.uid);
  let update;
  try {
    update = await req.json();
  } catch {
    return okAck();
  }
  const msg = update.message;
  if (!msg?.text || !msg.chat?.id) return okAck();
  const startMatch = msg.text.trim().match(/^\/start(?:\s+(\S+))?/i);
  if (!startMatch) return okAck();
  const code = startMatch[1];
  const chatId = msg.chat.id;
  const tgUsername = msg.from?.username ?? msg.chat.username;
  const botToken = await decrypt(bot.tokenCipher).catch(() => "");
  if (!botToken) {
    console.error(
      JSON.stringify({
        severity: "ERROR",
        msg: "telegram.webhook_decrypt_failed",
        requestId,
        uid: bot.uid
      })
    );
    return okAck();
  }
  if (!code) {
    await sendMessageWithToken(
      botToken,
      chatId,
      'Welcome to bt-gateway. To link your chat, go to /settings in the web UI, tap "Generate link code", and send it here with /start <code>.'
    );
    return okAck();
  }
  const pending = await getPendingTelegramLinkForUid(t).catch(() => null);
  const codeMatches = !!pending && pending.code === code && Date.now() - new Date(pending.createdAt).getTime() <= PENDING_TELEGRAM_LINK_TTL_MS;
  if (!codeMatches) {
    await sendMessageWithToken(
      botToken,
      chatId,
      "That link code is invalid or expired. Generate a new one in the web UI and send it within 10 minutes."
    );
    return okAck();
  }
  try {
    await setTelegramLink(t, {
      chatId,
      username: tgUsername,
      linkedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    await clearPendingTelegramLink(t).catch(() => {
    });
    await audit({
      tenant: t,
      type: "telegram.linked",
      actor: "user",
      status: "ok",
      requestId,
      detail: { chatId, username: tgUsername }
    });
    await sendMessageWithToken(
      botToken,
      chatId,
      "Linked. You will get an alert here when bt-gateway signs into BT Trade, or when a sign-in fails. Routine 45-minute refreshes will NOT be announced."
    );
  } catch (e) {
    console.error(
      JSON.stringify({
        severity: "ERROR",
        msg: "telegram.link_write_failed",
        requestId,
        uid: bot.uid,
        err: e.message
      })
    );
    await sendMessageWithToken(
      botToken,
      chatId,
      "Something went wrong saving the link. Please try again from the web UI."
    );
  }
  return okAck();
});

// lib/mcp/tools.ts
function str(v) {
  return typeof v === "string" && v.length > 0 ? v : void 0;
}
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : void 0;
}
var MCP_TOOLS = [
  {
    name: "get_cash",
    description: "Get cash balances in the user's BT trading account, across every evaluation currency the account holds. No arguments.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    invoke: () => ({ path: "/api/v1/cash", method: "GET" })
  },
  {
    name: "get_holdings",
    description: "List the user's open positions with current marks, market value, and unrealized P&L. No arguments.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    invoke: () => ({ path: "/api/v1/holdings", method: "GET" })
  },
  {
    name: "list_orders",
    description: "List the user's orders, optionally filtered. Statuses are BT's status codes (e.g. OPEN, FILLED, CANCELLED, REJECTED). Dates are YYYY-MM-DD.",
    inputSchema: {
      type: "object",
      properties: {
        statuses: {
          type: "array",
          items: { type: "string" },
          description: 'Optional status filter, e.g. ["OPEN","FILLED"].'
        },
        side: { type: "string", enum: ["buy", "sell"] },
        symbol: { type: "string" },
        startDate: { type: "string", description: "YYYY-MM-DD inclusive lower bound." },
        endDate: { type: "string", description: "YYYY-MM-DD inclusive upper bound." }
      },
      additionalProperties: false
    },
    invoke: (a) => {
      const sp = new URLSearchParams();
      if (Array.isArray(a.statuses)) sp.set("statuses", a.statuses.join(","));
      if (str(a.side)) sp.set("side", str(a.side));
      if (str(a.symbol)) sp.set("symbol", str(a.symbol));
      if (str(a.startDate)) sp.set("startDate", str(a.startDate));
      if (str(a.endDate)) sp.set("endDate", str(a.endDate));
      const q2 = sp.toString();
      return { path: `/api/v1/orders${q2 ? `?${q2}` : ""}`, method: "GET" };
    }
  },
  {
    name: "get_order",
    description: "Fetch a single order by its BT order ID.",
    inputSchema: {
      type: "object",
      properties: {
        orderId: { type: "string", description: "BT's opaque order ID." }
      },
      required: ["orderId"],
      additionalProperties: false
    },
    invoke: (a) => ({
      path: `/api/v1/orders/${encodeURIComponent(String(a.orderId))}`,
      method: "GET"
    })
  },
  {
    name: "get_instrument",
    description: "Look up an instrument by ticker symbol. Returns metadata, available listings/markets, and current quote info.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: 'Ticker symbol (case-insensitive), e.g. "TVBETETF", "TLV".' }
      },
      required: ["symbol"],
      additionalProperties: false
    },
    invoke: (a) => ({
      path: `/api/v1/instruments/${encodeURIComponent(String(a.symbol))}`,
      method: "GET"
    })
  },
  {
    name: "list_markets",
    description: "List the markets/exchanges available on BT Trade (Bucharest stock exchange segments, foreign markets, etc.). Useful for understanding what marketId values place_order accepts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    invoke: () => ({ path: "/api/v1/markets", method: "GET" })
  },
  {
    name: "preview_order",
    description: "Preview an order \u2014 get fees, net value, and validity \u2014 WITHOUT placing it. Always read-only.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        marketId: { type: ["string", "number"], description: "Optional; resolved from symbol if omitted." },
        quantity: { type: "number", minimum: 0 },
        price: { type: "number", exclusiveMinimum: 0 },
        side: { type: "string", enum: ["buy", "sell"] },
        type: { type: "string", enum: ["limit", "market"], default: "limit" }
      },
      required: ["symbol", "price", "side"],
      additionalProperties: false
    },
    invoke: (a) => ({
      path: "/api/v1/orders/preview",
      method: "POST",
      body: {
        symbol: a.symbol,
        marketId: a.marketId,
        quantity: num(a.quantity),
        price: num(a.price),
        side: a.side,
        type: a.type ?? "limit"
      }
    })
  },
  {
    name: "place_order",
    description: "Place an order on the user's BT account. Requires read+write access \u2014 read-only connections will get a FORBIDDEN error. Defaults: type=limit, valability=day.",
    mutating: true,
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        marketId: { type: ["string", "number"], description: "Optional; resolved from symbol if omitted." },
        quantity: { type: "number", minimum: 1 },
        price: { type: "number", exclusiveMinimum: 0, description: 'Required unless type is "market".' },
        side: { type: "string", enum: ["buy", "sell"] },
        type: { type: "string", enum: ["limit", "market"], default: "limit" },
        valability: { type: "string", enum: ["day", "gtc"], default: "day" }
      },
      required: ["symbol", "quantity", "side"],
      additionalProperties: false
    },
    invoke: (a) => ({
      path: "/api/v1/orders",
      method: "POST",
      body: {
        symbol: a.symbol,
        marketId: a.marketId,
        quantity: num(a.quantity),
        price: num(a.price),
        side: a.side,
        type: a.type ?? "limit",
        valability: a.valability ?? "day"
      }
    })
  }
];
function findTool(name) {
  return MCP_TOOLS.find((t) => t.name === name);
}

// server/routes/mcp.ts
var SERVER_INFO = { name: "bt-gateway", version: "1" };
var SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
var DEFAULT_PROTOCOL_VERSION = "2025-06-18";
function challenge(req, description) {
  const base = publicBaseUrl(req);
  const params = [
    'realm="bt-gateway"',
    `resource_metadata="${base}/.well-known/oauth-protected-resource"`
  ];
  if (description) params.push(`error_description="${description.replace(/"/g, '\\"')}"`);
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: description ?? "Authentication required" },
      id: null
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer ${params.join(", ")}`
      }
    }
  );
}
function rpcResult(id, result) {
  return json({ jsonrpc: "2.0", id: id ?? null, result });
}
function rpcError(id, code, message, data) {
  const body = {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...data !== void 0 ? { data } : {} }
  };
  return json(body);
}
function toolErrorContent(text, code) {
  return {
    content: [
      { type: "text", text: code ? `[${code}] ${text}` : text }
    ],
    isError: true
  };
}
function toolOkContent(payload) {
  return {
    content: [
      { type: "text", text: JSON.stringify(payload, null, 2) }
    ],
    isError: false
  };
}
async function handleInitialize(msg) {
  const params = msg.params ?? {};
  const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : void 0;
  const protocolVersion = requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
  return rpcResult(msg.id ?? null, {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO
  });
}
function handleToolsList(msg) {
  return rpcResult(msg.id ?? null, {
    tools: MCP_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }))
  });
}
async function handleToolCall(msg, caller, req, bearer) {
  const params = msg.params ?? {};
  const name = typeof params.name === "string" ? params.name : "";
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  const tool = findTool(name);
  if (!tool) {
    return rpcResult(msg.id ?? null, toolErrorContent(`Unknown tool: ${name}`, "TOOL_NOT_FOUND"));
  }
  if (tool.mutating && caller.access !== "rw") {
    return rpcResult(
      msg.id ?? null,
      toolErrorContent(
        `Tool "${tool.name}" requires read+write access. This connection is read-only \u2014 reconnect via OAuth and choose "Read & place orders" to enable it.`,
        "FORBIDDEN"
      )
    );
  }
  let plan;
  try {
    plan = tool.invoke(args);
  } catch (e) {
    return rpcResult(
      msg.id ?? null,
      toolErrorContent(`Bad arguments for ${tool.name}: ${e.message}`, "BAD_REQUEST")
    );
  }
  const base = publicBaseUrl(req);
  const url = `${base}${plan.path}`;
  const headers = { authorization: `Bearer ${bearer}` };
  let body;
  if (plan.body !== void 0) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(plan.body);
  }
  let res;
  try {
    res = await fetch(url, { method: plan.method, headers, body, cache: "no-store" });
  } catch (e) {
    return rpcResult(
      msg.id ?? null,
      toolErrorContent(`Network error calling BT Gateway: ${e.message}`, "NETWORK_ERROR")
    );
  }
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
    }
  }
  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message = `Request failed with status ${res.status}`;
    if (parsed && typeof parsed === "object") {
      const env = parsed.error;
      if (env?.code) code = env.code;
      if (env?.message) message = env.message;
    }
    return rpcResult(msg.id ?? null, toolErrorContent(message, code));
  }
  return rpcResult(msg.id ?? null, toolOkContent(parsed ?? text));
}
async function handle(req) {
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32e3, message: "Only POST is supported on /mcp" },
        id: null
      }),
      { status: 405, headers: { "content-type": "application/json", allow: "POST" } }
    );
  }
  const bearer = extractApiKey(req);
  if (!bearer) return challenge(req);
  let caller;
  try {
    caller = await authenticateApiKey(bearer);
  } catch (e) {
    if (e instanceof ApiError && (e.code === "UNAUTHORIZED" || e.code === "RATE_LIMITED")) {
      return challenge(req, e.message);
    }
    throw e;
  }
  let msg;
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  if (!msg || typeof msg !== "object") {
    return rpcError(null, -32600, "Invalid Request");
  }
  if (typeof msg.method !== "string") {
    return rpcError(msg.id ?? null, -32600, "Invalid Request: method missing");
  }
  if (msg.method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }
  switch (msg.method) {
    case "initialize":
      return handleInitialize(msg);
    case "tools/list":
      return handleToolsList(msg);
    case "tools/call":
      return handleToolCall(msg, caller, req, bearer);
    case "ping":
      return rpcResult(msg.id ?? null, {});
    case "prompts/list":
      return rpcResult(msg.id ?? null, { prompts: [] });
    case "resources/list":
      return rpcResult(msg.id ?? null, { resources: [] });
    default:
      return rpcError(msg.id ?? null, -32601, `Method not found: ${msg.method}`);
  }
}
var GET28 = handle;
var POST12 = handle;

// server/routes/oauth.register.ts
function clientError(error, description, status = 400) {
  return json({ error, error_description: description }, { status });
}
async function POST13(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return clientError("invalid_client_metadata", "Body must be JSON");
  }
  if (!body || typeof body !== "object") {
    return clientError("invalid_client_metadata", "Body must be a JSON object");
  }
  const rawUris = body.redirect_uris;
  if (!Array.isArray(rawUris) || rawUris.length === 0) {
    return clientError("invalid_redirect_uri", "redirect_uris must be a non-empty array");
  }
  if (rawUris.length > 8) {
    return clientError("invalid_redirect_uri", "too many redirect_uris");
  }
  const redirectUris = [];
  for (const u of rawUris) {
    if (typeof u !== "string" || !isValidRedirectUri(u)) {
      return clientError(
        "invalid_redirect_uri",
        `redirect_uri not allowed: ${typeof u === "string" ? u : "<non-string>"}`
      );
    }
    redirectUris.push(u);
  }
  if (body.grant_types !== void 0) {
    if (!Array.isArray(body.grant_types) || !body.grant_types.includes("authorization_code")) {
      return clientError(
        "invalid_client_metadata",
        "only the authorization_code grant is supported"
      );
    }
  }
  if (body.response_types !== void 0) {
    if (!Array.isArray(body.response_types) || !body.response_types.includes("code")) {
      return clientError(
        "invalid_client_metadata",
        "only response_type=code is supported"
      );
    }
  }
  if (body.token_endpoint_auth_method !== void 0 && body.token_endpoint_auth_method !== "none") {
    return clientError(
      "invalid_client_metadata",
      "only public clients (token_endpoint_auth_method=none) are supported"
    );
  }
  const clientName = typeof body.client_name === "string" && body.client_name.trim().length > 0 ? body.client_name.trim().slice(0, 120) : "MCP client";
  const clientId = `mcp_${randomId(16)}`;
  try {
    await createOauthClient({
      clientId,
      clientName,
      redirectUris,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  } catch (e) {
    console.error(
      JSON.stringify({
        severity: "ERROR",
        msg: "oauth.register.firestore_failed",
        err: e.message
      })
    );
    throw new ApiError("INTERNAL", "Failed to register client");
  }
  return json(
    {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    },
    { status: 201 }
  );
}

// server/routes/oauth.revoke.ts
import crypto8 from "node:crypto";
async function parseBody(req) {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(await req.text());
  }
  if (ct.includes("application/json")) {
    try {
      const obj = await req.json();
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") p.set(k, v);
      }
      return p;
    } catch {
      return null;
    }
  }
  return null;
}
async function POST14(req) {
  const params = await parseBody(req);
  const raw = params?.get("token")?.trim() ?? "";
  if (raw) {
    try {
      const hash = crypto8.createHash("sha256").update(raw).digest("hex");
      const found = await findApiKeyByHash(hash);
      if (found && !found.revokedAt) {
        const tenant = tenantFromAuthedUid(found.uid);
        await revokeApiKey(tenant, found.id);
        await audit({
          tenant,
          type: found.mcpClientId ? "mcp.revoked" : "apikey.revoked",
          actor: "mcp_client",
          mode: found.mode,
          status: "ok",
          detail: { keyId: found.id, via: "oauth/revoke" }
        });
      }
    } catch (e) {
      console.error(
        JSON.stringify({
          severity: "WARNING",
          msg: "oauth.revoke.failed",
          err: e.message
        })
      );
    }
  }
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}

// server/routes/oauth.token.ts
function err(error, description, status = 400) {
  return json(
    { error, error_description: description },
    {
      status,
      headers: {
        "cache-control": "no-store",
        pragma: "no-cache"
      }
    }
  );
}
async function parseBody2(req) {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    return new URLSearchParams(text);
  }
  if (ct.includes("application/json")) {
    try {
      const obj = await req.json();
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") p.set(k, v);
      }
      return p;
    } catch {
      return null;
    }
  }
  return null;
}
async function POST15(req) {
  const params = await parseBody2(req);
  if (!params) return err("invalid_request", "Body must be form-encoded or JSON");
  const grantType = params.get("grant_type");
  if (grantType !== "authorization_code") {
    return err("unsupported_grant_type", `grant_type=${grantType} not supported`);
  }
  const rawCode = params.get("code") ?? "";
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const codeVerifier = params.get("code_verifier") ?? "";
  if (!rawCode) return err("invalid_request", "code missing");
  if (!clientId) return err("invalid_request", "client_id missing");
  if (!redirectUri) return err("invalid_request", "redirect_uri missing");
  if (!codeVerifier) return err("invalid_request", "code_verifier missing");
  const client = await getOauthClient(clientId);
  if (!client) return err("invalid_client", "Unknown client_id", 401);
  const codeDoc = await consumeOauthCode(hashCode(rawCode));
  if (!codeDoc) return err("invalid_grant", "Code unknown, expired, or already redeemed");
  if (codeDoc.clientId !== clientId) {
    return err("invalid_grant", "code/client_id mismatch");
  }
  if (codeDoc.redirectUri !== redirectUri) {
    return err("invalid_grant", "redirect_uri does not match the code");
  }
  if (!verifyPkceS256(codeVerifier, codeDoc.codeChallenge)) {
    return err("invalid_grant", "PKCE verification failed");
  }
  const tenant = tenantFromAuthedUid(codeDoc.uid);
  const { key: key3, hash, prefix } = generateApiKey(codeDoc.mode);
  const label = codeDoc.sourceKeyLabel ? `MCP (${client.clientName}) \u2014 ${codeDoc.sourceKeyLabel}` : `MCP (${client.clientName})`;
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  try {
    const prior = await findActiveMcpKey(tenant, codeDoc.mode);
    if (prior) {
      await revokeApiKey(tenant, prior.id);
      await audit({
        tenant,
        type: "mcp.revoked",
        actor: "system",
        mode: codeDoc.mode,
        status: "ok",
        detail: { keyId: prior.id, reason: "superseded by new MCP grant" }
      });
    }
  } catch (e) {
    console.error(
      JSON.stringify({
        severity: "WARNING",
        msg: "oauth.token.prior_revoke_failed",
        uid: codeDoc.uid,
        mode: codeDoc.mode,
        err: e.message
      })
    );
  }
  const newKeyId = await createApiKey(tenant, {
    prefix,
    hash,
    mode: codeDoc.mode,
    label: label.slice(0, 80),
    createdAt: nowIso,
    filters: codeDoc.filters,
    access: codeDoc.access,
    mcpClientId: codeDoc.clientId,
    mcpCreatedAt: nowIso
  });
  await audit({
    tenant,
    type: "mcp.connected",
    actor: "user",
    mode: codeDoc.mode,
    status: "ok",
    detail: {
      keyId: newKeyId,
      clientId: codeDoc.clientId,
      clientName: client.clientName,
      access: codeDoc.access,
      hasFilters: !!codeDoc.filters,
      sourceKeyLabel: codeDoc.sourceKeyLabel
    }
  });
  return json(
    {
      access_token: key3,
      token_type: "Bearer",
      // No expiry: keys are revocable but don't expire by clock. MCP clients
      // re-authorize when the user revokes from Settings.
      scope: codeDoc.access === "rw" ? "read write" : "read"
    },
    {
      status: 200,
      headers: {
        "cache-control": "no-store",
        pragma: "no-cache"
      }
    }
  );
}

// server/registry.ts
function buildRouter() {
  const r = new Router();
  r.add("GET", "/.well-known/oauth-authorization-server", GET);
  r.add("GET", "/.well-known/oauth-protected-resource", GET2);
  r.add("GET", "/api/health", GET3);
  r.add("GET", "/api/ui/account", GET4);
  r.add("GET", "/api/ui/creds/:mode", GET5);
  r.add("PUT", "/api/ui/creds/:mode", PUT);
  r.add("DELETE", "/api/ui/creds/:mode", DELETE);
  r.add("GET", "/api/ui/events", GET6);
  r.add("PATCH", "/api/ui/keys/:id", PATCH);
  r.add("DELETE", "/api/ui/keys/:id", DELETE2);
  r.add("GET", "/api/ui/keys", GET7);
  r.add("POST", "/api/ui/keys", POST);
  r.add("GET", "/api/ui/lookup/currencies", GET8);
  r.add("GET", "/api/ui/lookup/instruments", GET9);
  r.add("GET", "/api/ui/lookup/markets", GET10);
  r.add("GET", "/api/ui/me", GET11);
  r.add("POST", "/api/ui/me", POST2);
  r.add("POST", "/api/ui/oauth/consent", POST3);
  r.add("GET", "/api/ui/oauth/context", GET12);
  r.add("GET", "/api/ui/sessions", GET13);
  r.add("GET", "/api/ui/telegram/bot", GET14);
  r.add("PUT", "/api/ui/telegram/bot", PUT2);
  r.add("DELETE", "/api/ui/telegram/bot", DELETE3);
  r.add("POST", "/api/ui/telegram/link-code", POST4);
  r.add("GET", "/api/ui/telegram", GET15);
  r.add("DELETE", "/api/ui/telegram", DELETE4);
  r.add("GET", "/api/v1/cash", GET16);
  r.add("GET", "/api/v1/considered", GET17);
  r.add("POST", "/api/v1/considered", POST5);
  r.add("GET", "/api/v1/fills", GET18);
  r.add("POST", "/api/v1/fills", POST6);
  r.add("GET", "/api/v1/holdings", GET19);
  r.add("GET", "/api/v1/instruments/:symbol", GET20);
  r.add("GET", "/api/v1/journal", GET21);
  r.add("POST", "/api/v1/journal", POST7);
  r.add("GET", "/api/v1/markets", GET22);
  r.add("GET", "/api/v1/orders/:id", GET23);
  r.add("POST", "/api/v1/orders/preview", POST8);
  r.add("GET", "/api/v1/orders", GET24);
  r.add("POST", "/api/v1/orders", POST9);
  r.add("POST", "/api/v1/session/refresh", POST10);
  r.add("GET", "/api/v1/snapshots/:date", GET25);
  r.add("PUT", "/api/v1/snapshots/:date", PUT3);
  r.add("GET", "/api/v1/snapshots", GET26);
  r.add("GET", "/api/v1/state/portfolio", GET27);
  r.add("PUT", "/api/v1/state/portfolio", PUT4);
  r.add("POST", "/api/v1/telegram/webhook/:secret", POST11);
  r.add("GET", "/mcp", GET28);
  r.add("POST", "/mcp", POST12);
  r.add("POST", "/oauth/register", POST13);
  r.add("POST", "/oauth/revoke", POST14);
  r.add("POST", "/oauth/token", POST15);
  return r;
}

// server/http.ts
import http from "node:http";
import { Readable } from "node:stream";
var BODYLESS = /* @__PURE__ */ new Set(["GET", "HEAD"]);
async function readBody(req) {
  if (BODYLESS.has(req.method ?? "GET")) return void 0;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  return body.length ? body : void 0;
}
function toRequest(req, body) {
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
  const proto = req.headers["x-forwarded-proto"]?.split(",")[0].trim() ?? "http";
  const url = `${proto}://${Array.isArray(host) ? host[0] : host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === void 0) continue;
    if (Array.isArray(v)) for (const one of v) headers.append(k, one);
    else headers.set(k, v);
  }
  return new Request(url, {
    method: req.method ?? "GET",
    headers,
    body
  });
}
async function send(res, out) {
  const headers = {};
  out.headers.forEach((value, key3) => {
    if (key3.toLowerCase() === "set-cookie") {
      headers[key3] = (headers[key3] ? [headers[key3]].flat() : []).concat(value);
    } else {
      headers[key3] = value;
    }
  });
  res.writeHead(out.status, headers);
  if (!out.body) {
    res.end();
    return;
  }
  Readable.fromWeb(out.body).pipe(res);
}
function createServer(router) {
  return http.createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      const request = toRequest(req, body);
      const { pathname } = new URL(request.url);
      const { handler, params, allowed } = router.match(req.method ?? "GET", pathname);
      if (!handler) {
        const requestId = newRequestId();
        if (allowed.length) {
          await send(
            res,
            json(
              {
                error: {
                  code: "BAD_REQUEST",
                  message: `Method ${req.method} not allowed on ${pathname}`,
                  requestId
                }
              },
              { status: 405, headers: { allow: allowed.sort().join(", ") } }
            )
          );
          return;
        }
        await send(
          res,
          json(
            { error: { code: "NOT_FOUND", message: "No such endpoint", requestId } },
            { status: 404 }
          )
        );
        return;
      }
      await send(res, await handler(request, { params }));
    } catch (e) {
      const requestId = newRequestId();
      console.error(
        JSON.stringify({
          severity: "ERROR",
          msg: "server.unhandled",
          requestId,
          path: req.url,
          method: req.method,
          message: e?.message,
          stack: e?.stack
        })
      );
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      }
      res.end(
        JSON.stringify({
          error: { code: "INTERNAL", message: "Internal error", requestId }
        })
      );
    }
  });
}
function listen(server2) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "::";
  server2.listen(port, host, () => {
    console.log(
      JSON.stringify({ severity: "INFO", msg: "server.listening", port, host })
    );
  });
}

// server/index.ts
var server = createServer(buildRouter());
server.on("clientError", (_err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});
process.on("unhandledRejection", (reason) => {
  console.error(
    JSON.stringify({
      severity: "ERROR",
      msg: "process.unhandledRejection",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : void 0
    })
  );
});
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(JSON.stringify({ severity: "INFO", msg: "server.shutdown", sig }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1e4).unref();
  });
}
listen(server);
//# sourceMappingURL=server.js.map
