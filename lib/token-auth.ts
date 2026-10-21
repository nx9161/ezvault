// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/token-auth.ts — developer API token enforcement (Wave D, row 36).
 *
 * Model: human access is gated by Vercel Authentication in front of the
 * app (browser session). Scripted access adds an app-level bearer token:
 * routes in the documented subset call enforceTokenScope(). When NO
 * Authorization header is present the request is on the human path and
 * this helper is a no-op (the platform gate already authenticated it).
 * When a bearer IS presented it must be a valid EZVault token with the
 * required scope — an invalid/revoked/expired token is a 401 and an
 * under-scoped token a 403, even behind the platform gate: a token must
 * never widen access beyond its scope.
 */

import { sql } from './db/index';
import { extractBearer } from './auth';
import { HttpError } from './api/route-utils';
import {
  generateApiToken, hashApiToken, looksLikeApiToken, tokenHasScope,
  type ApiScope, type GeneratedToken,
} from './token-core';

export interface ApiTokenRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface AuthenticatedToken {
  id: string;
  name: string;
  scopes: string[];
}

/**
 * Enforce token scope on a documented-subset route. Returns the token
 * identity when a token authenticated, or null on the human path.
 * Throws HttpError 401/403 for presented-but-invalid tokens.
 */
export async function enforceTokenScope(req: Request, needed: ApiScope): Promise<AuthenticatedToken | null> {
  const presented = extractBearer(req);
  if (presented === null) return null; // human path (Vercel Authentication)
  if (!looksLikeApiToken(presented)) {
    throw new HttpError(401, 'unauthorized', 'invalid API token');
  }
  const rows = await sql()`SELECT id, name, scopes, expires_at, revoked_at FROM api_tokens
    WHERE token_hash = ${hashApiToken(presented)} LIMIT 1`;
  if (!rows.length) throw new HttpError(401, 'unauthorized', 'invalid API token');
  const row = rows[0];
  if (row['revoked_at']) throw new HttpError(401, 'unauthorized', 'API token has been revoked');
  if (row['expires_at'] && new Date(row['expires_at'] as string).getTime() <= Date.now()) {
    throw new HttpError(401, 'unauthorized', 'API token has expired');
  }
  const scopes = Array.isArray(row['scopes']) ? (row['scopes'] as string[]) : [];
  if (!tokenHasScope(scopes, needed)) {
    throw new HttpError(403, 'forbidden', `API token lacks the '${needed}' scope`);
  }
  const token: AuthenticatedToken = { id: row['id'] as string, name: row['name'] as string, scopes };
  await sql()`UPDATE api_tokens SET last_used_at = now() WHERE id = ${token.id}`;
  return token;
}

/** Token-management routes are human-only: a token may not manage tokens. */
export function rejectTokenAuth(req: Request): void {
  if (extractBearer(req) !== null) {
    throw new HttpError(403, 'forbidden', 'API tokens cannot manage API tokens');
  }
}

export async function listApiTokens(): Promise<ApiTokenRow[]> {
  const rows = await sql()`SELECT id, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at
    FROM api_tokens ORDER BY created_at DESC`;
  return rows.map((r) => ({
    id: r['id'] as string,
    name: r['name'] as string,
    prefix: r['prefix'] as string,
    scopes: Array.isArray(r['scopes']) ? (r['scopes'] as string[]) : [],
    created_at: r['created_at'] as string,
    last_used_at: (r['last_used_at'] as string | null) ?? null,
    expires_at: (r['expires_at'] as string | null) ?? null,
    revoked_at: (r['revoked_at'] as string | null) ?? null,
  }));
}

/** Create a token row; the plaintext is returned ONCE (never stored). */
export async function createApiToken(
  name: string,
  scopes: string[],
  expiresAt: string | null,
): Promise<{ row: ApiTokenRow; generated: GeneratedToken }> {
  const generated = generateApiToken();
  const rows = await sql()`INSERT INTO api_tokens (name, token_hash, prefix, scopes, expires_at)
    VALUES (${name}, ${generated.tokenHash}, ${generated.prefix}, ${JSON.stringify(scopes)}::jsonb, ${expiresAt})
    RETURNING id, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at`;
  const r = rows[0];
  return {
    generated,
    row: {
      id: r['id'] as string, name: r['name'] as string, prefix: r['prefix'] as string,
      scopes: Array.isArray(r['scopes']) ? (r['scopes'] as string[]) : [],
      created_at: r['created_at'] as string, last_used_at: null,
      expires_at: (r['expires_at'] as string | null) ?? null, revoked_at: null,
    },
  };
}

/** Revoke a token (idempotent-ish: false when unknown / already revoked). */
export async function revokeApiToken(id: string): Promise<boolean> {
  const rows = await sql()`UPDATE api_tokens SET revoked_at = now()
    WHERE id = ${id} AND revoked_at IS NULL RETURNING id`;
  return rows.length > 0;
}
