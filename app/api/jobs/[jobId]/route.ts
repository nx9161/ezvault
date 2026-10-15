// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, HttpError } from '@/lib/api/route-utils';
import { sql, tx } from '@/lib/db/index';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ jobId: string }> };

async function getJob(jobId: string) {
  const rows = await sql()`SELECT * FROM import_jobs WHERE id = ${jobId}`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'job not found');
  return rows[0];
}

/** Job status: totals, done/failed so far, checkpoint, CPU consumed. */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { jobId } = await ctx.params;
  const j = await getJob(jobId);
  const subjectCount = await sql()`SELECT COUNT(*)::int AS c FROM tpy_import_map WHERE job_id = ${jobId}`;
  return ok({
    id: j['id'], project_id: j['project_id'], kind: j['kind'], status: j['status'],
    total: Number(j['total']), done: Number(j['done']), failed: Number(j['failed']),
    checkpoint: j['checkpoint'] ?? {}, cpu_seconds: Number(j['cpu_seconds'] ?? 0),
    subjects_imported: Number(subjectCount[0]['c'] ?? 0),
    error: j['error'], created_at: j['created_at'], updated_at: j['updated_at'],
  });
});

/** Client heartbeat — merge into the job checkpoint (progress reporting). */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { jobId } = await ctx.params;
  await getJob(jobId);
  const body = await parseJson<{ checkpoint?: Record<string, unknown> }>(req);
  const checkpoint = body.checkpoint ?? {};
  if (typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    throw new HttpError(400, 'validation', 'checkpoint must be an object');
  }
  const qq = (text: string, params?: unknown[]) => ({ text, params });
  await tx(() => [
    qq(`UPDATE import_jobs SET checkpoint = COALESCE(checkpoint,'{}'::jsonb) || $2::jsonb,
        updated_at = now() WHERE id = $1`, [jobId, JSON.stringify(checkpoint)]),
  ]);
  const j = await getJob(jobId);
  return ok({ id: j['id'], status: j['status'], checkpoint: j['checkpoint'] ?? {} });
});
