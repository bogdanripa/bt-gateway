#!/usr/bin/env node
/**
 * One-shot migration: Firestore + Cloud KMS  ->  Postgres + local envelope keys.
 *
 * Run this ONCE, from a machine authenticated to GCP, while the old Cloud Run
 * service is still up. It reads every tenant document out of Firestore,
 * KMS-decrypts the two kinds of secret we hold (BT credentials and Telegram
 * bot tokens), re-encrypts them under the new MASTER_KEY, and writes a set of
 * SQL files.
 *
 * ## Why it emits SQL instead of connecting to Postgres
 *
 * The app's database lives on the Pi's internal Docker network. There is no
 * exposed port and no tunnel — it is reachable from the app's own container
 * and from nowhere else. So this script cannot INSERT directly; it produces
 * SQL that gets applied through the platform's own db_run_script path.
 *
 * ## Usage
 *
 *   # 1. Credentials for the OLD project (Firestore read + KMS decrypt)
 *   gcloud auth application-default login
 *
 *   # 2. The NEW master key — the same value set as MASTER_KEY on the app.
 *   #    Everything encrypted here can ONLY be read back by that exact key.
 *   export MASTER_KEY='...'
 *
 *   # 3. The GCP SDKs are no longer runtime dependencies, so pull them in
 *   #    just for this run.
 *   npm i --no-save @google-cloud/firestore @google-cloud/kms
 *
 *   node scripts/migrate-to-postgres.mjs --out ./migration-sql
 *
 * Then apply each file in order via db_run_script against the bt-gateway app.
 *
 * Pass --dry-run to read and report counts without writing any files, which
 * is the safe way to confirm credentials and see the shape of what's there.
 *
 * ## Idempotency
 *
 * Every statement is an upsert (ON CONFLICT DO UPDATE), so re-applying a file
 * is safe. Re-RUNNING the script, however, mints fresh DEKs and IVs, so the
 * ciphertext changes each time even though the plaintext doesn't — that is
 * expected and harmless.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// ---- args -----------------------------------------------------------------

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const OUT_DIR = (() => {
  const i = argv.indexOf('--out');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : './migration-sql';
})();
const PROJECT_ID = process.env.FIRESTORE_PROJECT ?? process.env.FIREBASE_PROJECT_ID ?? 'auto-trader-493814';
const KMS_LOCATION = process.env.KMS_LOCATION ?? 'europe-west3';
const KMS_KEYRING = process.env.KMS_KEYRING ?? 'bt-gateway';
const KMS_KEY = process.env.KMS_KEY ?? 'tenant-creds';

// ---- new-world encryption (mirrors lib/secret-box.ts) ---------------------

const VERSION = 1;

function masterKey() {
  const raw = process.env.MASTER_KEY;
  if (!raw) {
    throw new Error(
      'MASTER_KEY is not set. It must be the exact value configured on the ' +
        'bt-gateway app, or nothing this script writes will be decryptable.',
    );
  }
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) {
    throw new Error(`MASTER_KEY must be 32 bytes base64-encoded (got ${key.length})`);
  }
  return key;
}

function keyFingerprint(key) {
  return 'local:' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/** Envelope-encrypt a plaintext under the local master key. */
function encryptLocal(plaintext, kek) {
  const dek = crypto.randomBytes(32);
  const ivDek = crypto.randomBytes(12);
  const wrapCipher = crypto.createCipheriv('aes-256-gcm', kek, ivDek);
  const wrapped = Buffer.concat([
    wrapCipher.update(dek),
    wrapCipher.final(),
    wrapCipher.getAuthTag(),
  ]);

  const ivBody = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, ivBody);
  const body = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  dek.fill(0);
  return Buffer.concat([Buffer.from([VERSION]), ivDek, wrapped, ivBody, body]).toString('base64');
}

// ---- old-world decryption (mirrors the deleted lib/kms.ts) ----------------

let kmsClient = null;
let kmsKeyName = null;

