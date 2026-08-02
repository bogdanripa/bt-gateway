/**
 * Data model + typed accessors, scoped per tenant. Backed by Postgres.
 *
 * This module replaces the former Firestore layer and deliberately keeps the
 * same exported surface — every helper takes the same arguments and returns
 * the same shapes — so the ~25 route handlers above it did not have to change
 * when the storage engine did.
 *
 * All persistent state belongs to a tenant. Every read and write MUST go
 * through one of the helpers in this file so we can guarantee there is no way
 * to accidentally cross tenants: there is no query that takes a uid as a
 * string parameter — the helpers take a `TenantRef` that you can only
 * construct from an authenticated caller's uid.
 *
 * Mode axis: a tenant can have BOTH a demo and a live BT session + keys. Every
 * mode-scoped table carries `mode` in its primary key. API keys encode the
 * mode in their prefix (bvb_demo_..., bvb_live_...) so a key can only interact
 * with its matching mode — a compromised demo key cannot touch live.
 *
 * Note on ordering: the record streams (journal / fills / considered) sort on
 * a field extracted from the JSON payload, and rows missing that field are
 * excluded from listings via `IS NOT NULL`. That mirrors Firestore, where a
 * document without the orderBy field simply does not appear in the query.
 */

import crypto from 'node:crypto';
import { q, q1 } from './db';

// ---- types ----------------------------------------------------------------

export type BtMode = 'demo' | 'live';

export interface UserDoc {
  email: string;
  displayName?: string;
  /** Read-only from the user's perspective; only set server-side. */
  isAdmin: boolean;
  createdAt: string;   // ISO
  updatedAt: string;   // ISO
}

/** Stored per (uid, mode). Envelope-encrypted BT credentials. */
export interface BtCredsDoc {
  mode: BtMode;
  usernameCipher: string;   // base64, envelope-encrypted (see lib/secret-box.ts)
  passwordCipher: string;   // base64, envelope-encrypted
  keyVersion: string;       // master-key fingerprint used — helps future rotation
  updatedAt: string;
}

/** Stored per (uid, mode). Refresh/access token snapshot from @bogdanripa/bt-trade. */
export interface BtSessionDoc {
  mode: BtMode;
  snapshot: unknown;  // opaque — whatever client.toSnapshot() returns
  updatedAt: string;
}

/**
 * Per-axis include/exclude lists. Semantics: `include` acts as an allowlist
 * (empty = no constraint); `exclude` is a deny-list applied after include.
 * Matching is case-insensitive and uses the raw string value as returned by
 * BT (market code, currency code, instrument symbol).
 */
export interface FilterAxis {
  include: string[];
  exclude: string[];
}

/**
 * Optional per-API-key filters. Each axis restricts what the key can see or
 * mutate across every /api/v1/* endpoint. An absent `filters` field (legacy
 * keys) means no restrictions.
 */
export interface ApiKeyFilters {
  markets: FilterAxis;
  currencies: FilterAxis;
  stocks: FilterAxis;
}

/** API key — hash only, prefix visible, mode-scoped. */
export interface ApiKeyDoc {
  /** First 12 chars of the full key, e.g. "bvb_demo_AbC" — shown in UI for identification. */
  prefix: string;
  /** sha256 of the full key. Verification is constant-time on this. */
  hash: string;
  mode: BtMode;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  /** Per-axis include/exclude filters. Optional; older keys won't have it. */
  filters?: ApiKeyFilters;
  /**
   * Permission scope for this key. `read` blocks all mutating routes
   * (currently: POST /api/v1/orders). Absent on legacy keys, which are
   * treated as full read+write.
   */
  access?: 'read' | 'rw';
  /**
   * Set when this key was minted via the MCP OAuth flow. Used by the
   * "one MCP connection at a time" rule: a new MCP grant revokes any
   * prior key with `mcpClientId` set for the same tenant + mode.
   */
  mcpClientId?: string;
  mcpCreatedAt?: string;
}

