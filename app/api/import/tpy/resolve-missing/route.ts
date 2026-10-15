// SPDX-License-Identifier: MIT
import { handle, ok, parseCappedJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { processPhoto } from '@/lib/import/process-photo';
import { requireRateLimit } from '@/lib/ratelimit';
import { checkCpuGuard } from '@/lib/cpu-budget';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/import/tpy/resolve-missing — re-link photos whose originals
 * were missing. For each resolution the client has staged replacement bytes
 * (uploads/{jobId}/...); /process runs the full pipeline (thumb, counters).
 * With skip: true the photo stays missing (re-link later via /import/complete
 * + /process against the new photo row — original row keeps missing_original).
 */
export const POST = handle(async (req: Request) => {
  await requireRateLimit('import:tpy:resolve-missing');
  await checkCpuGuard();
  const body = await parseCappedJson<{
    job_id?: string; project_id?: string;
    resolutions?: { photo_subject_id?: string; staged_key?: string; skip?: boolean }[];
  }>(req);
  if (!body.job_id) throw new HttpError(400, 'validation', 'job_id is required');
  if (!body.project_id) throw new HttpError(400, 'validation', 'project_id is required');
  await requireProject(body.project_id);
  const jobRows = await sql()`SELECT id FROM import_jobs
    WHERE id = ${body.job_id} AND project_id = ${body.project_id} AND kind = 'tpy'`;
  if (!jobRows.length) throw new HttpError(404, 'not_found', 'tpy import job not found');

  const resolutions = body.resolutions ?? [];
  if (!resolutions.length) throw new HttpError(400, 'validation', 'resolutions[] is required');
  const prefix = `uploads/${body.job_id}/`;

  const results: { photo_subject_id: string; status: string }[] = [];
  for (const r of resolutions) {
    if (!r.photo_subject_id) { results.push({ photo_subject_id: '', status: 'invalid' }); continue; }
    const photoRows = await sql()`SELECT p.subject_id, p.mimetype, p.original_filename, p.item_id,
        p.checksum_sha256, p.missing_original
      FROM photos p JOIN subjects s ON s.id = p.subject_id
      WHERE p.subject_id = ${r.photo_subject_id} AND s.project_id = ${body.project_id}`;
    if (!photoRows.length) { results.push({ photo_subject_id: r.photo_subject_id, status: 'not_found' }); continue; }
    const pr = photoRows[0];
    if (r.skip) {
      results.push({ photo_subject_id: r.photo_subject_id, status: 'skipped' });
      continue;
    }
    if (!r.staged_key?.startsWith(prefix) || r.staged_key.includes('..')) {
      results.push({ photo_subject_id: r.photo_subject_id, status: 'invalid_key' });
      continue;
    }
    const { getStorageDriver } = await import('@/lib/storage/driver');
    await getStorageDriver(); // validates the driver is configured
    try {
      await processPhoto({
        jobId: body.job_id,
        projectId: body.project_id,
        photoSubjectId: pr['subject_id'] as string,
        itemId: pr['item_id'] as string,
        originalFilename: pr['original_filename'] as string,
        mimetype: pr['mimetype'] as string,
        checksumSha256: pr['checksum_sha256'] as string,
        stagedKey: r.staged_key!,
      });
      results.push({ photo_subject_id: r.photo_subject_id, status: 'relinked' });
    } catch (err) {
      const { HttpError } = await import('@/lib/api/route-utils');
      if (err instanceof HttpError) {
        results.push({ photo_subject_id: r.photo_subject_id, status: `failed:${err.code}` });
      } else {
        results.push({ photo_subject_id: r.photo_subject_id, status: 'failed' });
      }
    }
  }
  return ok({ job_id: body.job_id, results });
});