async function kmsDecrypt(ciphertextB64) {
  const blob = Buffer.from(ciphertextB64, 'base64');
  if (blob.length < 2) throw new Error('ciphertext too short');
  const wrappedLen = blob.readUInt16BE(0);
  const wrappedDek = blob.subarray(2, 2 + wrappedLen);
  const iv = blob.subarray(2 + wrappedLen, 2 + wrappedLen + 12);
  const bodyAndTag = blob.subarray(2 + wrappedLen + 12);
  const tag = bodyAndTag.subarray(bodyAndTag.length - 16);
  const body = bodyAndTag.subarray(0, bodyAndTag.length - 16);

  const [unwrap] = await kmsClient.decrypt({ name: kmsKeyName, ciphertext: wrappedDek });
  const dek = unwrap.plaintext;
  if (!dek) throw new Error('KMS decrypt returned empty plaintext');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

// ---- SQL emission ---------------------------------------------------------

/** Quote a value as a SQL literal. NULL for null/undefined. */
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`non-finite number: ${v}`);
    return String(v);
  }
  // standard_conforming_strings is on by default, so doubling the single
  // quote is the whole escape; backslashes stay literal.
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Quote a value as a jsonb literal. */
function jsonLit(v) {
  if (v === null || v === undefined) return 'NULL';
  return `${lit(JSON.stringify(v))}::jsonb`;
}

function upsert(table, cols, values, conflictCols, updateCols) {
  const colList = cols.join(', ');
  const valList = values.join(', ');
  const conflict = conflictCols.join(', ');
  if (!updateCols.length) {
    return `INSERT INTO ${table} (${colList}) VALUES (${valList}) ON CONFLICT (${conflict}) DO NOTHING;`;
  }
  const sets = updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  return `INSERT INTO ${table} (${colList}) VALUES (${valList}) ON CONFLICT (${conflict}) DO UPDATE SET ${sets};`;
}

// ---- main -----------------------------------------------------------------

const stats = {};
function count(k, n = 1) {
  stats[k] = (stats[k] ?? 0) + n;
}