/**
 * Dynamic Client Registration record (RFC 7591). Stored globally rather than
 * per tenant because clients are not tenant-scoped — any tenant can
 * authenticate against a given registered client. The client is just a label
 * + redirect_uri allowlist.
 *
 * We only support PUBLIC clients (no client_secret) using PKCE.
 */
export interface OauthClientDoc {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
}

/**
 * One-shot authorization code minted at consent time and redeemed at the
 * token endpoint. Keyed by the sha256 of the raw code; the raw code is
 * delivered to the user agent only.
 *
 * `filters` is cloned at consent time from whichever ApiKeyDoc the user
 * chose, OR left undefined for "no filters". The resulting MCP-sourced
 * API key inherits these filters at token-exchange.
 */
export interface OauthCodeDoc {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  uid: string;
  mode: BtMode;
  access: 'read' | 'rw';
  filters?: ApiKeyFilters;
  /** Label of the source API key (for the resulting key's display name). */
  sourceKeyLabel?: string;
  createdAt: string;
  expiresAt: string;
  redeemedAt?: string;
}

/** Audit log entry — only mutating events land here. Reads do not. */
export interface EventDoc {
  type:
    | 'signin.success'
    | 'signin.failure'
    | 'signin.restored'
    | 'refresh.success'
    | 'refresh.failure'
    | 'logout'
    | 'order.placed'
    | 'order.cancelled'
    | 'order.rejected'
    | 'creds.updated'
    | 'apikey.created'
    | 'apikey.updated'
    | 'apikey.revoked'
    | 'telegram.linked'
    | 'telegram.unlinked'
    | 'mcp.connected'
    | 'mcp.revoked';
  /** Who caused the event — 'user' (UI), 'api_key:<kid>' (programmatic), 'cron', 'system'. */
  actor: string;
  mode?: BtMode;
  status: 'ok' | 'err';
  /** Small structured payload. NEVER include credentials or tokens. */
  detail?: Record<string, unknown>;
  error?: { code?: string; message?: string };
  ts: string;
}

/** Optional Telegram linkage. */
export interface TelegramLinkDoc {
  chatId: number;
  linkedAt: string;
  /** Username at link time — for display only; users can rename. */
  username?: string;
}

/**
 * Pending Telegram link code. The webhook looks it up by code so it doesn't
 * need to know the uid in advance — the user's `/start <code>` message
 * resolves to the uid via the pending row, then this row is deleted and the
 * real `telegram` link is written. Codes live for
 * `PENDING_TELEGRAM_LINK_TTL_MS` after which the webhook rejects them.
 */
export interface PendingTelegramLinkDoc {
  _type: 'telegram_pending';
  code: string;
  uid: string;
  createdAt: string;
}

export const PENDING_TELEGRAM_LINK_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Per-user Telegram bot. Each tenant brings their own bot (created via
 * @BotFather) so there's no shared-bot attack surface and alerts come from
 * a handle the user owns.
 *
 * `webhookSecret` is a 24-byte random string used as the path segment in
 * the webhook URL (/api/v1/telegram/webhook/:secret). It doubles as the
 * lookup key — the webhook resolves sender → uid through it.
 */
export interface TelegramBotDoc {
  _type: 'telegram_bot';
  /** Bot @handle without the leading @. Display-only; can be renamed on Telegram. */
  username: string;
  /** Envelope-encrypted bot token from @BotFather. */
  tokenCipher: string;
  keyVersion: string;
  /** Random opaque secret that acts as the webhook path segment. */
  webhookSecret: string;
  createdAt: string;
  updatedAt: string;
}

// ---- tenant reference ------------------------------------------------------

/**
 * Opaque wrapper around a uid. The only legitimate way to construct one is
 * through `tenantFromAuthedUid()` — downstream code that needs a TenantRef
 * must accept it as a parameter, never synthesize from a raw string. This
 * prevents accidentally reading another user's data.
 */
export class TenantRef {
  /** @internal */
  constructor(public readonly uid: string) {}
}

/**
 * Construct a TenantRef from a uid that has already been authenticated.
 * Named deliberately to force callers to think about where the uid came from.
 */
