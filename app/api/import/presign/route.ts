// SPDX-License-Identifier: MIT
import { handle, ok, parseCappedJson, requireProject, HttpError, apiError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { getStorageDriver, keys, extForMimetype } from '@/lib/storage/driver';
import { isAllowedUploadMimetype, stagedExtension, MAX_PHOTO_BYTES } from '@/lib/import/validation';
import { isStorageBlocked, getStorageMeter } from '@/lib/api/meter';
import { requireRateLimit } from '@/lib/ratelimit';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/import/presign — mint presigned PUTs (batch).
 * Server-chosen keys uploads/{jobId}/{uuid}.{ext}; signed Content-Type from
 * the allowlist; 15-min TTL. Size is NOT enforced here (S3 limitation) —
 * enforced at /complete via HeadObject (B4). Refuses 507 when the storage
 * policy is blocked (all-or-nothing batch check).
 */
export const POST = handle(async (req: Request) => {
  await requireRateLimit('import:presign');
  const body = await parseCappedJson<{
    project_id?: string; files?: { sha256?: string; size?: number; mimetype?: string; filename?: string }[];
    clientOpId?: string;
  }>(req);

  if (!body.project_id) throw new HttpError(400, 'validation', 'project_id is required');
  await requireProject(body.project_id);
  const files = body.files ?? [];
  if (!files.length) throw new HttpError(400, 'validation', 'files[] is required and must not be empty');
  if (files.length > 500) throw new HttpError(400, 'validation', 'at most 500 files per presign batch');

  for (const [i, f] of files.entries()) {
    if (!f.sha256 || !/^[0-9a-f]{64}$/i.test(f.sha256)) {
      throw new HttpError(400, 'validation', `files[${i}].sha256 must be 64 hex chars`);
    }
    if (!f.size || f.size <= 0) throw new HttpError(400, 'validation', `files[${i}].size must be positive`);
    if (f.size > MAX_PHOTO_BYTES) {
      return apiError('too_large', `files[${i}] exceeds the ${MAX_PHOTO_BYTES}-byte per-photo cap`, 413);
    }
    if (!f.mimetype || !isAllowedUploadMimetype(f.mimetype)) {
      throw new HttpError(400, 'validation', `files[${i}].mimetype not on the v1 allowlist`);
    }
    if (!f.filename?.trim()) throw new HttpError(400, 'validation', `files[${i}].filename is required`);
  }

  // 507 when blocked — all-or-nothing: the whole batch must fit.
  if (await isStorageBlocked(body.project_id)) {
    return apiError('storage_blocked', 'storage policy is block (100% of 10GB used) — free space before uploading', 507);
  }
  const meter = await getStorageMeter(body.project_id);
  const batchBytes = files.reduce((n, f) => n + (f.size ?? 0), 0);
  if (meter.bytes_used + batchBytes > meter.bytes_limit) {
    return apiError('storage_blocked', 'batch does not fit in the remaining storage budget', 507);
  }

  const jobId = randomUUID();
  await sql()`INSERT INTO import_jobs (id, project_id, kind, status, total, checkpoint)
    VALUES (${jobId}, ${body.project_id}, 'upload', 'queued', ${files.length},
      ${JSON.stringify({ presigned_at: new Date().toISOString() })}::jsonb)`;

  const storage = await getStorageDriver();
  const grants = [];
  for (const f of files) {
    const ext = stagedExtension(f.mimetype!);
    const key = keys.upload(jobId, randomUUID(), ext);
    const url = await storage.presignPut(key, f.mimetype!.toLowerCase(), 15 * 60);
    grants.push({
      key,
      url,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      sha256: f.sha256!.toLowerCase(),
      mimetype: f.mimetype!.toLowerCase(),
      filename: f.filename!,
      // Local-driver hint: the client PUTs bytes to `url` with a matching
      // Content-Type header (the signature pins it).
      content_type: f.mimetype!.toLowerCase(),
    });
    void extForMimetype;
  }
  return ok({ job_id: jobId, grants }, 201);
});
