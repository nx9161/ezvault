// SPDX-License-Identifier: MIT
/**
 * test/cpu-window-db.test.mjs — A5: cpu_budget_windows concurrency guard.
 *
 * DB-GATED: runs only when DATABASE_URL is set, and ONLY against a SCRATCH
 * database — the tests delete/expire cpu_budget_windows rows (never run
 * against the production Neon project; use a scratch branch).
 *
 * The SQL mirrors lib/cpu-budget.ts currentWindow() (migration 0007 added
 * the partial unique index). These tests cannot import the lib module
 * directly: it pulls in `server-only`, which throws outside Next.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.log('(cpu-window-db: skipped — set DATABASE_URL to a SCRATCH database to run)');
} else {
  const { neon } = await import('@neondatabase/serverless');
  const db = neon(DATABASE_URL);
  const q = (text, params) => db.query(text, params);

  // Mirrors lib/cpu-budget.ts currentWindow().
  async function currentWindow() {
    await q(`UPDATE cpu_budget_windows SET active = false WHERE active AND window_end <= now()`);
    const rows = await q(
      `WITH latest AS (
         SELECT id, window_start, window_end, cpu_seconds, paused
         FROM cpu_budget_windows WHERE active LIMIT 1
       ),
       ins AS (
         INSERT INTO cpu_budget_windows (window_start, window_end, cpu_seconds, paused, active)
         SELECT now(), now() + interval '30 days', 0, false, true
         WHERE NOT EXISTS (SELECT 1 FROM latest WHERE window_end > now())
         ON CONFLICT (active) WHERE active DO UPDATE SET active = EXCLUDED.active
         RETURNING id, window_start, window_end, cpu_seconds, paused
       )
       SELECT id, window_start, window_end, cpu_seconds, paused FROM ins
       UNION ALL
       SELECT id, window_start, window_end, cpu_seconds, paused FROM latest
       WHERE NOT EXISTS (SELECT 1 FROM ins)`,
    );
    assert.ok(rows.length, 'currentWindow must return a row');
    return rows[0];
  }

  before(async () => {
    // Idempotent DDL (mirrors db/migrations/0007_cpu_window_active.sql).
    await q(`ALTER TABLE cpu_budget_windows ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT false`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS cpu_budget_windows_active_uniq ON cpu_budget_windows (active) WHERE active`);
  });

  after(async () => {
    await q(`DELETE FROM cpu_budget_windows`);
  });

  describe('cpu_budget_windows uniqueness (A5)', () => {
    it('20 concurrent first-calls converge on exactly one window', async () => {
      await q(`DELETE FROM cpu_budget_windows`);
      const wins = await Promise.all(Array.from({ length: 20 }, () => currentWindow()));
      const ids = new Set(wins.map((w) => w.id));
      assert.equal(ids.size, 1, `all callers must see the same window, got ${ids.size}`);
      const active = await q(`SELECT COUNT(*)::int AS c FROM cpu_budget_windows WHERE active`);
      assert.equal(active[0].c, 1, 'exactly one active row may exist');
      const total = await q(`SELECT COUNT(*)::int AS c FROM cpu_budget_windows`);
      assert.equal(total[0].c, 1, 'no duplicate window rows may exist');
    });

    it('an expired window rolls exactly once under concurrency', async () => {
      await q(`DELETE FROM cpu_budget_windows`);
      const first = await currentWindow();
      // Expire it, then race 10 callers on the roll.
      await q(`UPDATE cpu_budget_windows SET window_end = now() - interval '1 second' WHERE id = $1`, [first.id]);
      const wins = await Promise.all(Array.from({ length: 10 }, () => currentWindow()));
      const ids = new Set(wins.map((w) => w.id));
      assert.equal(ids.size, 1, 'all rollers must see the same fresh window');
      assert.notEqual([...ids][0], first.id, 'the rolled window must be a new row');
      const active = await q(`SELECT COUNT(*)::int AS c FROM cpu_budget_windows WHERE active`);
      assert.equal(active[0].c, 1, 'exactly one active row after the roll');
      const old = await q(`SELECT active FROM cpu_budget_windows WHERE id = $1`, [first.id]);
      assert.equal(old[0].active, false, 'the expired window is deactivated');
    });

    it('a live window is returned as-is (no insert)', async () => {
      await q(`DELETE FROM cpu_budget_windows`);
      const first = await currentWindow();
      const second = await currentWindow();
      assert.equal(second.id, first.id);
      const total = await q(`SELECT COUNT(*)::int AS c FROM cpu_budget_windows`);
      assert.equal(total[0].c, 1, 'no extra row for a live window');
    });
  });
}
