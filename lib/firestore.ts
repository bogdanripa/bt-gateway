/**
 * Firestore data model + typed accessors, scoped per tenant.
 *
 * All persistent state for bt-gateway lives under `users/{uid}/...`. Every
 * read and write MUST go through one of the helpers in this file so we can
 * guarantee there is no way to accidentally cross tenants: there is no
 * collection lookup that takes a uid as a string parameter — the helpers
 * take a `TenantRef` that you can only construct from an authenticated
 * caller's uid.
 *
 * Mode axis: a tenant can have BOTH a demo and a live BT session + keys. We
 * keep both sides separated by a `mode` field on every sub-document. API
 * keys encode the mode in their prefix (bvb_demo_..., bvb_live_...) so a key
 * can only interact with its matching mode — a compromised demo key cannot
 * touch live.
 */

import 'server-only';
import { Firestore, type CollectionReference, type DocumentReference } from '@google-cloud/firestore';

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
  usernameCipher: string;   // base64, KMS envelope-encrypted
  passwordCipher: string;   // base64, KMS envelope-encrypted
  keyVersion: string;       // KMS key version used — helps future rotation
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
 * Dynamic Client Registration record (RFC 7591). Stored at the root in
 * `oauth_clients/{clientId}` because clients are not tenant-scoped — any
 * tenant can authenticate against a given registered client. The client is
 * just a label + redirect_uri allowlist.
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
 * token endpoint. Stored at `oauth_codes/{codeHash}` (sha256 of the raw
 * code; the raw code is delivered to the user agent only).
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

/** Optional Telegram linkage. Stored under users/{uid}/integrations/telegram. */
export interface TelegramLinkDoc {
  chatId: number;
  linkedAt: string;
  /** Username at link time — for display only; users can rename. */
  username?: string;
}

