// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, pagination, nextCursor, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { createPhotoRows, type PhotoEntry } from '@/lib/import/photos';
import { getPhotoJson } from '@/lib/api/shapes';
import { isAllowedUploadMimetype } from '@/lib/import/validation';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; itemId: string }> };

export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id, itemId } = await ctx.params;
  await requireProject(id);
  const chk = await sql()`SELECT id FROM subjects WHERE id = ${itemId} AND project_id = ${id} AND kind = 'item'`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'item not found');
  const url = new URL(req.url);
  const { limit, offset } = pagination(url);
  const rows = await sql()`SELECT subject_id FROM photos WHERE item_id = ${itemId} ORDER BY position LIMIT ${limit} OFFSET ${offset}`;
  const total = await sql()`SELECT COUNT(*)::int AS c FROM photos WHERE item_id = ${itemId}`;
  const photos = [];
  for (const r of rows) photos.push(await getPhotoJson(id, r['subject_id'] as string));
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
  const { randomUUID } = await import('node:crypto');
  const jobId = randomUUID();
  await sql()`INSERT INTO import_jobs (id, project_id, kind, status, total)
    VALUES (${jobId}, ${id}, 'upload', 'running', 1)`;
  const [created] = await createPhotoRows(id, jobId, [entry], {
    itemId,
    duplicatePolicy: body.duplicate_policy ?? 'skip',
  });
  const photo = await getPhotoJson(id, created.subjectId);
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
  return ok({ photo, dedupe: created.dedupe, job_id: jobId, rev: Number(rev[0]['rev']) }, 201);
});