export function tenantFromAuthedUid(uid: string): TenantRef {
  if (!uid || typeof uid !== 'string' || uid.length > 128) {
    throw new Error('invalid uid');
  }
  return new TenantRef(uid);
}

// ---- id generation ---------------------------------------------------------

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 20-char base62 id, matching the shape of the Firestore auto-ids these
 * tables inherited so migrated and freshly-minted rows look alike.
 */
function autoId(): string {
  const buf = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) out += BASE62[buf[i] % 62];
  return out;
}

const now = () => new Date().toISOString();

// ---- users ----------------------------------------------------------------

interface UserRow {
  email: string;
  display_name: string | null;
  is_admin: boolean;
  created_at: string;
  updated_at: string;
}

export async function getUser(t: TenantRef): Promise<UserDoc | null> {
  const row = await q1<UserRow>(
    `SELECT email, display_name, is_admin, created_at, updated_at
       FROM users WHERE uid = $1`,
    [t.uid],
  );
  if (!row) return null;
  return {
    email: row.email,
    displayName: row.display_name ?? undefined,
    isAdmin: row.is_admin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Upsert a user row on sign-in. The `isAdmin` field mirrors the Firebase
 * custom claim and is NEVER accepted from a caller-supplied patch — custom
 * claims are authoritative and the only legitimate way to promote a user is
 * out-of-band. This helper reads `isAdmin` directly from the authenticated
 * caller's claim, not from `patch`.
 */
export async function upsertUser(
  t: TenantRef,
  patch: { email: string; displayName?: string; isAdmin: boolean },
): Promise<void> {
  const ts = now();
  await q(
    `INSERT INTO users (uid, email, display_name, is_admin, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (uid) DO UPDATE
       SET email        = EXCLUDED.email,
           display_name = EXCLUDED.display_name,
           is_admin     = EXCLUDED.is_admin,
           updated_at   = EXCLUDED.updated_at`,
    [t.uid, patch.email, patch.displayName ?? null, patch.isAdmin, ts],
  );
}

// ---- BT creds + sessions ---------------------------------------------------

export async function getBtCreds(t: TenantRef, mode: BtMode): Promise<BtCredsDoc | null> {
  const row = await q1<{
    username_cipher: string;
    password_cipher: string;
    key_version: string;
    updated_at: string;
  }>(
    `SELECT username_cipher, password_cipher, key_version, updated_at
       FROM bt_creds WHERE uid = $1 AND mode = $2`,
    [t.uid, mode],
  );
  if (!row) return null;
  return {
    mode,
    usernameCipher: row.username_cipher,
    passwordCipher: row.password_cipher,
    keyVersion: row.key_version,
    updatedAt: row.updated_at,
  };
}

export async function setBtCreds(t: TenantRef, doc: BtCredsDoc): Promise<void> {
  await q(
    `INSERT INTO bt_creds (uid, mode, username_cipher, password_cipher, key_version, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (uid, mode) DO UPDATE
       SET username_cipher = EXCLUDED.username_cipher,
           password_cipher = EXCLUDED.password_cipher,
           key_version     = EXCLUDED.key_version,
           updated_at      = EXCLUDED.updated_at`,
    [t.uid, doc.mode, doc.usernameCipher, doc.passwordCipher, doc.keyVersion, now()],
  );
}

export async function deleteBtCreds(t: TenantRef, mode: BtMode): Promise<void> {
  await q(`DELETE FROM bt_creds WHERE uid = $1 AND mode = $2`, [t.uid, mode]);
}

export async function getBtSession(t: TenantRef, mode: BtMode): Promise<BtSessionDoc | null> {
  const row = await q1<{ snapshot: unknown; updated_at: string }>(
    `SELECT snapshot, updated_at FROM bt_sessions WHERE uid = $1 AND mode = $2`,
    [t.uid, mode],
  );
  if (!row) return null;
  return { mode, snapshot: row.snapshot, updatedAt: row.updated_at };
}

export async function setBtSession(
  t: TenantRef,
  mode: BtMode,
  snapshot: unknown,
): Promise<void> {
  await q(
    `INSERT INTO bt_sessions (uid, mode, snapshot, updated_at)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (uid, mode) DO UPDATE
       SET snapshot = EXCLUDED.snapshot, updated_at = EXCLUDED.updated_at`,
    [t.uid, mode, JSON.stringify(snapshot ?? null), now()],
  );
}

export async function deleteBtSession(t: TenantRef, mode: BtMode): Promise<void> {
  await q(`DELETE FROM bt_sessions WHERE uid = $1 AND mode = $2`, [t.uid, mode]);
}

/**
 * For the `/internal/cron/refresh` job: iterate active tenants. "Active" =
 * has any BT session stored. Returns the uids.
 */
export async function listActiveTenantUids(): Promise<string[]> {
  const rows = await q<{ uid: string }>(`SELECT DISTINCT uid FROM bt_sessions`);
  return rows.map((r) => r.uid);
}

// ---- API keys --------------------------------------------------------------

interface ApiKeyRow {
  id: string;
  uid: string;
  prefix: string;
  hash: string;
  mode: BtMode;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  filters: ApiKeyFilters | null;
  access: 'read' | 'rw' | null;
  mcp_client_id: string | null;
  mcp_created_at: string | null;
}

function toApiKeyDoc(row: ApiKeyRow): ApiKeyDoc & { id: string } {
  return {
    id: row.id,
    prefix: row.prefix,
    hash: row.hash,
    mode: row.mode,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    filters: row.filters ?? undefined,
    access: row.access ?? undefined,
    mcpClientId: row.mcp_client_id ?? undefined,
    mcpCreatedAt: row.mcp_created_at ?? undefined,
  };
}

const API_KEY_COLS = `id, uid, prefix, hash, mode, label, created_at, last_used_at,
                      revoked_at, filters, access, mcp_client_id, mcp_created_at`;

export async function createApiKey(t: TenantRef, doc: ApiKeyDoc): Promise<string> {
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
      doc.mcpCreatedAt ?? null,
    ],
  );
  return id;
}

