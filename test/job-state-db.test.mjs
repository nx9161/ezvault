// SPDX-License-Identifier: MIT
/**
 * test/job-state-db.test.mjs — A6: import_jobs.error surfaces via the
 * job-state read model (GET /api/jobs/[jobId]).
 *
 * CONTRACT (for the frontend builder): the failure-reason field is named
 * `error` (string | null) — NOT `err`. Render it whenever non-null.
 *
 * DB-GATED: runs only when DATABASE_URL is set. The SQL mirrors
 * lib/api/jobs.ts getJobState() (that module imports `server-only`, which
 * throws outside Next, so the test mirrors the shipped queries).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.log('(job-state-db: skipped — set DATABASE_URL to run)');
} else {
  const { neon } = await import('@neondatabase/serverless');
  const db = neon(DATABASE_URL);
  const q = (text, params) => db.query(text, params);

  // Mirrors lib/api/jobs.ts getJobState().
  async function getJobState(jobId) {
    const rows = await q(`SELECT * FROM import_jobs WHERE id = $1`, [jobId]);
    assert.ok(rows.length, 'job must exist');
    const j = rows[0];
    const subjectCount = await q(`SELECT COUNT(*)::int AS c FROM tpy_import_map WHERE job_id = $1`, [jobId]);
    return {
      id: j.id, status: j.status, total: Number(j.total), done: Number(j.done),
      failed: Number(j.failed), error: j.error ?? null,
      subjects_imported: Number(subjectCount[0]?.c ?? 0),
    };
  }

  const projectId = randomUUID();
  const jobIds = [];

  before(async () => {
    await q(`INSERT INTO projects (id, name) VALUES ($1, 'job-state-test')`, [projectId]);
  });

  after(async () => {
    for (const id of jobIds) await q(`DELETE FROM import_jobs WHERE id = $1`, [id]);
    await q(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  async function makeJob(status, error) {
    const id = randomUUID();
    await q(`INSERT INTO import_jobs (id, project_id, kind, status, total, done, failed, error)
             VALUES ($1, $2, 'upload', $3, 4, 1, 1, $4)`, [id, projectId, status, error]);
    jobIds.push(id);
    return id;
  }

  describe('job-state error surfacing (A6)', () => {
    it('failed job surfaces its error text verbatim', async () => {
      const id = await makeJob('failed', 'presign expired: upload never completed (staged files swept after 24h)');
      const s = await getJobState(id);
      assert.equal(s.status, 'failed');
      assert.equal(s.error, 'presign expired: upload never completed (staged files swept after 24h)');
    });

    it('abandoned-job error text is readable', async () => {
      const id = await makeJob('failed', 'abandoned: no client progress for 7d; staged files swept');
      const s = await getJobState(id);
      assert.equal(s.error, 'abandoned: no client progress for 7d; staged files swept');
    });

    it('non-failed jobs surface error: null', async () => {
      const id = await makeJob('running', null);
      const s = await getJobState(id);
      assert.equal(s.status, 'running');
      assert.equal(s.error, null);
    });
  });
}
