// SPDX-License-Identifier: MIT
import { handle, ok, parseCappedJson, requireProject, HttpError, apiError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { getStorageDriver, keys } from '@/lib/storage/driver';
import { SQLITE_MAGIC } from '@/lib/import/tpy';
import { requireRateLimit } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/import/tpy/upload-complete — verify the staged .tpy:
 * SQLite magic re-verified via a Range GET of the first 16 bytes
 * (B9/B1 pattern). Updates the job with the staged key.
 */
export const POST = handle(async (req: Request) => {
  await requireRateLimit('import:tpy:upload-complete');
  const body = await parseCappedJson<{
    job_id?: string; project_id?: string; staged_key?: string; assets_zip_key?: string;
  }>(req);
  if (!body.job_id) throw new HttpError(400, 'validation', 'job_id is required');
  if (!body.project_id) throw new HttpError(400, 'validation', 'project_id is required');
  if (!body.staged_key) throw new HttpError(400, 'validation', 'staged_key is required');
  await requireProject(body.project_id);
  const jobRows = await sql()`SELECT id, kind FROM import_jobs
    WHERE id = ${body.job_id} AND project_id = ${body.project_id}`;
  if (!jobRows.length) throw new HttpError(404, 'not_found', 'import job not found');
  if (jobRows[0]['kind'] !== 'tpy') throw new HttpError(400, 'validation', 'job is not a tpy import job');

  const prefix = `tpy-staging/${body.job_id}/`;
  if (!body.staged_key.startsWith(prefix) || body.staged_key.includes('..')) {
    throw new HttpError(400, 'validation', 'staged_key not in this job staging prefix');
  }
  const storage = await getStorageDriver();
  const head = await storage.head(body.staged_key);
  if (!head) return apiError('not_found', 'staged .tpy not found (PUT it first)', 404);

  // SQLite magic re-verify (16 bytes, server-side).
  const probe = await storage.getRange(body.staged_key, 0, 15);
  if (probe.subarray(0, 16).toString('binary') !== SQLITE_MAGIC) {
    await storage.delete(body.staged_key).catch(() => {});
    return apiError('not_sqlite', 'staged file is not a SQLite database (staged object deleted)', 422);
  }

  if (body.assets_zip_key) {
    if (!body.assets_zip_key.startsWith(prefix) || body.assets_zip_key.includes('..')) {
      throw new HttpError(400, 'validation', 'assets_zip_key not in this job staging prefix');
    }
  }

  await sql()`UPDATE import_jobs
    SET checkpoint = COALESCE(checkpoint,'{}'::jsonb)
        || ${JSON.stringify({ tpy_key: body.staged_key, assets_zip_key: body.assets_zip_key ?? null, size_bytes: head.size })}::jsonb,
        status = 'running', updated_at = now()
    WHERE id = ${body.job_id}`;
  return ok({ job_id: body.job_id, verified: true, size_bytes: head.size });
});
