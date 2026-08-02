/**
 * Envelope encryption for BT Trade credentials and Telegram bot tokens.
 *
 * This replaces the Cloud KMS implementation. The structure is the same —
 * a random per-value DEK encrypts the plaintext, and the DEK is wrapped by a
 * long-lived KEK — but the KEK is now a 32-byte master key supplied in the
 * environment instead of a key held by Cloud KMS.
 *
 * What that trade actually costs: the master key sits in the app's
 * environment, so anyone who can read the container's env can decrypt every
 * stored credential. Under KMS the key never left Google and each decrypt was
 * an audited API call. On a single self-hosted box that audit trail has no
 * separate blast radius to protect anyway — an attacker with the container
 * has the database too — so the envelope is kept for rotation, not for
 * separation of duties. Treat MASTER_KEY as the crown jewel it is: never log
 * it, never commit it, and rotate it if the box is ever compromised.
 *
 * ## Wire format (base64-decoded)
 *
 *   [ 1 byte version = 1 ]
 *   [ 12 bytes  ivDek     ]
 *   [ 48 bytes  wrappedDek: AES-256-GCM(dek) + 16-byte tag ]
 *   [ 12 bytes  ivBody    ]
 *   [ n bytes   body + 16-byte tag ]
 *
 * The leading version byte is what lets a future format change coexist with
 * stored rows. The KMS format had no version byte, which is part of why the
 * migration re-encrypts rather than trying to read both.
 *
 * ## Rotation
 *
 * `MASTER_KEY` encrypts. `MASTER_KEY_PREVIOUS` (comma-separated) is
 * decrypt-only, so a rotation is: put the old key in MASTER_KEY_PREVIOUS,
 * put a new one in MASTER_KEY, redeploy, then re-save each credential to
 * pull it forward. AES-GCM authenticates, so trying keys in turn is safe —
 * a wrong key fails the tag check rather than returning garbage.
 */

import crypto from 'node:crypto';

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const DEK_LEN = 32;
const WRAPPED_DEK_LEN = DEK_LEN + TAG_LEN;

interface MasterKey {
  key: Buffer;
  /** Stable, non-secret identifier stored alongside ciphertext for rotation auditing. */
  id: string;
}

function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('empty master key');
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `master key must be 32 bytes base64-encoded (got ${key.length}); ` +
        'generate one with: openssl rand -base64 32',
    );
  }
  return key;
}

/**
 * Short fingerprint of a key — a truncated SHA-256, so it identifies which
 * master key encrypted a row without being useful to an attacker.
 */
function fingerprint(key: Buffer): string {
  return 'local:' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}

let cached: { primary: MasterKey; previous: MasterKey[] } | null = null;

function keys(): { primary: MasterKey; previous: MasterKey[] } {
  if (cached) return cached;
  const raw = process.env.MASTER_KEY;
  if (!raw) {
    throw new Error(
      'MASTER_KEY is not set — cannot encrypt or decrypt stored credentials. ' +
        'Generate one with `openssl rand -base64 32` and set it on the app.',
    );
  }
  const key = parseKey(raw);
  const primary: MasterKey = { key, id: fingerprint(key) };
  const previous = (process.env.MASTER_KEY_PREVIOUS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const k = parseKey(s);
      return { key: k, id: fingerprint(k) };
    });
  cached = { primary, previous };
  return cached;
}

function wrapDek(dek: Buffer, kek: Buffer): { ivDek: Buffer; wrapped: Buffer } {
  const ivDek = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, ivDek);
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final(), cipher.getAuthTag()]);
  return { ivDek, wrapped };
}

function unwrapDek(wrapped: Buffer, ivDek: Buffer, kek: Buffer): Buffer {
  const body = wrapped.subarray(0, wrapped.length - TAG_LEN);
  const tag = wrapped.subarray(wrapped.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, ivDek);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** Encrypt a short plaintext and return base64 ciphertext. */
export async function encrypt(
  plaintext: string,
): Promise<{ ciphertext: string; keyVersion: string }> {
  const { primary } = keys();
  const dek = crypto.randomBytes(DEK_LEN);
  try {
    const { ivDek, wrapped } = wrapDek(dek, primary.key);

    const ivBody = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, ivBody);
    const body = Buffer.concat([
      cipher.update(Buffer.from(plaintext, 'utf8')),
      cipher.final(),
      cipher.getAuthTag(),
    ]);

    const blob = Buffer.concat([
      Buffer.from([VERSION]),
      ivDek,
      wrapped,
      ivBody,
      body,
    ]);
    return { ciphertext: blob.toString('base64'), keyVersion: primary.id };
  } finally {
    dek.fill(0);
  }
}

/** Decrypt base64 ciphertext previously produced by `encrypt()`. */
export async function decrypt(ciphertextB64: string): Promise<string> {
  const blob = Buffer.from(ciphertextB64, 'base64');
  const minLen = 1 + IV_LEN + WRAPPED_DEK_LEN + IV_LEN + TAG_LEN;
  if (blob.length < minLen) throw new Error('ciphertext too short');

  const version = blob[0];
  if (version !== VERSION) {
    throw new Error(
      `unsupported ciphertext version ${version} — ` +
        'rows encrypted under Cloud KMS must be re-encrypted by the migration script',
    );
  }

  let off = 1;
  const ivDek = blob.subarray(off, (off += IV_LEN));
  const wrapped = blob.subarray(off, (off += WRAPPED_DEK_LEN));
  const ivBody = blob.subarray(off, (off += IV_LEN));
  const bodyAndTag = blob.subarray(off);
  const body = bodyAndTag.subarray(0, bodyAndTag.length - TAG_LEN);
  const tag = bodyAndTag.subarray(bodyAndTag.length - TAG_LEN);

  const { primary, previous } = keys();
  let lastErr: unknown = null;
  for (const candidate of [primary, ...previous]) {
    let dek: Buffer | null = null;
    try {
      dek = unwrapDek(wrapped, ivDek, candidate.key);
      const decipher = crypto.createDecipheriv('aes-256-gcm', dek, ivBody);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch (e) {
      // Wrong key — the GCM tag check failed. Try the next one.
      lastErr = e;
    } finally {
      dek?.fill(0);
    }
  }
  throw new Error(
    'could not decrypt with MASTER_KEY or any MASTER_KEY_PREVIOUS entry' +
      (lastErr instanceof Error ? `: ${lastErr.message}` : ''),
  );
}

/** Test seam — forces the next call to re-read the key env vars. */
export function _resetKeys(): void {
  cached = null;
}
