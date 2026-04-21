/**
 * Envelope encryption for BT Trade credentials using Cloud KMS.
 *
 * Why envelope and not direct KMS encrypt?
 * - Cloud KMS has a 64 KiB per-call payload cap. Usernames/passwords are tiny,
 *   so we could fit — but envelope is the standard pattern, has a ~5x lower
 *   per-request cost at steady state (no KMS call on decrypt if we cache the
 *   DEK), and makes it easy to migrate to per-tenant KEKs later without
 *   changing stored doc shape.
 *
 * In M2 we go simple: one shared KEK wraps each plaintext value; the DEK is
 * ephemeral (generated per-encrypt, thrown away). That means we pay a KMS
 * decrypt on every creds read, which is fine at our volume (few requests/min
 * across all tenants). If it ever becomes a cost bottleneck, cache the
 * decrypted DEK per process with a short TTL.
 *
 * Stored ciphertext format (base64-decoded):
 *   [ 2 bytes: wrappedDekLen BE ] [ wrappedDek ] [ 12 bytes: iv ] [ aes-gcm ciphertext + 16-byte tag ]
 */

import 'server-only';
import crypto from 'node:crypto';
import { KeyManagementServiceClient } from '@google-cloud/kms';

const KMS_PROJECT = () =>
  process.env.KMS_PROJECT ??
  process.env.GOOGLE_CLOUD_PROJECT ??
  'auto-trader-493814';
const KMS_LOCATION = () => process.env.KMS_LOCATION ?? 'europe-west3';
const KMS_KEYRING = () => process.env.KMS_KEYRING ?? 'bt-gateway';
const KMS_KEY = () => process.env.KMS_KEY ?? 'tenant-creds';

let kmsClient: KeyManagementServiceClient | null = null;
function client(): KeyManagementServiceClient {
  if (!kmsClient) kmsClient = new KeyManagementServiceClient();
  return kmsClient;
}

function keyName(): string {
  return client().cryptoKeyPath(
    KMS_PROJECT(),
    KMS_LOCATION(),
    KMS_KEYRING(),
    KMS_KEY(),
  );
}

/** Encrypt a short plaintext (< ~60 KiB) and return base64 ciphertext. */
export async function encrypt(plaintext: string): Promise<{ ciphertext: string; keyVersion: string }> {
  // Generate a random 32-byte DEK (AES-256).
  const dek = crypto.randomBytes(32);

  // Wrap the DEK with the KEK via KMS.
  const [wrapResp] = await client().encrypt({
    name: keyName(),
    plaintext: dek,
  });
  const wrappedDek = wrapResp.ciphertext as Buffer | null;
  if (!wrappedDek) throw new Error('KMS encrypt returned empty ciphertext');
  const keyVersion = wrapResp.name ?? `${keyName()}/cryptoKeyVersions/current`;

  // AES-GCM encrypt the plaintext under the raw DEK.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const body = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Compose output: [len(2)][wrappedDek][iv(12)][body+tag]
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(wrappedDek.length, 0);
  const blob = Buffer.concat([lenBuf, wrappedDek, iv, body, tag]);

  // Zero the DEK — not strictly necessary in Node given GC, but cheap good hygiene.
  dek.fill(0);

  return { ciphertext: blob.toString('base64'), keyVersion };
}

/** Decrypt base64 ciphertext previously produced by `encrypt()`. */
export async function decrypt(ciphertextB64: string): Promise<string> {
  const blob = Buffer.from(ciphertextB64, 'base64');
  if (blob.length < 2) throw new Error('ciphertext too short');

  const wrappedLen = blob.readUInt16BE(0);
  const wrappedDek = blob.subarray(2, 2 + wrappedLen);
  const iv = blob.subarray(2 + wrappedLen, 2 + wrappedLen + 12);
  const bodyAndTag = blob.subarray(2 + wrappedLen + 12);
  if (bodyAndTag.length < 16) throw new Error('ciphertext too short for tag');
  const tag = bodyAndTag.subarray(bodyAndTag.length - 16);
  const body = bodyAndTag.subarray(0, bodyAndTag.length - 16);

  // Unwrap the DEK via KMS.
  const [unwrap] = await client().decrypt({
    name: keyName(),
    ciphertext: wrappedDek,
  });
  const dek = unwrap.plaintext as Buffer | null;
  if (!dek) throw new Error('KMS decrypt returned empty plaintext');

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]);
    return plain.toString('utf8');
  } finally {
    dek.fill(0);
  }
}
