// SPDX-License-Identifier: MIT
/**
 * test/rate-limit-db.test.mjs — W2-C backend side: the rate limiter under a
 * concurrent burst (DB-gated).
 *
 * Runs ONLY when DATABASE_URL is set (Neon); otherwise the suite skips with
 * a note. The SQL below mirrors the shipped implementation:
 *   - consume: lib/ratelimit.ts consumeRateBucket()
 *              (lazy INSERT ... ON CONFLICT DO NOTHING, then ONE atomic
 *              refill+consume statement under SELECT ... FOR UPDATE)
 *
 * This test cannot import lib/ratelimit.ts directly: it pulls in
 * `server-only`, which throws outside Next. The SQL text is the contract
 * under test — keep it in sync with the source above.
 *
 * What the Playwright e2e asserts (and this test locks at the DB layer):
 *   40-concurrent burst at POST /api/import/presign
 *   (bucket `import:presign`, capacity 30, refill 0.5/s) → the overflow
 *   gets 429 + Retry-After, zero 500s. The 429 + Retry-After header mapping
 *   lives in lib/api/route-utils.ts handle() (HttpError.retryAfterSec →
 *   header); the concurrency property (no deadlocks, exact accounting) is
 *   what this file proves: N concurrent consumes on one bucket row →
 *   exactly `capacity` allowed, the rest denied, zero query errors.
 *
 * Determinism note: the burst bucket is pre-created with refill_per_sec=0
 * so wall-clock refill cannot grant phantom tokens mid-burst. The refill
 * math itself is covered by the sequential retryAfterSec test.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.log('(rate-limit-db: skipped — set DATABASE_URL to run the burst tests)');
} else {
  const { neon } = await import('@neondatabase/serverless');
  const db = neon(DATABASE_URL);
  const q = (text, params) => db.query(text, params);

  // Mirrors lib/ratelimit.ts consumeRateBucket() (default bucket values for
  // the lazy INSERT: capacity 60, refill 1/sec — a no-op when the row was
  // pre-created by the test setup).
  async function consume(key) {
    await q(
      `INSERT INTO rate_buckets (key, tokens, capacity, refill_per_sec)
       VALUES ($1, 60, 60, 1) ON CONFLICT (key) DO NOTHING`,
      [key],
    );
    const rows = await q(
      `WITH b AS (
         SELECT * FROM rate_buckets WHERE key = $1 FOR UPDATE
       ),
       calc AS (
         SELECT LEAST(b.capacity, b.tokens + EXTRACT(EPOCH FROM (now() - b.updated_at)) * b.refill_per_sec) AS avail,
                b.refill_per_sec AS rps
         FROM b
       )
       UPDATE rate_buckets r
       SET tokens = (SELECT CASE WHEN c.avail >= 1 THEN c.avail - 1 ELSE c.avail END FROM calc c),
           updated_at = now()
       WHERE r.key = $1
       RETURNING (SELECT c.avail >= 1 FROM calc c) AS allowed,
                 (SELECT c.avail FROM calc c) AS avail,
                 (SELECT c.rps FROM calc c) AS rps,
                 r.tokens AS remaining`,
      [key],
    );
    const row = rows[0];
    const allowed = row.allowed === true || row.allowed === 't';
    const avail = Number(row.avail);
    const rps = Number(row.rps) || 1;
    return {
      allowed,
      retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((1 - avail) / rps)),
      remaining: Math.max(0, Math.floor(Number(row.remaining))),
    };
  }

  // Synthetic keys per run — never real route buckets, so production
  // limiter state is untouched. Cleaned up in before() (idempotent).
  const RUN = randomUUID();
  const KEY_BURST = `e2e:rate-limit-burst:${RUN}`; // 60 tokens, NO refill (deterministic)
  const KEY_EMPTY = `e2e:rate-limit-empty:${RUN}`; // 0 tokens, refill 1/sec

  before(async () => {
    await q(`DELETE FROM rate_buckets WHERE key = $1 OR key = $2`, [KEY_BURST, KEY_EMPTY]);
    await q(
      `INSERT INTO rate_buckets (key, tokens, capacity, refill_per_sec)
       VALUES ($1, 60, 60, 0), ($2, 0, 60, 1)`,
      [KEY_BURST, KEY_EMPTY],
    );
  });

  describe('rate limiter under a concurrent burst (W2-C)', () => {
    it('70 concurrent consumes → exactly 60 allowed, 10 denied, zero errors', async () => {
      const settled = await Promise.allSettled(
        Array.from({ length: 70 }, () => consume(KEY_BURST)),
      );
      const rejected = settled.filter((s) => s.status === 'rejected');
      assert.equal(rejected.length, 0,
        `burst must not raise (zero 500-equivalents): ${rejected.slice(0, 2).map((r) => String(r.reason)).join('; ')}`);
      const results = settled.map((s) => s.value);
      assert.equal(results.filter((r) => r.allowed).length, 60);
      assert.equal(results.filter((r) => !r.allowed).length, 10);
    });

    it('a denied consume carries retryAfterSec >= 1 (feeds the Retry-After header)', async () => {
      const r = await consume(KEY_EMPTY);
      assert.equal(r.allowed, false);
      assert.ok(r.retryAfterSec >= 1, `retryAfterSec=${r.retryAfterSec}`);
      assert.equal(r.remaining, 0);
    });

    it('the lazy-INSERT path allows a fresh key with retryAfterSec 0', async () => {
      const r = await consume(`e2e:rate-limit-fresh:${RUN}`);
      assert.equal(r.allowed, true);
      assert.equal(r.retryAfterSec, 0);
      assert.equal(r.remaining, 59);
    });
  });
}
