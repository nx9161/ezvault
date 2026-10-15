// SPDX-License-Identifier: MIT
import { handle, ok, HttpError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { undoJob } from '@/lib/import/photos';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ jobId: string }> };

/** Compound transactional undo of a whole import job (B28). */
export const POST = handle(async (_req: Request, ctx: Ctx) => {
  const { jobId } = await ctx.params;
  const rows = await sql()`SELECT project_id, kind, status FROM import_jobs WHERE id = ${jobId}`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'job not found');
  const undone = await undoJob(jobId, rows[0]['project_id'] as string);
  return ok({ job_id: jobId, undone_subjects: undone });
});