/**
 * Resolve a bearer token to its owning key row by hash. This is the single
 * indexed point-read the authentication path depends on — it replaces both
 * the old `key_hashes` index doc and the collectionGroup scan behind it,
 * because a UNIQUE index on `hash` is the same lookup done properly.
 *
 * Returns the row regardless of revocation state; the caller decides.
 */
export async function findApiKeyByHash(
  hash: string,
): Promise<(ApiKeyDoc & { id: string; uid: string }) | null> {
  const row = await q1<ApiKeyRow>(
    `SELECT ${API_KEY_COLS} FROM api_keys WHERE hash = $1`,
    [hash],
  );
  return row ? { ...toApiKeyDoc(row), uid: row.uid } : null;
}

/** Fetch a single API key by (tenant, id). */
export async function getApiKey(
  t: TenantRef,
  id: string,
): Promise<(ApiKeyDoc & { id: string }) | null> {
  const row = await q1<ApiKeyRow>(
    `SELECT ${API_KEY_COLS} FROM api_keys WHERE uid = $1 AND id = $2`,
    [t.uid, id],
  );
  return row ? toApiKeyDoc(row) : null;
}

export async function listApiKeys(t: TenantRef): Promise<Array<ApiKeyDoc & { id: string }>> {
  const rows = await q<ApiKeyRow>(
    `SELECT ${API_KEY_COLS} FROM api_keys WHERE uid = $1 ORDER BY created_at DESC`,
    [t.uid],
  );
  return rows.map(toApiKeyDoc);
}

export async function revokeApiKey(t: TenantRef, id: string): Promise<void> {
  await q(`UPDATE api_keys SET revoked_at = $3 WHERE uid = $1 AND id = $2`, [
    t.uid,
    id,
    now(),
  ]);
}