async function main() {
  const kek = masterKey();
  console.log(`master key fingerprint: ${keyFingerprint(kek)}`);
  const keyVersion = keyFingerprint(kek);

  const { Firestore } = await import('@google-cloud/firestore');
  const { KeyManagementServiceClient } = await import('@google-cloud/kms');

  const db = new Firestore({ projectId: PROJECT_ID, ignoreUndefinedProperties: true });
  kmsClient = new KeyManagementServiceClient();
  kmsKeyName = kmsClient.cryptoKeyPath(PROJECT_ID, KMS_LOCATION, KMS_KEYRING, KMS_KEY);

  console.log(`reading Firestore project ${PROJECT_ID}...`);

  /** Statements grouped into files so no single db_run_script call is huge. */
  const files = new Map();
  const emit = (group, sql) => {
    if (!files.has(group)) files.set(group, []);
    files.get(group).push(sql);
  };

  // ---- tenants ------------------------------------------------------------
  const userSnaps = await db.collection('users').get();
  console.log(`found ${userSnaps.size} users`);

  for (const userDoc of userSnaps.docs) {
    const uid = userDoc.id;
    const u = userDoc.data();
    count('users');
    emit(
      '01-users',
      upsert(
        'users',
        ['uid', 'email', 'display_name', 'is_admin', 'created_at', 'updated_at'],
        [
          lit(uid),
          lit(u.email ?? ''),
          lit(u.displayName ?? null),
          lit(u.isAdmin === true),
          lit(u.createdAt ?? new Date().toISOString()),
          lit(u.updatedAt ?? u.createdAt ?? new Date().toISOString()),
        ],
        ['uid'],
        ['email', 'display_name', 'is_admin', 'updated_at'],
      ),
    );

    // ---- BT credentials: KMS decrypt -> local re-encrypt -------------------
    for (const credDoc of (await userDoc.ref.collection('bt_creds').get()).docs) {
      const mode = credDoc.id;
      const c = credDoc.data();
      const username = await kmsDecrypt(c.usernameCipher);
      const password = await kmsDecrypt(c.passwordCipher);
      count('bt_creds');
      emit(
        '02-secrets',
        upsert(
          'bt_creds',
          ['uid', 'mode', 'username_cipher', 'password_cipher', 'key_version', 'updated_at'],
          [
            lit(uid),
            lit(mode),
            lit(encryptLocal(username, kek)),
            lit(encryptLocal(password, kek)),
            lit(keyVersion),
            lit(c.updatedAt ?? new Date().toISOString()),
          ],
          ['uid', 'mode'],
          ['username_cipher', 'password_cipher', 'key_version', 'updated_at'],
        ),
      );
    }

    // ---- BT sessions ------------------------------------------------------
    // Carried over so the cutover does not force a fresh OTP login. These are
    // IP-pinned by BT, so they may well be rejected from the Pi's address —
    // that is fine, the pool falls back to a normal login.
    for (const sessDoc of (await userDoc.ref.collection('bt_session').get()).docs) {
      const mode = sessDoc.id;
      const s = sessDoc.data();
      count('bt_sessions');
      emit(
        '03-sessions',
        upsert(
          'bt_sessions',
          ['uid', 'mode', 'snapshot', 'updated_at'],
          [lit(uid), lit(mode), jsonLit(s.snapshot ?? null), lit(s.updatedAt ?? new Date().toISOString())],
          ['uid', 'mode'],
          ['snapshot', 'updated_at'],
        ),
      );
    }

    // ---- API keys ---------------------------------------------------------
    for (const keyDoc of (await userDoc.ref.collection('api_keys').get()).docs) {
      const k = keyDoc.data();
      count('api_keys');
      emit(
        '04-api-keys',
        upsert(
          'api_keys',
          [
            'id', 'uid', 'prefix', 'hash', 'mode', 'label', 'created_at',
            'last_used_at', 'revoked_at', 'filters', 'access',
            'mcp_client_id', 'mcp_created_at',
          ],
          [
            lit(keyDoc.id),
            lit(uid),
            lit(k.prefix ?? ''),
            lit(k.hash),
            lit(k.mode),
            lit(k.label ?? ''),
            lit(k.createdAt ?? new Date().toISOString()),
            lit(k.lastUsedAt ?? null),
            lit(k.revokedAt ?? null),
            jsonLit(k.filters ?? null),
            lit(k.access ?? null),
            lit(k.mcpClientId ?? null),
            lit(k.mcpCreatedAt ?? null),
          ],
          ['id'],
          ['prefix', 'hash', 'mode', 'label', 'last_used_at', 'revoked_at', 'filters', 'access'],
        ),
      );
    }

    // ---- audit events -----------------------------------------------------
    for (const evDoc of (await userDoc.ref.collection('events').get()).docs) {
      const e = evDoc.data();
      count('events');
      emit(
        '05-events',
        `INSERT INTO events (uid, type, actor, mode, status, detail, error, ts) VALUES (` +
          [
            lit(uid),
            lit(e.type),
            lit(e.actor ?? 'system'),
            lit(e.mode ?? null),
            lit(e.status ?? 'ok'),
            jsonLit(e.detail ?? null),
            jsonLit(e.error ?? null),
            lit(e.ts ?? new Date().toISOString()),
          ].join(', ') +
          `);`,
      );
    }

    // ---- integrations -----------------------------------------------------
    for (const intDoc of (await userDoc.ref.collection('integrations').get()).docs) {
      const d = intDoc.data();
      if (intDoc.id === 'telegram' && d.chatId !== undefined) {
        count('telegram_links');
        emit(
          '06-telegram',
          upsert(
            'telegram_links',
            ['uid', 'chat_id', 'linked_at', 'username'],
            [lit(uid), lit(Number(d.chatId)), lit(d.linkedAt ?? new Date().toISOString()), lit(d.username ?? null)],
            ['uid'],
            ['chat_id', 'linked_at', 'username'],
          ),
        );
      } else if (d._type === 'telegram_bot') {
        const token = await kmsDecrypt(d.tokenCipher);
        count('telegram_bots');
        emit(
          '06-telegram',
          upsert(
            'telegram_bots',
            ['uid', 'username', 'token_cipher', 'key_version', 'webhook_secret', 'created_at', 'updated_at'],
            [
              lit(uid),
              lit(d.username ?? ''),
              lit(encryptLocal(token, kek)),
              lit(keyVersion),
              lit(d.webhookSecret),
              lit(d.createdAt ?? new Date().toISOString()),
              lit(d.updatedAt ?? new Date().toISOString()),
            ],
            ['uid'],
            ['username', 'token_cipher', 'key_version', 'webhook_secret', 'updated_at'],
          ),
        );
      }
      // telegram_pending is deliberately skipped: those codes live 10 minutes
      // and any that exist at cutover are worthless by the time this lands.
    }

    // ---- trading state ----------------------------------------------------
    for (const mode of ['demo', 'live']) {
      const base = userDoc.ref.collection('trading_state').doc(mode);

      const portfolio = await base.collection('portfolio').doc('current').get();
      if (portfolio.exists) {
        count('portfolio_state');
        emit(
          '07-trading-state',
          upsert(
            'portfolio_state',
            ['uid', 'mode', 'state', 'updated_at'],
            [lit(uid), lit(mode), jsonLit(portfolio.data()), lit(new Date().toISOString())],
            ['uid', 'mode'],
            ['state', 'updated_at'],
          ),
        );
      }

      for (const [col, table] of [
        ['journal', 'journal'],
        ['fills', 'fills'],
        ['considered', 'considered'],
      ]) {
        for (const d of (await base.collection(col).get()).docs) {
          count(table);
          emit(
            `08-${table}`,
            upsert(
              table,
              ['uid', 'mode', 'id', 'record'],
              [lit(uid), lit(mode), lit(d.id), jsonLit(d.data())],
              ['uid', 'mode', 'id'],
              ['record'],
            ),
          );
        }
      }

      for (const d of (await base.collection('snapshots').get()).docs) {
        const s = d.data();
        count('snapshots');
        emit(
          '09-snapshots',
          upsert(
            'snapshots',
            ['uid', 'mode', 'date', 'snapshot', 'saved_at'],
            [
              lit(uid),
              lit(mode),
              lit(s.date ?? d.id),
              jsonLit(s.snapshot ?? null),
              lit(s.saved_at ?? new Date().toISOString()),
            ],
            ['uid', 'mode', 'date'],
            ['snapshot', 'saved_at'],
          ),
        );
      }
    }
  }

  // ---- OAuth clients (global) ---------------------------------------------
  for (const d of (await db.collection('oauth_clients').get()).docs) {
    const c = d.data();
    count('oauth_clients');
    emit(
      '10-oauth',
      upsert(
        'oauth_clients',
        ['client_id', 'client_name', 'redirect_uris', 'created_at'],
        [
          lit(c.clientId ?? d.id),
          lit(c.clientName ?? ''),
          jsonLit(c.redirectUris ?? []),
          lit(c.createdAt ?? new Date().toISOString()),
        ],
        ['client_id'],
        ['client_name', 'redirect_uris'],
      ),
    );
  }

  // Unredeemed authorization codes live 10 minutes; anything still valid at
  // cutover will have expired before this is applied, so they are skipped
  // exactly like telegram_pending.

  // ---- write --------------------------------------------------------------
  console.log('\ncounts:');
  for (const [k, v] of Object.entries(stats).sort()) console.log(`  ${k.padEnd(18)} ${v}`);

  if (DRY_RUN) {
    console.log('\n--dry-run: no files written.');
    return;
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const names = [...files.keys()].sort();
  console.log(`\nwriting ${names.length} file(s) to ${OUT_DIR}:`);
  for (const name of names) {
    const stmts = files.get(name);
    const file = path.join(OUT_DIR, `${name}.sql`);
    await fs.writeFile(file, stmts.join('\n') + '\n', 'utf8');
    console.log(`  ${name}.sql  (${stmts.length} statements)`);
  }
  console.log(
    '\nApply them in filename order against the bt-gateway app, e.g. via\n' +
      'db_run_script. Every statement is an upsert, so re-applying is safe.\n' +
      'These files contain re-encrypted credentials — delete them afterwards.',
  );
}

main().catch((e) => {
  console.error('\nmigration failed:', e.message);
  process.exit(1);
});
