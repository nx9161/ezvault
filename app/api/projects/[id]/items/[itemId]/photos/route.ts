// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, pagination, nextCursor, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { createPhotoRows, type PhotoEntry } from '@/lib/import/photos';
import { getPhotoJson, getPhotoJsonBatch } from '@/lib/api/shapes';
import { idempotentCreate, readStashedResult, resolveClientOpId } from '@/lib/api/idempotency';
import { isAllowedUploadMimetype } from '@/lib/import/validation';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; itemId: string }> };

export const GET = handle(async (req: Request, ctx: Ctx) => {
  // Wave D (row 36): developer API tokens honored on this route ('read').
  const { enforceTokenScope } = await import('@/lib/token-auth');
  await enforceTokenScope(req, 'read');
  const { id, itemId } = await ctx.params;
  await requireProject(id);
  const chk = await sql()`SELECT id FROM subjects WHERE id = ${itemId} AND project_id = ${id} AND kind = 'item'`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'item not found');
  const url = new URL(req.url);
  const { limit, offset } = pagination(url);
  const rows = await sql()`SELECT subject_id FROM photos WHERE item_id = ${itemId} ORDER BY position LIMIT ${limit} OFFSET ${offset}`;
  const total = await sql()`SELECT COUNT(*)::int AS c FROM photos WHERE item_id = ${itemId}`;
  // A2: one batched load instead of N sequential getPhotoJson() queries.
  const photos = await getPhotoJsonBatch(id, rows.map((r) => r['subject_id'] as string));
  return ok({
    items: photos,
    total: (total[0]['c'] as number),
    ...(nextCursor(offset, limit, rows.length) ? { nextCursor: nextCursor(offset, limit, rows.length) } : {}),
  });
});

/**
 * Register a photo after its upload completed (subjects+photos+images rows,
 * dual-checksum dedupe). The bytes must already be staged; call
 * /api/import/process next to finalize.
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id, itemId } = await ctx.params;
  await requireProject(id);
  const chk = await sql()`SELECT id FROM subjects WHERE id = ${itemId} AND project_id = ${id} AND kind = 'item'`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'item not found');
  const body = await parseJson<{
    original_filename?: string; mimetype?: string; checksum_sha256?: string;
    tpy_checksum_md5?: string | null; size_bytes?: number; width?: number; height?: number;
    exif?: Record<string, unknown>; page?: number; density?: number | null;
    position?: number; template_id?: string | null; duplicate_policy?: 'skip' | 'keep_both' | 'ask';
    clientOpId?: string;
  }>(req);

  if (!body.original_filename?.trim()) throw new HttpError(400, 'validation', 'original_filename is required');
  if (!body.mimetype || !isAllowedUploadMimetype(body.mimetype)) {
    throw new HttpError(400, 'validation', 'mimetype is required and must be on the v1 allowlist');
  }
  if (!body.checksum_sha256 || !/^[0-9a-f]{64}$/i.test(body.checksum_sha256)) {
    throw new HttpError(400, 'validation', 'checksum_sha256 is required (64 hex chars)');
  }

  const entry: PhotoEntry = {
    originalFilename: body.original_filename,
    mimetype: body.mimetype,
    checksumSha256: body.checksum_sha256.toLowerCase(),
    tpyChecksumMd5: body.tpy_checksum_md5 ?? null,
    sizeBytes: body.size_bytes ?? 0,
    width: body.width ?? 0,
    height: body.height ?? 0,
    exif: body.exif,
    page: body.page ?? 0,
    density: body.density ?? null,
    position: body.position,
    templateId: body.template_id ?? null,
  };
  // A4: claim-first idempotency — the old code parsed clientOpId but ignored
  // it, so a retried register created a duplicate photo row. A replay
  // returns the original photo (createPhotoRows' checksum dedupe is the
  // second line of defense).
  const opId = resolveClientOpId(req, body);
  const { randomUUID } = await import('node:crypto');
  const jobId = randomUUID();
  const { result, replayed, clientOpId } = await idempotentCreate({
    projectId: id,
    opId,
    kind: 'photo.register',
    payload: { item_id: itemId, sha256: entry.checksumSha256.slice(0, 16) },
    create: async () => {
      await sql()`INSERT INTO import_jobs (id, project_id, kind, status, total)
        VALUES (${jobId}, ${id}, 'upload', 'running', 1)`;
      const [created] = await createPhotoRows(id, jobId, [entry], {
        itemId,
        duplicatePolicy: body.duplicate_policy ?? 'skip',
      });
      const photo = await getPhotoJson(id, created.subjectId);
      return { photo, dedupe: created.dedupe, job_id: jobId, subject_id: created.subjectId };
    },
    findPrior: async () => {
      const stashed = await readStashedResult<{ subject_id: string; job_id: string; dedupe: string }>(opId!);
      if (!stashed?.subject_id) return null;
      const photo = await getPhotoJson(id, stashed.subject_id).catch(() => null);
      return photo ? { photo, dedupe: stashed.dedupe, job_id: stashed.job_id, subject_id: stashed.subject_id } : null;
    },
    toStash: (r) => ({ subject_id: r.subject_id, job_id: r.job_id, dedupe: r.dedupe }),
  });
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
  if (replayed) {
    if (!result) {
      return ok({ photo: null, replayed: true, clientOpId, rev: Number(rev[0]['rev']),
        note: 'first attempt did not complete; retry with a fresh clientOpId' });
    }
    return ok({ photo: result.photo, dedupe: result.dedupe, job_id: result.job_id,
      replayed: true, clientOpId, rev: Number(rev[0]['rev']) });
  }
  return ok({ photo: result!.photo, dedupe: result!.dedupe, job_id: jobId,
    rev: Number(rev[0]['rev']), ...(clientOpId ? { clientOpId } : {}) }, 201);
});