/**
 * Pending Telegram link code. Stored under
 * `users/{uid}/integrations/telegram_pending`. The webhook looks it up by
 * code via a collectionGroup query so it doesn't need to know the uid in
 * advance — the user's `/start <code>` message resolves to the uid via the
 * pending doc, then this doc is deleted and the real `telegram` link is
 * written. Codes live for `PENDING_TELEGRAM_LINK_TTL_MS` after which the
 * webhook rejects them.
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
 * a handle the user owns. Stored at `users/{uid}/integrations/bot`.
 *
 * `webhookSecret` is a 24-byte random string used as the path segment in
 * the webhook URL (/api/v1/telegram/webhook/:secret). It doubles as the
 * lookup key — the webhook resolves sender → uid via a collectionGroup
 * query on (_type, webhookSecret).
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

// ---- client ---------------------------------------------------------------

let dbInstance: Firestore | null = null;

function db(): Firestore {
  if (!dbInstance) {
    dbInstance = new Firestore({
      // ADC resolves the project ID on Cloud Run; locally we fall back to the
      // same env we use for Firebase Admin.
      projectId:
        process.env.FIRESTORE_PROJECT ??
        process.env.FIREBASE_PROJECT_ID ??
        process.env.GOOGLE_CLOUD_PROJECT ??
        'auto-trader-493814',
      // Optional fields (e.g. displayName) may be undefined when the Firebase
      // user hasn't set them. Silently drop them instead of throwing.
      ignoreUndefinedProperties: true,
    });
  }
  return dbInstance;
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

// ---- doc/collection helpers ------------------------------------------------

function userDoc(t: TenantRef): DocumentReference {
  return db().collection('users').doc(t.uid);
}

function btCredsDoc(t: TenantRef, mode: BtMode): DocumentReference {
  return userDoc(t).collection('bt_creds').doc(mode);
}

function btSessionDoc(t: TenantRef, mode: BtMode): DocumentReference {
  return userDoc(t).collection('bt_session').doc(mode);
}

function apiKeysCol(t: TenantRef): CollectionReference {
  return userDoc(t).collection('api_keys');
}

function eventsCol(t: TenantRef): CollectionReference {
  return userDoc(t).collection('events');
}

function telegramLinkDoc(t: TenantRef): DocumentReference {
  return userDoc(t).collection('integrations').doc('telegram');
}

function telegramPendingDoc(t: TenantRef): DocumentReference {
  return userDoc(t).collection('integrations').doc('telegram_pending');
}

function telegramBotDoc(t: TenantRef): DocumentReference {
  return userDoc(t).collection('integrations').doc('bot');
}

// Trading state — tenant + mode scoped so demo/live never cross.
// Layout: users/{uid}/trading_state/{mode}/<subcollection>/<doc>
function tradingStateDoc(t: TenantRef, mode: BtMode): DocumentReference {
  return userDoc(t).collection('trading_state').doc(mode);
}

function portfolioStateDoc(t: TenantRef, mode: BtMode): DocumentReference {
  return tradingStateDoc(t, mode).collection('portfolio').doc('current');
}

function journalCol(t: TenantRef, mode: BtMode): CollectionReference {
  return tradingStateDoc(t, mode).collection('journal');
}

function fillsCol(t: TenantRef, mode: BtMode): CollectionReference {
  return tradingStateDoc(t, mode).collection('fills');
}

function consideredCol(t: TenantRef, mode: BtMode): CollectionReference {
  return tradingStateDoc(t, mode).collection('considered');
}

function snapshotsCol(t: TenantRef, mode: BtMode): CollectionReference {
  return tradingStateDoc(t, mode).collection('snapshots');
}

// ---- high-level read/write -------------------------------------------------

export async function getUser(t: TenantRef): Promise<UserDoc | null> {
  const snap = await userDoc(t).get();
  return snap.exists ? (snap.data() as UserDoc) : null;
}

export async function upsertUser(
  t: TenantRef,
  patch: Partial<UserDoc> & { email: string },
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await userDoc(t).get();
  if (!existing.exists) {
    const newDoc: UserDoc = {
      email: patch.email,
      displayName: patch.displayName,
      isAdmin: patch.isAdmin ?? false,
      createdAt: now,
      updatedAt: now,
    };
    await userDoc(t).set(newDoc);
    return;
  }
  await userDoc(t).set({ ...patch, updatedAt: now }, { merge: true });
}

export async function getBtCreds(t: TenantRef, mode: BtMode): Promise<BtCredsDoc | null> {
  const snap = await btCredsDoc(t, mode).get();
  return snap.exists ? (snap.data() as BtCredsDoc) : null;
}

export async function setBtCreds(t: TenantRef, doc: BtCredsDoc): Promise<void> {
  await btCredsDoc(t, doc.mode).set({ ...doc, updatedAt: new Date().toISOString() });
}

export async function getBtSession(t: TenantRef, mode: BtMode): Promise<BtSessionDoc | null> {
  const snap = await btSessionDoc(t, mode).get();
  return snap.exists ? (snap.data() as BtSessionDoc) : null;
}

export async function setBtSession(
  t: TenantRef,
  mode: BtMode,
  snapshot: unknown,
): Promise<void> {
  const doc: BtSessionDoc = { mode, snapshot, updatedAt: new Date().toISOString() };
  await btSessionDoc(t, mode).set(doc);
}

export async function deleteBtSession(t: TenantRef, mode: BtMode): Promise<void> {
  await btSessionDoc(t, mode).delete().catch(() => { /* already gone */ });
}

export async function createApiKey(t: TenantRef, doc: ApiKeyDoc): Promise<string> {
  const ref = apiKeysCol(t).doc();
  await ref.set(doc);
  return ref.id;
}

export async function listApiKeys(t: TenantRef): Promise<Array<ApiKeyDoc & { id: string }>> {
  const snap = await apiKeysCol(t).orderBy('createdAt', 'desc').get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as ApiKeyDoc) }));
}

export async function revokeApiKey(t: TenantRef, id: string): Promise<void> {
  await apiKeysCol(t).doc(id).set({ revokedAt: new Date().toISOString() }, { merge: true });
}

