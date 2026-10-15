// SPDX-License-Identifier: MIT
import { handle, ok, parseCappedJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { processPhoto } from '@/lib/import/process-photo';
import { getPhotoJson } from '@/lib/api/shapes';
import { requireRateLimit } from '@/lib/ratelimit';
import { checkCpuGuard } from '@/lib/cpu-budget';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/import/process — ONE photo per invocation (Vercel timeout
 * discipline). The client orchestrates: /complete returns photo_subject_id
 * per file; the client calls /process once per photo.
 *
 * Honor list: B5 (50M-pixel dimension pre-check), B6 (SVG sanitize via sax),
 * B16 (rate limit), §8 (CPU guard 503), one txn (photo commit + counters
 * + cpu_seconds + rev bump), HEIC conversion-artifact path (ADR-2.16).
 */
export const POST = handle(async (req: Request) => {
  await requireRateLimit('import:process');
  await checkCpuGuard();
  const body = await parseCappedJson<{
    job_id?: string; project_id?: string; photo_subject_id?: string; staged_key?: string;
    clientOpId?: string;
  }>(req);

  if (!body.job_id) throw new HttpError(400, 'validation', 'job_id is required');
  if (!body.project_id) throw new HttpError(400, 'validation', 'project_id is required');
  if (!body.photo_subject_id) throw new HttpError(400, 'validation', 'photo_subject_id is required');
  if (!body.staged_key) throw new HttpError(400, 'validation', 'staged_key is required');
  await requireProject(body.project_id);

  const jobRows = await sql()`SELECT checkpoint FROM import_jobs
    WHERE id = ${body.job_id} AND project_id = ${body.project_id}`;
  if (!jobRows.length) throw new HttpError(404, 'not_found', 'import job not found');
  const checkpoint = (jobRows[0]['checkpoint'] ?? {}) as {
    conversions?: Record<string, string>; exif?: Record<string, Record<string, unknown>>;
  };

  const photoRows = await sql()`SELECT p.subject_id, p.mimetype, p.original_filename, p.item_id,
      p.checksum_sha256, p.r2_key
    FROM photos p JOIN subjects s ON s.id = p.subject_id
    WHERE p.subject_id = ${body.photo_subject_id} AND s.project_id = ${body.project_id}`;
  if (!photoRows.length) throw new HttpError(404, 'not_found', 'photo not found');
  const pr = photoRows[0];

  // CR-2: idempotency guard — a retried /process (client timeout, double
  // submit) must not re-run the pipeline and double-charge counters.
  // r2_key is set exactly once, inside the finalizing transaction.
  if (pr['r2_key']) {
    const photo = await getPhotoJson(body.project_id, pr['subject_id'] as string);
    const rev = await sql()`SELECT rev FROM projects WHERE id = ${body.project_id}`;
    return ok({ photo, job_id: body.job_id, rev: Number(rev[0]['rev']), deduped: true });
  }

  if ((pr['checksum_sha256'] as string) === 'pending') {
    throw new HttpError(409, 'conflict', 'photo checksum is pending — /complete verification first');
  }

  const stagedKey = body.staged_key;
  // CR-7: staged keys are server-minted under uploads/{job_id}/ — never let
  // the client promote an arbitrary R2 key (another job's staging, another
  // project's originals/) into this photo.
  const jobPrefix = `uploads/${body.job_id}/`;
  if (!stagedKey.startsWith(jobPrefix) || stagedKey.includes('..')) {
    throw new HttpError(422, 'validation', 'staged_key is not in this job staging prefix');
  }
  const artifactKey = checkpoint.conversions?.[stagedKey];
  const clientExif = checkpoint.exif?.[stagedKey];

  try {
    const result = await processPhoto({
      jobId: body.job_id,
      projectId: body.project_id,
      photoSubjectId: pr['subject_id'] as string,
      itemId: pr['item_id'] as string,
      originalFilename: pr['original_filename'] as string,
      mimetype: pr['mimetype'] as string,
      checksumSha256: pr['checksum_sha256'] as string,
      stagedKey,
      artifactKey,
      clientExif,
    });
    const photo = await getPhotoJson(body.project_id, result.photoSubjectId);
    const rev = await sql()`SELECT rev FROM projects WHERE id = ${body.project_id}`;
    return ok({ photo, job_id: body.job_id, rev: Number(rev[0]['rev']) });
  } catch (err) {
    if (err instanceof HttpError) throw err; // B5/B6/etc. carry their own status
    // F-B2: never leak sharp/libvips/DB internals to the client — log
    // server-side, return a generic message.
    console.error('import/process failed:', err);
    throw new HttpError(500, 'process_failed', 'photo processing failed');
  }
});
