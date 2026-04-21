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
}

/** Audit log entry — only mutating events land here. Reads do not. */
export interface EventDoc {
  type:
    | 'signin.success'
    | 'signin.failure'
    | 'refresh.success'
    | 'refresh.failure'
    | 'logout'
    | 'order.placed'
    | 'order.cancelled'
    | 'order.rejected'
    | 'creds.updated'
    | 'apikey.created'
    | 'apikey.revoked'
    | 'telegram.linked'
    | 'telegram.unlinked';
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