export async function updateApiKeyFilters(
  t: TenantRef,
  id: string,
  filters: ApiKeyFilters,
): Promise<void> {
  await apiKeysCol(t).doc(id).set({ filters }, { merge: true });
}

export async function touchApiKey(t: TenantRef, id: string): Promise<void> {
  // Updating lastUsedAt on every call is a write-per-request cost; worth it
  // for the "last used" column in the UI. If it ever becomes a cost problem
  // we can debounce to every N minutes in memory.
  await apiKeysCol(t).doc(id).set({ lastUsedAt: new Date().toISOString() }, { merge: true });
}

export async function appendEvent(t: TenantRef, ev: EventDoc): Promise<void> {
  await eventsCol(t).add(ev);
}

export async function listEvents(
  t: TenantRef,
  opts: { limit?: number; since?: string; types?: EventDoc['type'][] } = {},
): Promise<EventDoc[]> {
  let q = eventsCol(t).orderBy('ts', 'desc').limit(opts.limit ?? 200);
  if (opts.since) q = q.where('ts', '>=', opts.since);
  const snap = await q.get();
  const rows = snap.docs.map((d) => d.data() as EventDoc);
  if (opts.types?.length) return rows.filter((r) => opts.types!.includes(r.type));
  return rows;
}

export async function getTelegramLink(t: TenantRef): Promise<TelegramLinkDoc | null> {
  const snap = await telegramLinkDoc(t).get();
  return snap.exists ? (snap.data() as TelegramLinkDoc) : null;
}

export async function setTelegramLink(t: TenantRef, link: TelegramLinkDoc): Promise<void> {
  await telegramLinkDoc(t).set(link);
}

export async function clearTelegramLink(t: TenantRef): Promise<void> {
  await telegramLinkDoc(t).delete().catch(() => { /* already gone */ });
}

export async function setPendingTelegramLink(
  t: TenantRef,
  code: string,
): Promise<void> {
  const doc: PendingTelegramLinkDoc = {
    _type: 'telegram_pending',
    code,
    uid: t.uid,
    createdAt: new Date().toISOString(),
  };
  await telegramPendingDoc(t).set(doc);
}

export async function clearPendingTelegramLink(t: TenantRef): Promise<void> {
  await telegramPendingDoc(t).delete().catch(() => { /* already gone */ });
}

/**
 * Fetch the pending link doc for a specific uid. Used by the webhook once
 * the uid has been resolved from the bot's webhookSecret; avoids a
 * collectionGroup scan when we already know who we're dealing with.
 */
export async function getPendingTelegramLinkForUid(
  t: TenantRef,
): Promise<PendingTelegramLinkDoc | null> {
  const snap = await telegramPendingDoc(t).get();
  return snap.exists ? (snap.data() as PendingTelegramLinkDoc) : null;
}

/**
 * Look up a pending link by code via collectionGroup. Returns the full
 * doc + its owning uid. Returns null if not found or if the doc is older
 * than PENDING_TELEGRAM_LINK_TTL_MS (we treat stale codes as absent).
 */
export async function findPendingTelegramLink(
  code: string,
): Promise<PendingTelegramLinkDoc | null> {
  const snap = await db()
    .collectionGroup('integrations')
    .where('_type', '==', 'telegram_pending')
    .where('code', '==', code)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0].data() as PendingTelegramLinkDoc;
  const ageMs = Date.now() - new Date(doc.createdAt).getTime();
  if (ageMs > PENDING_TELEGRAM_LINK_TTL_MS) return null;
  return doc;
}

export async function getTelegramBot(t: TenantRef): Promise<TelegramBotDoc | null> {
  const snap = await telegramBotDoc(t).get();
  return snap.exists ? (snap.data() as TelegramBotDoc) : null;
}

export async function setTelegramBot(t: TenantRef, doc: TelegramBotDoc): Promise<void> {
  await telegramBotDoc(t).set(doc);
}

export async function deleteTelegramBot(t: TenantRef): Promise<void> {
  await telegramBotDoc(t).delete().catch(() => { /* already gone */ });
}

