// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, HttpError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { getStorageDriver } from '@/lib/storage/driver';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ jobId: string }> };

/**
 * Retry a job: marks it running again and clears the failure count; the
 * client re-invokes /import/process once per failed photo.
 * Body: { photo_subject_ids?: string[] } (for checkpoint bookkeeping).
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { jobId } = await ctx.params;
  const rows = await sql()`SELECT id, status FROM import_jobs WHERE id = ${jobId}`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'job not found');
  const body = await parseJson<{ photo_subject_ids?: string[] }>(req).catch((): { photo_subject_ids?: string[] } => ({}));
  const subjects = (body.photo_subject_ids ?? []).filter((s: unknown) => typeof s === 'string');
  await sql()`UPDATE import_jobs
    SET status = 'running', error = NULL, failed = 0,
        checkpoint = COALESCE(checkpoint,'{}'::jsonb) || ${JSON.stringify({ retried_subjects: subjects })}::jsonb,
        updated_at = now()
    WHERE id = ${jobId}`;
  return ok({ id: jobId, status: 'running', retried: subjects.length });
});