export async function updateApiKeyFilters(
  t: TenantRef,
  id: string,
  filters: ApiKeyFilters,
): Promise<void> {
  await q(`UPDATE api_keys SET filters = $3::jsonb WHERE uid = $1 AND id = $2`, [
    t.uid,
    id,
    JSON.stringify(filters),
  ]);
}

export async function touchApiKey(t: TenantRef, id: string): Promise<void> {
  // Updating lastUsedAt on every call is a write-per-request cost; worth it
  // for the "last used" column in the UI. If it ever becomes a cost problem
  // we can debounce to every N minutes in memory.
  await q(`UPDATE api_keys SET last_used_at = $3 WHERE uid = $1 AND id = $2`, [
    t.uid,
    id,
    now(),
  ]);
}

/**
 * Find any active (non-revoked) MCP-sourced API key for this tenant + mode.
 * Used by the token endpoint to revoke a prior connection before issuing a
 * new one ("one MCP connection at a time" rule, per mode).
 */
export async function findActiveMcpKey(
  t: TenantRef,
  mode: BtMode,
): Promise<(ApiKeyDoc & { id: string }) | null> {
  const row = await q1<ApiKeyRow>(
    `SELECT ${API_KEY_COLS} FROM api_keys
      WHERE uid = $1 AND mode = $2 AND mcp_client_id IS NOT NULL AND revoked_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [t.uid, mode],
  );
  return row ? toApiKeyDoc(row) : null;
}

// ---- events ----------------------------------------------------------------

export async function appendEvent(t: TenantRef, ev: EventDoc): Promise<void> {
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
      ev.ts,
    ],
  );
}

export async function listEvents(
  t: TenantRef,
  opts: { limit?: number; since?: string; types?: EventDoc['type'][] } = {},
): Promise<EventDoc[]> {
  const params: unknown[] = [t.uid];
  let where = 'uid = $1';
  if (opts.since) {
    params.push(opts.since);
    where += ` AND ts >= $${params.length}`;
  }
  params.push(opts.limit ?? 200);
  const rows = await q<{
    type: EventDoc['type'];
    actor: string;
    mode: BtMode | null;
    status: 'ok' | 'err';
    detail: Record<string, unknown> | null;
    error: { code?: string; message?: string } | null;
    ts: string;
  }>(
    `SELECT type, actor, mode, status, detail, error, ts
       FROM events WHERE ${where} ORDER BY ts DESC LIMIT $${params.length}`,
    params,
  );
  const mapped: EventDoc[] = rows.map((r) => ({
    type: r.type,
    actor: r.actor,
    mode: r.mode ?? undefined,
    status: r.status,
    detail: r.detail ?? undefined,
    error: r.error ?? undefined,
    ts: r.ts,
  }));
  // Type filtering stays in memory, exactly as before: the limit applies to
  // the time window first, so narrowing by type in SQL would change which
  // events a bounded feed returns.
  if (opts.types?.length) return mapped.filter((r) => opts.types!.includes(r.type));
  return mapped;
}

// ---- Telegram --------------------------------------------------------------

export async function getTelegramLink(t: TenantRef): Promise<TelegramLinkDoc | null> {
  const row = await q1<{ chat_id: string; linked_at: string; username: string | null }>(
    `SELECT chat_id, linked_at, username FROM telegram_links WHERE uid = $1`,
    [t.uid],
  );
  if (!row) return null;
  // bigint comes back from pg as a string; chat IDs are well inside the safe
  // integer range, so the Number() is lossless here.
  return {
    chatId: Number(row.chat_id),
    linkedAt: row.linked_at,
    username: row.username ?? undefined,
  };
}

export async function setTelegramLink(t: TenantRef, link: TelegramLinkDoc): Promise<void> {
  await q(
    `INSERT INTO telegram_links (uid, chat_id, linked_at, username)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (uid) DO UPDATE
       SET chat_id = EXCLUDED.chat_id,
           linked_at = EXCLUDED.linked_at,
           username = EXCLUDED.username`,
    [t.uid, link.chatId, link.linkedAt, link.username ?? null],
  );
}

export async function clearTelegramLink(t: TenantRef): Promise<void> {
  await q(`DELETE FROM telegram_links WHERE uid = $1`, [t.uid]);
}

export async function setPendingTelegramLink(t: TenantRef, code: string): Promise<void> {
  await q(
    `INSERT INTO telegram_pending (uid, code, created_at)
     VALUES ($1,$2,$3)
     ON CONFLICT (uid) DO UPDATE
       SET code = EXCLUDED.code, created_at = EXCLUDED.created_at`,
    [t.uid, code, now()],
  );
}

export async function clearPendingTelegramLink(t: TenantRef): Promise<void> {
  await q(`DELETE FROM telegram_pending WHERE uid = $1`, [t.uid]);
}

/**
 * Fetch the pending link row for a specific uid. Used by the webhook once
 * the uid has been resolved from the bot's webhookSecret.
 */
export async function getPendingTelegramLinkForUid(
  t: TenantRef,
): Promise<PendingTelegramLinkDoc | null> {
  const row = await q1<{ code: string; created_at: string }>(
    `SELECT code, created_at FROM telegram_pending WHERE uid = $1`,
    [t.uid],
  );
  if (!row) return null;
  return {
    _type: 'telegram_pending',
    code: row.code,
    uid: t.uid,
    createdAt: row.created_at,
  };
}

/**
 * Look up a pending link by code. Returns null if not found or if the row is
 * older than PENDING_TELEGRAM_LINK_TTL_MS (we treat stale codes as absent).
 */
export async function findPendingTelegramLink(
  code: string,
): Promise<PendingTelegramLinkDoc | null> {
  const row = await q1<{ uid: string; code: string; created_at: string }>(
    `SELECT uid, code, created_at FROM telegram_pending WHERE code = $1 LIMIT 1`,
    [code],
  );
  if (!row) return null;
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  if (ageMs > PENDING_TELEGRAM_LINK_TTL_MS) return null;
  return {
    _type: 'telegram_pending',
    code: row.code,
    uid: row.uid,
    createdAt: row.created_at,
  };
}

interface TelegramBotRow {
  uid: string;
  username: string;
  token_cipher: string;
  key_version: string;
  webhook_secret: string;
  created_at: string;
  updated_at: string;
}

function toBotDoc(row: TelegramBotRow): TelegramBotDoc {
  return {
    _type: 'telegram_bot',
    username: row.username,
    tokenCipher: row.token_cipher,
    keyVersion: row.key_version,
    webhookSecret: row.webhook_secret,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getTelegramBot(t: TenantRef): Promise<TelegramBotDoc | null> {
  const row = await q1<TelegramBotRow>(
    `SELECT uid, username, token_cipher, key_version, webhook_secret, created_at, updated_at
       FROM telegram_bots WHERE uid = $1`,
    [t.uid],
  );
  return row ? toBotDoc(row) : null;
}

export async function setTelegramBot(t: TenantRef, doc: TelegramBotDoc): Promise<void> {
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
      doc.updatedAt,
    ],
  );
}

export async function deleteTelegramBot(t: TenantRef): Promise<void> {
  await q(`DELETE FROM telegram_bots WHERE uid = $1`, [t.uid]);
}

/**
 * Resolve an inbound webhook: given the path secret, find the bot row + its
 * owning uid. Returns null if no bot has that secret (e.g. the user rotated
 * the webhook and Telegram hasn't been updated yet).
 */
export async function findTelegramBotByWebhookSecret(
  webhookSecret: string,
): Promise<(TelegramBotDoc & { uid: string }) | null> {
  const row = await q1<TelegramBotRow>(
    `SELECT uid, username, token_cipher, key_version, webhook_secret, created_at, updated_at
       FROM telegram_bots WHERE webhook_secret = $1`,
    [webhookSecret],
  );
  return row ? { ...toBotDoc(row), uid: row.uid } : null;
}

// ---- trading state: read/write helpers ------------------------------------
//
// All of these are tenant + mode scoped. The auto-trading project used to hit
// Firestore directly; now it goes through the bt-gateway API key and these
// helpers enforce isolation the same way BT creds / sessions do.

/** Portfolio state singleton. */
export async function getPortfolioState(
  t: TenantRef,
  mode: BtMode,
): Promise<Record<string, unknown> | null> {
  const row = await q1<{ state: Record<string, unknown> }>(
    `SELECT state FROM portfolio_state WHERE uid = $1 AND mode = $2`,
    [t.uid, mode],
  );
  return row?.state ?? null;
}

export async function setPortfolioState(
  t: TenantRef,
  mode: BtMode,
  state: Record<string, unknown>,
): Promise<void> {
  await q(
    `INSERT INTO portfolio_state (uid, mode, state, updated_at)
     VALUES ($1,$2,$3::jsonb,$4)
     ON CONFLICT (uid, mode) DO UPDATE
       SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
    [t.uid, mode, JSON.stringify(state), now()],
  );
}

