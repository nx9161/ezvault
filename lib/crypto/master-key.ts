// SPDX-License-Identifier: MIT
/**
 * lib/crypto/master-key.ts — secret encryption at rest (Wave D, row 25).
 *
 * Pure module (no server-only): callers pass the raw MASTER_KEY value in,
 * so unit tests exercise the real round-trip with a throwaway key.
 *
 * Design: the app's existing MASTER_KEY machinery is the backup
 * crypto-shredding key (openssl enc -aes-256-cbc -pbkdf2 passphrase,
 * .github/workflows/backup-monthly.yml). For in-app secrets we derive a
 * 32-byte AES key from that same value with scrypt (per-secret random
 * salt is unnecessary — the key itself is high-entropy; a fixed
 * application salt separates this use from the backup KDF) and encrypt
 * with AES-256-GCM (authenticated: tampering fails decryption loudly).
 *
 * Stored format: `v1:<iv base64>:<authTag base64>:<ciphertext base64>`.
 *
 * Honest-config rule (binding): when MASTER_KEY is not configured there
 * is NO plaintext fallback — encryptSecret throws MasterKeyMissingError
 * and the Omeka settings route reports `not_configured`.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export class MasterKeyMissingError extends Error {
  constructor() {
    super('MASTER_KEY is not configured');
    this.name = 'MasterKeyMissingError';
  }
}

const SALT = 'ezvault-master-key-v1';
const FORMAT_PREFIX = 'v1:';

/** True when a usable MASTER_KEY value is present (non-empty string). */
export function hasMasterKey(raw: string | null | undefined): raw is string {
  return typeof raw === 'string' && raw.trim().length > 0;
}

/** Derive the 32-byte AES key from the raw MASTER_KEY value. */
export function deriveMasterKey(raw: string): Buffer {
  if (!hasMasterKey(raw)) throw new MasterKeyMissingError();
  // MASTER_KEY is generated as `openssl rand -hex 32` (64 hex chars); a
  // hex value is used byte-exact after decoding, anything else is hashed
  // through scrypt as a passphrase. Both paths yield 32 bytes.
  if (/^[0-9a-fA-F]{64}$/.test(raw.trim())) {
    return scryptSync(Buffer.from(raw.trim(), 'hex'), SALT, 32);
  }
  return scryptSync(raw, SALT, 32);
}

/** Encrypt a secret for at-rest storage. Throws when no key is configured. */
export function encryptSecret(plaintext: string, rawMasterKey: string | null | undefined): string {
  const key = deriveMasterKey(rawMasterKey ?? '');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${FORMAT_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/** Decrypt a stored secret. Throws on tampering / wrong key / bad format. */
export function decryptSecret(stored: string, rawMasterKey: string | null | undefined): string {
  const key = deriveMasterKey(rawMasterKey ?? '');
  if (!stored.startsWith(FORMAT_PREFIX)) throw new Error('unsupported ciphertext format');
  const parts = stored.slice(FORMAT_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('malformed ciphertext');
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Env accessor used by server code (kept thin; tests pass keys directly). */
export function masterKeyFromEnv(): string | null {
  const v = process.env.MASTER_KEY;
  return hasMasterKey(v) ? v : null;
}
