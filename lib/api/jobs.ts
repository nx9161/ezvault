// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/api/jobs.ts — job-state read model for the import jobs API.
 *
 * CONTRACT (for the frontend builder — the field name the frontend
 * renders): the failure-reason column is named `error` (TEXT, nullable)
 * — NOT `err`. It is surfaced as `error` (string | null) on
 * GET /api/jobs/[jobId]; render it whenever non-null. Statuses:
 * queued | running | paused_cpu | failed | done | cancelled.
 *
 * Failure paths write error text: the nightly cron's queue tick writes
 * idle-timeout / presign-orphan / abandonment reasons (see
 * app/api/cron/nightly/route.ts), and tpy run/analyze paths record their
 * failure into this column. A job with status='failed' SHOULD have a
 * non-null error.
 */
import { sql } from '../db/index';
import { HttpError } from './route-utils';

export interface JobState {
  id: string;
  project_id: string;
  kind: string;
  status: string;
  total: number;
  done: number;
  failed: number;
  checkpoint: Record<string, unknown>;
  cpu_seconds: number;
  subjects_imported: number;
  /** Failure reason; null when the job has not failed. Renders in the UI. */
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** Throw 404 unless the job exists (for routes that only need existence). */
export async function assertJobExists(jobId: string): Promise<void> {
  const rows = await sql()`SELECT id FROM import_jobs WHERE id = ${jobId}`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'job not found');
}

/** Load the full job-state payload returned by GET /api/jobs/[jobId]. */
export async function getJobState(jobId: string): Promise<JobState> {
  const rows = await sql()`SELECT * FROM import_jobs WHERE id = ${jobId}`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'job not found');
  const j = rows[0] as Record<string, unknown>;
  const subjectCount = await sql()`SELECT COUNT(*)::int AS c FROM tpy_import_map WHERE job_id = ${jobId}`;
  return {
    id: String(j['id']),
    project_id: String(j['project_id']),
    kind: String(j['kind']),
    status: String(j['status']),
    total: Number(j['total']),
    done: Number(j['done']),
    failed: Number(j['failed']),
    checkpoint: (j['checkpoint'] as Record<string, unknown> | null) ?? {},
    cpu_seconds: Number(j['cpu_seconds'] ?? 0),
    subjects_imported: Number((subjectCount[0] as Record<string, unknown>)['c'] ?? 0),
    error: (j['error'] as string | null) ?? null,
    created_at: String(j['created_at']),
    updated_at: String(j['updated_at']),
  };
}