/**
 * Append a record to a tenant+mode-scoped append-only stream. If `record` has
 * a non-empty string at `idField`, it is used as the row id so a repeated
 * send overwrites rather than duplicates; otherwise a fresh id is minted.
 * Returns the resulting id.
 */
async function appendTo(
  table: 'journal' | 'fills' | 'considered',
  t: TenantRef,
  mode: BtMode,
  record: Record<string, unknown>,
  idField: string,
): Promise<string> {
  const explicit = record[idField];
  const id = typeof explicit === 'string' && explicit.length > 0 ? explicit : autoId();
  await q(
    `INSERT INTO ${table} (uid, mode, id, record)
     VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (uid, mode, id) DO UPDATE SET record = EXCLUDED.record`,
    [t.uid, mode, id, JSON.stringify(record)],
  );
  return id;
}

/**
 * Shared listing for the three record streams. `sortCol` is a generated
 * column extracted from the JSON, and rows missing it are excluded — matching
 * Firestore, where a document without the orderBy field drops out of the
 * query entirely.
 */
async function listStream(
  table: 'journal' | 'fills' | 'considered',
  sortCol: 'ts' | 'filled_at' | 'logged_at',
  t: TenantRef,
  mode: BtMode,
  opts: { since?: string; limit?: number; type?: string },
  maxLimit: number,
): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [t.uid, mode];
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
  const rows = await q<{ record: Record<string, unknown> }>(
    `SELECT record FROM ${table} WHERE ${where}
      ORDER BY ${sortCol} DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => r.record);
}

export async function appendJournalEntry(
  t: TenantRef,
  mode: BtMode,
  record: Record<string, unknown>,
): Promise<string> {
  return appendTo('journal', t, mode, record, 'journal_id');
}

export async function listJournalEntries(
  t: TenantRef,
  mode: BtMode,
  opts: { since?: string; limit?: number; type?: string } = {},
): Promise<Record<string, unknown>[]> {
  return listStream('journal', 'ts', t, mode, opts, 5000);
}

export async function appendFillRecord(
  t: TenantRef,
  mode: BtMode,
  record: Record<string, unknown>,
): Promise<string> {
  return appendTo('fills', t, mode, record, 'fill_id');
}

export async function listFillRecords(
  t: TenantRef,
  mode: BtMode,
  opts: { since?: string; limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  return listStream('fills', 'filled_at', t, mode, opts, 5000);
}

export async function appendConsideredRecord(
  t: TenantRef,
  mode: BtMode,
  record: Record<string, unknown>,
): Promise<string> {
  const enriched = { ...record, logged_at: record.logged_at ?? now() };
  return appendTo('considered', t, mode, enriched, 'considered_id');
}

export async function listConsideredRecords(
  t: TenantRef,
  mode: BtMode,
  opts: { since?: string; limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  return listStream('considered', 'logged_at', t, mode, opts, 5000);
}

/** Daily market snapshot archive. `date` is the row key (e.g. "2026-04-21"). */
export async function saveMarketSnapshot(
  t: TenantRef,
  mode: BtMode,
  date: string,
  snapshot: unknown,
): Promise<void> {
  await q(
    `INSERT INTO snapshots (uid, mode, date, snapshot, saved_at)
     VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT (uid, mode, date) DO UPDATE
       SET snapshot = EXCLUDED.snapshot, saved_at = EXCLUDED.saved_at`,
    [t.uid, mode, date, JSON.stringify(snapshot ?? null), now()],
  );
}

export async function getMarketSnapshot(
  t: TenantRef,
  mode: BtMode,
  date: string,
): Promise<Record<string, unknown> | null> {
  const row = await q1<{ date: string; snapshot: unknown; saved_at: string }>(
    `SELECT date, snapshot, saved_at FROM snapshots
      WHERE uid = $1 AND mode = $2 AND date = $3`,
    [t.uid, mode, date],
  );
  if (!row) return null;
  return { date: row.date, snapshot: row.snapshot, saved_at: row.saved_at };
}

export async function listMarketSnapshots(
  t: TenantRef,
  mode: BtMode,
  opts: { from?: string; to?: string; limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [t.uid, mode];
  let where = 'uid = $1 AND mode = $2';
  if (opts.from) {
    params.push(opts.from);
    where += ` AND date >= $${params.length}`;
  }
  if (opts.to) {
    params.push(opts.to);
    where += ` AND date <= $${params.length}`;
  }
  params.push(Math.min(opts.limit ?? 90, 365));
  const rows = await q<{ date: string; snapshot: unknown; saved_at: string }>(
    `SELECT date, snapshot, saved_at FROM snapshots WHERE ${where}
      ORDER BY date DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({ date: r.date, snapshot: r.snapshot, saved_at: r.saved_at }));
}

