// SPDX-License-Identifier: MIT
/**
 * lib/token-guard.ts — GLOBAL developer-token subset guard (Wave D fix B1).
 *
 * The documented guarantee (DEVELOPER-API.md): a developer API token "can
 * never widen access beyond its scopes" and is "denied on every route
 * outside the documented subset". Per-route enforcement
 * (lib/token-auth.ts enforceTokenScope) only covers the routes that call
 * it — a presented token on any OTHER route would silently ride the
 * human path. This module is the single choke point that closes that
 * negative space: proxy.ts runs it BEFORE every /api handler.
 *
 * Rule: when a request to /api/** presents an Authorization bearer
 * credential carrying the EZVault token prefix (`ezv_`), and the
 * (method, path) is NOT in TOKEN_SUBSET below, the request is denied
 * 403 immediately — before CSRF/rate-limit/handler code runs. Validity
 * and scope checks for subset routes stay in the handlers
 * (enforceTokenScope), exactly as before. Requests with NO bearer, or
 * with a non-token bearer (e.g. the cron secret, which never carries
 * the `ezv_` prefix), are completely unaffected.
 *
 * TOKEN_SUBSET is the ONE allowlist: it mirrors the route table in
 * DEVELOPER-API.md method-for-method, and test/wave-d-fix.test.mjs
 * walks the real route tree asserting every exported (method, path) is
 * either in this subset or denied by the guard for presented tokens.
 *
 * Pure module (no imports at runtime): proxy.ts may run at the edge, so
 * the prefix is spelled out here rather than imported from
 * lib/token-core.ts (which pulls node:crypto); the fix test asserts the
 * two spellings agree with API_TOKEN_PREFIX.
 */

/** Token prefix — must equal API_TOKEN_PREFIX in lib/token-core.ts. */
const EZV_TOKEN_PREFIX = 'ezv_';

/** A dynamic path segment in a subset template (matches any one segment). */
const SEG = ':seg';

export interface TokenSubsetRoute {
  method: string;
  segments: string[];
}

/**
 * The documented developer-API subset (DEVELOPER-API.md), method-aware.
 * Read routes need the `read` scope, note writes need `notes:write` —
 * that check stays in the handlers; this list only decides whether a
 * presented token may reach the handler at all.
 */
export const TOKEN_SUBSET: readonly TokenSubsetRoute[] = [
  { method: 'GET', segments: ['api', 'projects'] },
  { method: 'GET', segments: ['api', 'projects', SEG] },
  { method: 'GET', segments: ['api', 'projects', SEG, 'items'] },
  { method: 'GET', segments: ['api', 'projects', SEG, 'items', SEG] },
  { method: 'GET', segments: ['api', 'projects', SEG, 'items', SEG, 'photos'] },
  { method: 'GET', segments: ['api', 'projects', SEG, 'photos', SEG] },
  { method: 'GET', segments: ['api', 'projects', SEG, 'photos', SEG, 'notes'] },
  { method: 'GET', segments: ['api', 'projects', SEG, 'selections', SEG, 'notes'] },
  { method: 'GET', segments: ['api', 'projects', SEG, 'notes', SEG] },
  { method: 'POST', segments: ['api', 'projects', SEG, 'photos', SEG, 'notes'] },
  { method: 'POST', segments: ['api', 'projects', SEG, 'selections', SEG, 'notes'] },
  { method: 'PATCH', segments: ['api', 'projects', SEG, 'notes', SEG] },
];

/** True when (method, pathname) is inside the documented token subset. */
export function tokenSubsetAllows(method: string, pathname: string): boolean {
  const segs = pathname.split('/').filter((s) => s.length > 0);
  return TOKEN_SUBSET.some(
    (r) =>
      r.method === method &&
      r.segments.length === segs.length &&
      r.segments.every((s, i) => s === SEG || s === segs[i]),
  );
}

/**
 * The presented bearer credential when it carries the EZVault token
 * prefix, else null (no bearer, non-bearer scheme, or a foreign bearer
 * such as the cron secret — all untouched by the guard).
 */
export function presentedApiToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!m) return null;
  const token = (m[1] as string).trim();
  return token.startsWith(EZV_TOKEN_PREFIX) ? token : null;
}

/**
 * The guard decision: true → deny 403 before the handler runs.
 * Only /api/** paths, only presented `ezv_` bearers, only (method, path)
 * pairs outside the documented subset.
 */
export function tokenGuardDenies(input: {
  method: string;
  pathname: string;
  authorization: string | null | undefined;
}): boolean {
  if (!input.pathname.startsWith('/api/')) return false;
  if (presentedApiToken(input.authorization) === null) return false;
  return !tokenSubsetAllows(input.method, input.pathname);
}
