// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/ratelimit.ts — durable Neon rate limiting (B16).
 *
 * AppSec §1.8: an in-memory Map in Edge middleware is per-isolate and
 * non-coordinating — false confidence. The binding control is a `rate_buckets`
 * row consumed IN-TRANSACTION (single SQL statement: refill + consume are
 * atomic) via the HTTP driver. proxy.ts keeps a best-effort in-memory
 * token bucket as an outer layer only.
 *
 * Single-user model: buckets are route-scoped (one row per route key —
 * trivial rows, negligible CU).
 */

import { sql } from './db/index';

interface BucketConfig {
  capacity: number;
  refillPerSec: number;
}

/** Route-key -> token bucket config. */
const BUCKETS: Record<string, BucketConfig> = {
  'import:presign': { capacity: 30, refillPerSec: 0.5 }, // 30 burst, 30/min
  'import:complete': { capacity: 60, refillPerSec: 1 },
  'import:process': { capacity: 120, refillPerSec: 2 }, // one photo per call
  'import:folder-session': { capacity: 30, refillPerSec: 0.5 },
  'import:tpy': { capacity: 30, refillPerSec: 0.5 }, // presign/complete/analyze/run/report
  'import:jsonld': { capacity: 20, refillPerSec: 0.34 }, // ~20/min
  'vocabularies:import': { capacity: 10, refillPerSec: 0.17 }, // ~10/min
  'export:jsonld': { capacity: 30, refillPerSec: 0.5 },
  'export:file': { capacity: 120, refillPerSec: 2 }, // bake/export per photo
  'storage:compress': { capacity: 10, refillPerSec: 0.17 },
  // F-F: the nuclear option — 3 attempts, ~1/hour refill.
  'admin:delete-everything': { capacity: 3, refillPerSec: 1 / 3600 },
};

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until a token is likely available (for Retry-After). */
  retryAfterSec: number;
  remaining: number;
}

/**
 * Consume one token from the named bucket. Atomic single statement:
 * lazy-creates the row, refills by elapsed time, consumes iff available.
 */
export async function consumeRateBucket(key: string): Promise<RateLimitResult> {
  const cfg = BUCKETS[key] ?? { capacity: 60, refillPerSec: 1 };
  // Lazy-create the bucket row first (idempotent). The consume below is a
  // single atomic statement (refill + consume under FOR UPDATE).
  await sql()`
    INSERT INTO rate_buckets (key, tokens, capacity, refill_per_sec)
    VALUES (${key}, ${cfg.capacity}, ${cfg.capacity}, ${cfg.refillPerSec})
    ON CONFLICT (key) DO NOTHING`;
  const rows = await sql()`
    WITH b AS (
      SELECT * FROM rate_buckets WHERE key = ${key} FOR UPDATE
    ),
    calc AS (
      SELECT LEAST(b.capacity, b.tokens + EXTRACT(EPOCH FROM (now() - b.updated_at)) * b.refill_per_sec) AS avail,
             b.refill_per_sec AS rps
      FROM b
    )
    UPDATE rate_buckets r
    SET tokens = (SELECT CASE WHEN c.avail >= 1 THEN c.avail - 1 ELSE c.avail END FROM calc c),
        updated_at = now()
    WHERE r.key = ${key}
    RETURNING (SELECT c.avail >= 1 FROM calc c) AS allowed,
              (SELECT c.avail FROM calc c) AS avail,
              (SELECT c.rps FROM calc c) AS rps,
              r.tokens AS remaining`;
  const row = rows[0] as { allowed: boolean; avail: string; rps: string; remaining: string };
  const allowed = Boolean(row.allowed);
  const avail = Number(row.avail);
  const rps = Number(row.rps) || 1;
  return {
    allowed,
    retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((1 - avail) / rps)),
    remaining: Math.max(0, Math.floor(Number(row.remaining))),
  };
}

/** Route helper: 429 + Retry-After when the bucket is empty. */
export async function requireRateLimit(key: string): Promise<void> {
  const r = await consumeRateBucket(key);
  if (!r.allowed) {
    const { HttpError } = await import('./api/route-utils');
    const err = new HttpError(429, 'rate_limited', 'rate limit exceeded — slow down');
    (err as unknown as { retryAfterSec: number }).retryAfterSec = r.retryAfterSec;
    throw err;
  }
}
