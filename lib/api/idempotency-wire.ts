// SPDX-License-Identifier: MIT
/**
 * lib/api/idempotency-wire.ts — clientOpId WIRE FORMAT (pure module: no
 * `server-only`, no DB imports — safe to unit-test and to import from
 * client-side code that needs the contract constants).
 *
 * =====================================================================
 * A4 SERVER CONTRACT — clientOpId idempotency (for the frontend builder)
 * =====================================================================
 *
 * Transport
 *   - Preferred: JSON request body field `clientOpId`.
 *   - Fallback: `x-client-op-id` request header (for bodiless mutations;
 *     lib/api/client.ts already sends it — the server reads the body
 *     first, then the header).
 *
 * Format
 *   - UUID v4, canonical 8-4-4-4-12 hex (case-insensitive). Anything else
 *     → 400 `{ code: "validation", error: "invalid clientOpId" }`.
 *
 * Client rules (frontend builder: wire these)
 *   1. Mint ONE UUID per user intent (crypto.randomUUID()).
 *   2. Send the SAME op id on every retry of that intent (network retry,
 *      timeout, double-submit).
 *   3. NEVER reuse an op id across different intents. op_id is globally
 *      unique in command_log — a reused id returns the FIRST intent's
 *      outcome with `replayed: true` and does NOT execute the second one.
 *   4. `replayed: true` means success: the outcome shape is identical to the
 *      first execution, except creates answer 200 instead of 201.
 *   5. `replayed: true` with a null/empty result means the first attempt
 *      died after claiming but before finishing: retry the intent with a
 *      FRESH op id (the orphaned side effects, if any, are swept by the
 *      nightly cron's presign-orphan pass).
 *
 * Server rules
 *   1. claimOp() — INSERT INTO command_log ... ON CONFLICT (op_id) DO NOTHING —
 *      runs BEFORE any side effect on every create-path. The claim is the
 *      exactly-once gate (fixes the old check-then-act race where two
 *      concurrent retries could both create a row).
 *   2. Every mutating response echoes `clientOpId` when one was supplied.
 *   3. Replays return the first attempt's outcome + `replayed: true`. The
 *      created row's id is stashed at command_log.payload.result so a replay
 *      re-reads the real outcome instead of guessing.
 *   4. Update-paths (PATCH) record the op for undo accounting; the update
 *      itself is naturally idempotent.
 *
 * Related contracts (same handoff)
 *   - F-F delete-everything: POST /api/admin/delete-everything with body
 *     `{ "confirm": "DELETE" }` (the exact string "DELETE"; anything else →
 *     400). Success 200:
 *       { deleted: true, r2_deleted: <n>, tables_truncated: [...],
 *         backups: { retained: true, retention_days: 365,
 *           note: "Monthly backups in the backup bucket are retained per the
 *                  365-day lifecycle. Crypto-shredding them requires
 *                  destroying MASTER_KEY per docs/RUNBOOK.md — this endpoint
 *                  wipes live data only." } }
 *     Auth: Vercel Authentication (deployment protection) gates the app;
 *     no additional in-app auth (single-user).
 *   - import_jobs error field: the column is named `error` (TEXT, nullable)
 *     — NOT `err`. GET /api/jobs/[jobId] surfaces it as `error`
 *     (string | null). Render it whenever non-null; it carries the
 *     human-readable failure reason.
 */

// Canonical UUID pattern (mirrors isUuid in ./route-utils, which cannot be
// imported here — route-utils pulls in `server-only`).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when v is a well-formed clientOpId (UUID string). */
export function isClientOpId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/**
 * Resolve the op id for a request: body.clientOpId first, then the
 * `x-client-op-id` header. Returns null when neither is present.
 * (Validation happens in claimClientOpId — a malformed value is a 400.)
 */
export function resolveClientOpId(
  req: Request,
  body: { clientOpId?: unknown } | null | undefined,
): string | null {
  const fromBody = body?.clientOpId;
  if (typeof fromBody === 'string' && fromBody.length > 0) return fromBody;
  const fromHeader = req.headers.get('x-client-op-id');
  return fromHeader && fromHeader.length > 0 ? fromHeader : null;
}
