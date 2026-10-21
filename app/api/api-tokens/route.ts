// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, HttpError } from '@/lib/api/route-utils';
import { listApiTokens, createApiToken, rejectTokenAuth } from '@/lib/token-auth';
import { normalizeScopes } from '@/lib/token-core';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Developer API tokens (row 36) — HUMAN-ONLY management surface (a token
 * cannot manage tokens). GET lists tokens (prefix/scopes/last-used only;
 * hashes and secrets are never returned). POST creates a token and
 * returns the plaintext secret ONCE — only its SHA-256 hash is stored.
 */
export const GET = handle(async (req: Request) => {
  rejectTokenAuth(req);
  const tokens = await listApiTokens();
  return ok({ items: tokens, total: tokens.length });
});

export const POST = handle(async (req: Request) => {
  rejectTokenAuth(req);
  const body = await parseJson<{ name?: string; scopes?: unknown; expires_at?: string | null }>(req);
  const name = (body.name ?? '').trim();
  if (!name) throw new HttpError(400, 'validation', 'name is required');
  const scopes = normalizeScopes(body.scopes);
  if (!scopes) throw new HttpError(400, 'validation', "scopes must be a non-empty subset of ['read', 'notes:write']");
  let expiresAt: string | null = null;
  if (body.expires_at !== undefined && body.expires_at !== null) {
    const when = new Date(body.expires_at);
    if (Number.isNaN(when.getTime())) throw new HttpError(400, 'validation', 'expires_at must be an ISO timestamp');
    expiresAt = when.toISOString();
  }
  const { row, generated } = await createApiToken(name.slice(0, 200), scopes, expiresAt);
  // The plaintext secret appears in THIS response only — never stored.
  return ok({ token: row, secret: generated.token }, 201);
});
