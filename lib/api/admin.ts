// SPDX-License-Identifier: MIT
/**
 * lib/api/admin.ts — pure helpers for admin routes (no `server-only`,
 * safe to import from tests).
 */

/**
 * F-F typed-confirm contract: the delete-everything body must be exactly
 * {confirm:"DELETE"} — missing, wrong value, or extra keys all reject.
 * Returns true when the body is valid.
 */
export function isDeleteEverythingConfirm(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const keys = Object.keys(body);
  return keys.length === 1
    && (body as Record<string, unknown>)['confirm'] === 'DELETE';
}
