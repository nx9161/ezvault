// SPDX-License-Identifier: MIT
/**
 * lib/api/admin.ts — pure helpers for admin routes (no `server-only`,
 * safe to import from tests).
 */

/**
 * F-H typed-confirm contract: the delete-everything body must be exactly
 * {confirm:"DELETE"} — missing, wrong value, or extra keys all reject.
 * Returns true when the body is valid.
 */
export function isDeleteEverythingConfirm(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const keys = Object.keys(body);
  return keys.length === 1
    && (body as Record<string, unknown>)['confirm'] === 'DELETE';
}

/**
 * F-H: the 503 payload returned by GET /api/health when DATABASE_URL is
 * missing. The message is kept verbatim from lib/db/index.ts so the
 * deploy smoke test sees the same setup instructions everywhere.
 */
export function notConfiguredBody(): { status: 'not_configured'; message: string } {
  return {
    status: 'not_configured',
    message:
      'DATABASE_URL is not set. Copy .env.example to .env.local and add your Neon connection string.',
  };
}