/**
 * Resolve an inbound webhook: given the path secret, find the bot doc + its
 * owning uid. Returns null if no bot has that secret (e.g. the user rotated
 * the webhook and Telegram hasn't been updated yet). Implementation is a
 * collectionGroup query scoped by `_type` so we never accidentally match
 * other integration docs (telegram_pending has its own _type).
 */
export async function findTelegramBotByWebhookSecret(
  webhookSecret: string,
): Promise<(TelegramBotDoc & { uid: string }) | null> {
  const snap = await db()
    .collectionGroup('integrations')
    .where('_type', '==', 'telegram_bot')
    .where('webhookSecret', '==', webhookSecret)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0].data() as TelegramBotDoc;
  // Path is users/{uid}/integrations/bot
  const parts = snap.docs[0].ref.path.split('/');
  const uid = parts[1];
  return { ...doc, uid };
}

/**
 * For the `/internal/cron/refresh` job: iterate active tenants. "Active" =
 * has any BT session stored. Returns the uids.
 */
export async function listActiveTenantUids(): Promise<string[]> {
  const snap = await db().collectionGroup('bt_session').get();
  const uids = new Set<string>();
  for (const d of snap.docs) {
    // Path is users/{uid}/bt_session/{mode}
    const parts = d.ref.path.split('/');
    if (parts.length >= 2) uids.add(parts[1]);
  }
  return [...uids];
}

// ---- trading state: read/write helpers ------------------------------------
//
// All of these are tenant + mode scoped. The auto-trading project used to hit
// Firestore directly; now it goes through the bt-gateway API key and these
// helpers enforce isolation the same way BT creds / sessions do.

/** Portfolio state singleton (mirrors the old portfolio_state/current doc). */
export async function getPortfolioState(
  t: TenantRef,
  mode: BtMode,
): Promise<Record<string, unknown> | null> {
  const snap = await portfolioStateDoc(t, mode).get();
  return snap.exists ? (snap.data() as Record<string, unknown>) : null;
}

export async function setPortfolioState(
  t: TenantRef,
  mode: BtMode,
  state: Record<string, unknown>,
): Promise<void> {
  await portfolioStateDoc(t, mode).set(state);
}

/**
 * Append a record to a tenant+mode-scoped append-only collection. If `record`
 * has a string `id` field, uses it as the doc id for dedup; otherwise auto-id.
 * Returns the resulting doc id.
 */
async function appendTo(
  col: CollectionReference,
  record: Record<string, unknown>,
  idField?: string,
): Promise<string> {
  const explicit = idField ? record[idField] : undefined;
  if (typeof explicit === 'string' && explicit.length > 0) {
    await col.doc(explicit).set(record);
    return explicit;
  }
  const ref = await col.add(record);
  return ref.id;
}

export async function appendJournalEntry(
  t: TenantRef,
  mode: BtMode,
  record: Record<string, unknown>,
): Promise<string> {
  return appendTo(journalCol(t, mode), record, 'journal_id');
}

export async function listJournalEntries(
  t: TenantRef,
  mode: BtMode,
  opts: { since?: string; limit?: number; type?: string } = {},
): Promise<Record<string, unknown>[]> {
  let q = journalCol(t, mode).orderBy('timestamp', 'desc');
  if (opts.since) q = q.where('timestamp', '>=', opts.since);
  if (opts.type) q = q.where('type', '==', opts.type);
  q = q.limit(Math.min(opts.limit ?? 500, 5000));
  const snap = await q.get();
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}

export async function appendFillRecord(
  t: TenantRef,
  mode: BtMode,
  record: Record<string, unknown>,
): Promise<string> {
  return appendTo(fillsCol(t, mode), record, 'fill_id');
}

