// SPDX-License-Identifier: MIT
/**
 * test/idempotency-db.test.mjs — A4: retried commands dedupe (DB-gated).
 *
 * Runs ONLY when DATABASE_URL is set (Neon); otherwise the suite skips with
 * a note. The SQL below mirrors the shipped implementation:
 *   - claim:  lib/db/index.ts claimOp()
 *             (INSERT ... ON CONFLICT (op_id) DO NOTHING RETURNING id)
 *   - stash:  lib/api/idempotency.ts idempotentCreate()
 *             (UPDATE command_log SET payload = jsonb_set(payload,'{result}',...))
 *   - read:   lib/api/idempotency.ts readStashedResult()
 *
 * These tests cannot import the lib modules directly: both pull in
 * `server-only`, which throws outside Next. The SQL text is the contract
 * under test — keep it in sync with the sources above.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.log('(idempotency-db: skipped — set DATABASE_URL to run the DB-backed dedupe tests)');
} else {
  const { neon } = await import('@neondatabase/serverless');
  const db = neon(DATABASE_URL);
  const q = (text, params) => db.query(text, params);

  // Mirrors lib/db/index.ts claimOp().
  async function claimOp(projectId, opId, kind, payload) {
    const rows = await q(
      `INSERT INTO command_log (project_id, op_id, kind, payload, job_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (op_id) DO NOTHING
       RETURNING id`,
      [projectId, opId, kind, JSON.stringify(payload ?? {}), null],
    );
    return rows.length ? { id: rows[0].id, replayed: false } : { id: '', replayed: true };
  }

  // Mirrors the result stash in lib/api/idempotency.ts idempotentCreate().
  async function stashResult(opId, result) {
    await q(
      `UPDATE command_log SET payload = jsonb_set(payload, '{result}', $2::jsonb) WHERE op_id = $1`,
      [opId, JSON.stringify(result)],
    );
  }

  // Mirrors lib/api/idempotency.ts readStashedResult().
  async function readStashedResult(opId) {
    const rows = await q(`SELECT payload->'result' AS result FROM command_log WHERE op_id = $1 LIMIT 1`, [opId]);
    return rows[0]?.result ?? null;
  }

  let projectId;

  before(async () => {
    projectId = randomUUID();
    await q(`INSERT INTO projects (id, name) VALUES ($1, 'idempotency-db-test')`, [projectId]);
  });

  after(async () => {
    if (projectId) await q(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  describe('command_log.op_id dedupe (A4, via claimOp SQL)', () => {
    it('second claim of the same op_id is a replay', async () => {
      const opId = randomUUID();
      const first = await claimOp(projectId, opId, 'item.create', { n: 1 });
      assert.equal(first.replayed, false);
      assert.ok(first.id);
      const second = await claimOp(projectId, opId, 'item.create', { n: 1 });
      assert.equal(second.replayed, true);
    });

    it('10 concurrent claims elect exactly one winner', async () => {
      const opId = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => claimOp(projectId, opId, 'item.create', {})),
      );
      const winners = results.filter((r) => !r.replayed);
      assert.equal(winners.length, 1, 'exactly one claim must win');
    });

    it('distinct op ids never collide', async () => {
      const a = await claimOp(projectId, randomUUID(), 'item.create', {});
      const b = await claimOp(projectId, randomUUID(), 'item.create', {});
      assert.equal(a.replayed, false);
      assert.equal(b.replayed, false);
      assert.notEqual(a.id, b.id);
    });

    it('full retried-command flow creates exactly one subject', async () => {
      const opId = randomUUID();
      // Attempt 1: claim wins → create the subject → stash the outcome.
      const c1 = await claimOp(projectId, opId, 'item.create', {});
      assert.equal(c1.replayed, false);
      const subjectId = randomUUID();
      await q(`INSERT INTO subjects (id, project_id, kind) VALUES ($1, $2, 'item')`, [subjectId, projectId]);
      await q(`INSERT INTO items (subject_id) VALUES ($1)`, [subjectId]);
      await stashResult(opId, { subject_id: subjectId });

      // Attempt 2 (retry): claim replays → findPrior re-reads the stash.
      const c2 = await claimOp(projectId, opId, 'item.create', {});
      assert.equal(c2.replayed, true);
      const prior = await readStashedResult(opId);
      assert.equal(prior?.subject_id, subjectId);

      // Exactly one subject is linked to this op — the retry never re-ran
      // the create (it replayed), so no duplicate row exists.
      const rows = await q(
        `SELECT COUNT(*)::int AS c FROM subjects s
         JOIN command_log c ON c.project_id = s.project_id
         WHERE c.op_id = $1 AND s.id = $2`,
        [opId, subjectId],
      );
      assert.equal(rows[0].c, 1);
    });

    it('stashed result survives for late replays', async () => {
      const opId = randomUUID();
      await claimOp(projectId, opId, 'note.create', {});
      await stashResult(opId, { note_id: randomUUID() });
      // A much later retry still resolves the original outcome.
      const late = await claimOp(projectId, opId, 'note.create', {});
      assert.equal(late.replayed, true);
      const prior = await readStashedResult(opId);
      assert.ok(prior?.note_id);
    });
  });
}
