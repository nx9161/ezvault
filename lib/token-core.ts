// SPDX-License-Identifier: MIT
/**
 * lib/token-core.ts — developer API token primitives (Wave D, row 36).
 *
 * Pure module (no server-only, no DB): generation, hashing, and scope
 * logic are unit-tested directly; lib/token-auth.ts adds the DB lookup.
 *
 * Storage rule (binding): only the SHA-256 HASH of the secret is stored.
 * The plaintext token is shown ONCE at creation and never persisted.
 * Verification hashes the presented token and compares digests with the
 * same constant-time discipline as lib/auth.ts (SHA-256 both sides —
 * fixed 32-byte length, no early exit, no `===` on secrets).
 */

import { createHash, randomBytes } from 'node:crypto';

export const API_TOKEN_PREFIX = 'ezv_';
export const API_SCOPES = ['read', 'notes:write'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(v: unknown): v is ApiScope {
  return typeof v === 'string' && (API_SCOPES as readonly string[]).includes(v);
}

/** Validate a requested scope list; dedupes, rejects unknown scopes. */
export function normalizeScopes(input: unknown): ApiScope[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: ApiScope[] = [];
  for (const s of input) {
    if (!isApiScope(s)) return null;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

export function tokenHasScope(scopes: readonly string[], needed: ApiScope): boolean {
  return scopes.includes(needed);
}

/** SHA-256 hex of a token secret — the only form ever stored. */
export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Display prefix: safe to store/show (`ezv_` + first 8 secret chars). */
export function tokenDisplayPrefix(token: string): string {
  return token.slice(0, API_TOKEN_PREFIX.length + 8);
}

export interface GeneratedToken {
  /** Plaintext — shown ONCE at creation, never stored. */
  token: string;
  tokenHash: string;
  prefix: string;
}

/** Mint a new token: `ezv_` + 32 random bytes (base64url, 43 chars). */
export function generateApiToken(): GeneratedToken {
  const token = API_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, tokenHash: hashApiToken(token), prefix: tokenDisplayPrefix(token) };
}

/** True when a presented string is shaped like an EZVault API token. */
export function looksLikeApiToken(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.startsWith(API_TOKEN_PREFIX) && v.length >= API_TOKEN_PREFIX.length + 20;
}

function sha256Buf(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/**
 * Constant-time comparison of two SHA-256 digests (fixed 32-byte length,
 * no secret-dependent early exit) — mirrors lib/auth.ts's digestsEqual.
 */
export function digestsEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Verify a presented token against a stored hash, constant-time over the
 * digests of both hashes (hashing the hex strings keeps both sides at a
 * fixed length regardless of input).
 */
export function verifyApiToken(presented: string, storedHashHex: string): boolean {
  if (!looksLikeApiToken(presented)) return false;
  const presentedHash = hashApiToken(presented);
  return digestsEqual(sha256Buf(presentedHash), sha256Buf(storedHashHex));
}