export async function listFillRecords(
  t: TenantRef,
  mode: BtMode,
  opts: { since?: string; limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  let q = fillsCol(t, mode).orderBy('filled_at', 'desc');
  if (opts.since) q = q.where('filled_at', '>=', opts.since);
  q = q.limit(Math.min(opts.limit ?? 500, 5000));
  const snap = await q.get();
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}

export async function appendConsideredRecord(
  t: TenantRef,
  mode: BtMode,
  record: Record<string, unknown>,
): Promise<string> {
  const enriched = { ...record, logged_at: record.logged_at ?? new Date().toISOString() };
  return appendTo(consideredCol(t, mode), enriched, 'considered_id');
}

export async function listConsideredRecords(
  t: TenantRef,
  mode: BtMode,
  opts: { since?: string; limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  let q = consideredCol(t, mode).orderBy('logged_at', 'desc');
  if (opts.since) q = q.where('logged_at', '>=', opts.since);
  q = q.limit(Math.min(opts.limit ?? 500, 5000));
  const snap = await q.get();
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}

/** Daily market snapshot archive. `date` is the doc id (e.g. "2026-04-21"). */
export async function saveMarketSnapshot(
  t: TenantRef,
  mode: BtMode,
  date: string,
  snapshot: unknown,
): Promise<void> {
  await snapshotsCol(t, mode).doc(date).set({
    date,
    snapshot,
    saved_at: new Date().toISOString(),
  });
}

export async function getMarketSnapshot(
  t: TenantRef,
  mode: BtMode,
  date: string,
): Promise<Record<string, unknown> | null> {
  const snap = await snapshotsCol(t, mode).doc(date).get();
  return snap.exists ? (snap.data() as Record<string, unknown>) : null;
}

// ---- OAuth (MCP) helpers ---------------------------------------------------
//
// These are root collections, not tenant-scoped, because client registration
// happens before any user is authenticated. Tenant linkage lives on each
// authorization code (OauthCodeDoc.uid) and on the resulting ApiKeyDoc.

function oauthClientDocRef(clientId: string): DocumentReference {
  return db().collection('oauth_clients').doc(clientId);
}

function oauthCodeDocRef(codeHash: string): DocumentReference {
  return db().collection('oauth_codes').doc(codeHash);
}

export async function createOauthClient(doc: OauthClientDoc): Promise<void> {
  await oauthClientDocRef(doc.clientId).set(doc);
}

export async function getOauthClient(clientId: string): Promise<OauthClientDoc | null> {
  const snap = await oauthClientDocRef(clientId).get();
  return snap.exists ? (snap.data() as OauthClientDoc) : null;
}

export async function createOauthCode(doc: OauthCodeDoc): Promise<void> {
  await oauthCodeDocRef(doc.codeHash).set(doc);
}

export async function consumeOauthCode(codeHash: string): Promise<OauthCodeDoc | null> {
  // One-shot: a transaction reads the doc and, if unredeemed and unexpired,
  // marks it redeemed before returning. Concurrent redemption attempts get
  // null on the second call.
  return db().runTransaction(async (tx) => {
    const ref = oauthCodeDocRef(codeHash);
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data() as OauthCodeDoc;
    if (data.redeemedAt) return null;
    if (Date.now() > new Date(data.expiresAt).getTime()) return null;
    const now = new Date().toISOString();
    tx.update(ref, { redeemedAt: now });
    return { ...data, redeemedAt: now };
  });
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
  // In-memory filter avoids needing a composite index on (mode, mcpClientId);
  // key counts per tenant are small.
  const snap = await apiKeysCol(t).where('mode', '==', mode).get();
  for (const d of snap.docs) {
    const data = d.data() as ApiKeyDoc;
    if (!data.mcpClientId) continue;
    if (data.revokedAt) continue;
    return { id: d.id, ...data };
  }
  return null;
}

export async function listMarketSnapshots(
  t: TenantRef,
  mode: BtMode,
  opts: { from?: string; to?: string; limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  let q = snapshotsCol(t, mode).orderBy('date', 'desc');
  if (opts.from) q = q.where('date', '>=', opts.from);
  if (opts.to) q = q.where('date', '<=', opts.to);
  q = q.limit(Math.min(opts.limit ?? 90, 365));
  const snap = await q.get();
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}
