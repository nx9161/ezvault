// SPDX-License-Identifier: MIT
import 'server-only';
/**
 * lib/api/route-utils.ts — shared primitives for /api/* route handlers.
 *
 * Every route file MUST also declare literally:
 *   export const runtime = 'nodejs';
 *   export const maxDuration = 300;
 * (ADR-2.2 — no Edge routes, sharp/sql.js need Node APIs.)
 */

import { sql, getProject } from '../../lib/db/index';

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export function ok(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}

export function apiError(
  code: string,
  message: string,
  status: number,
  detail?: unknown,
  headers?: HeadersInit,
): Response {
  return Response.json(
    { error: message, code, ...(detail !== undefined ? { detail } : {}) },
    { status, headers },
  );
}

export const notFound = (what = 'not found') => apiError('not_found', what, 404);
export const badRequest = (message: string, detail?: unknown) => apiError('validation', message, 400, detail);

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function requireUuid(v: unknown, name: string): string {
  if (!isUuid(v)) throw new HttpError(400, 'validation', `invalid ${name}`);
  return v;
}

// ---------------------------------------------------------------------------
// Errors that map to HTTP responses
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
  }
}

/** Wrap a handler so HttpError becomes a proper JSON response. */
export function handle<T extends unknown[]>(
  fn: (...args: T) => Promise<Response>,
): (...args: T) => Promise<Response> {
  return async (...args: T) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof HttpError) {
        const headers: Record<string, string> = {};
        const retryAfter = (err as unknown as { retryAfterSec?: unknown }).retryAfterSec;
        if (typeof retryAfter === 'number') headers['Retry-After'] = String(retryAfter);
        return apiError(err.code, err.message, err.status, err.detail, headers);
      }
      console.error('api error:', err);
      return apiError('internal', 'internal error', 500);
    }
  };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function requireProject(projectId: string) {
  const project = await getProject(projectId);
  if (!project) throw new HttpError(404, 'not_found', 'project not found');
  return project;
}

// ---------------------------------------------------------------------------
// CSRF: Origin/Referer check (defense-in-depth; proxy.ts enforces at edge too)
// ---------------------------------------------------------------------------

export function checkOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');
  const host = req.headers.get('host') || '';
  const expected = `https://${host}`;
  const httpExpected = `http://${host}`;
  const good = (v: string | null) =>
    !v || v === expected || v === httpExpected || v.startsWith(expected + '/') || v.startsWith(httpExpected + '/');
  // Same-origin browser navigations (GET) send no Origin; mutating routes
  // require the check to pass when a value is present.
  if (!origin && !referer) return true;
  return good(origin) && good(referer);
}

export function requireSameOrigin(req: Request): void {
  if (!checkOrigin(req)) throw new HttpError(403, 'csrf', 'origin check failed');
}

// ---------------------------------------------------------------------------
// B11: depth/width-capped JSON parse for import routes.
// max depth 64, max keys 200k -> 413. (Vercel's 4.5MB body limit bounds bytes;
// the pre-scan below bounds nesting so JSON.parse cannot stack-overflow.)
// ---------------------------------------------------------------------------

const MAX_JSON_DEPTH = 64;
const MAX_JSON_KEYS = 200_000;
const MAX_BODY_BYTES = 4_500_000;

function scanDepth(text: string): void {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (c === 92) esc = true; // backslash
      else if (c === 34) inStr = false; // quote
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 91 || c === 123) {
      depth++;
      if (depth > MAX_JSON_DEPTH) throw new HttpError(413, 'too_deep', `JSON nesting exceeds ${MAX_JSON_DEPTH}`);
    } else if (c === 93 || c === 125) {
      depth--;
      if (depth < 0) throw new HttpError(400, 'validation', 'malformed JSON');
    }
  }
}

function countKeys(root: unknown): number {
  let count = 0;
  const stack: unknown[] = [root];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (const el of v) {
        if (el !== null && typeof el === 'object') stack.push(el);
      }
    } else if (v !== null && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        count++;
        if (count > MAX_JSON_KEYS) throw new HttpError(413, 'too_wide', `JSON key count exceeds ${MAX_JSON_KEYS}`);
        const child = (v as Record<string, unknown>)[k];
        if (child !== null && typeof child === 'object') stack.push(child);
      }
    }
  }
  return count;
}

/** Parse a request body with B11 caps. Throws HttpError(413) when capped. */
export async function parseCappedJson<T = unknown>(req: Request): Promise<T> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', 'request body too large');
  if (!text.trim()) throw new HttpError(400, 'validation', 'empty body');
  scanDepth(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'validation', 'malformed JSON');
  }
  countKeys(parsed);
  return parsed as T;
}

/** Plain JSON parse for non-import routes (still bounded by body size). */
export async function parseJson<T = unknown>(req: Request): Promise<T> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', 'request body too large');
  try {
    return (text.trim() ? JSON.parse(text) : {}) as T;
  } catch {
    throw new HttpError(400, 'validation', 'malformed JSON');
  }
}

// ---------------------------------------------------------------------------
// Pagination (?cursor=&limit=) — cursor is an opaque integer offset in v1.
// ---------------------------------------------------------------------------

export function pagination(url: URL, maxLimit = 200): { limit: number; offset: number } {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), maxLimit);
  const offset = Math.max(parseInt(url.searchParams.get('cursor') || '0', 10) || 0, 0);
  return { limit, offset };
}

export function nextCursor(offset: number, limit: number, returned: number): string | undefined {
  return returned === limit ? String(offset + limit) : undefined;
}