// ---- OAuth (MCP) helpers ---------------------------------------------------
//
// These are global, not tenant-scoped, because client registration happens
// before any user is authenticated. Tenant linkage lives on each authorization
// code (OauthCodeDoc.uid) and on the resulting ApiKeyDoc.

export async function createOauthClient(doc: OauthClientDoc): Promise<void> {
  await q(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at)
     VALUES ($1,$2,$3::jsonb,$4)
     ON CONFLICT (client_id) DO UPDATE
       SET client_name   = EXCLUDED.client_name,
           redirect_uris = EXCLUDED.redirect_uris`,
    [doc.clientId, doc.clientName, JSON.stringify(doc.redirectUris), doc.createdAt],
  );
}

export async function getOauthClient(clientId: string): Promise<OauthClientDoc | null> {
  const row = await q1<{
    client_id: string;
    client_name: string;
    redirect_uris: string[];
    created_at: string;
  }>(
    `SELECT client_id, client_name, redirect_uris, created_at
       FROM oauth_clients WHERE client_id = $1`,
    [clientId],
  );
  if (!row) return null;
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: row.redirect_uris,
    createdAt: row.created_at,
  };
}

export async function createOauthCode(doc: OauthCodeDoc): Promise<void> {
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
      doc.redeemedAt ?? null,
    ],
  );
}

/**
 * One-shot redemption. A single conditional UPDATE marks the code redeemed
 * and returns it; a concurrent second attempt matches no row and gets null,
 * which is the same guarantee the Firestore transaction gave.
 */
export async function consumeOauthCode(codeHash: string): Promise<OauthCodeDoc | null> {
  const row = await q1<{
    code_hash: string;
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: 'S256';
    uid: string;
    mode: BtMode;
    access: 'read' | 'rw';
    filters: ApiKeyFilters | null;
    source_key_label: string | null;
    created_at: string;
    expires_at: string;
    redeemed_at: string;
  }>(
    `UPDATE oauth_codes
        SET redeemed_at = $2
      WHERE code_hash = $1
        AND redeemed_at IS NULL
        AND expires_at > $2
      RETURNING code_hash, client_id, redirect_uri, code_challenge,
                code_challenge_method, uid, mode, access, filters,
                source_key_label, created_at, expires_at, redeemed_at`,
    [codeHash, now()],
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
    filters: row.filters ?? undefined,
    sourceKeyLabel: row.source_key_label ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at,
  };
}
