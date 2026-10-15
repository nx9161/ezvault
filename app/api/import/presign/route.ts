// SPDX-License-Identifier: MIT
import { handle, ok, parseCappedJson, requireProject, HttpError, apiError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { getStorageDriver, keys, extForMimetype } from '@/lib/storage/driver';
import { isAllowedUploadMimetype, stagedExtension, MAX_PHOTO_BYTES } from '@/lib/import/validation';
import { isStorageBlocked, getStorageMeter } from '@/lib/api/meter';
import { requireRateLimit } from '@/lib/ratelimit';
import { idempotentCreate, readStashedResult, resolveClientOpId } from '@/lib/api/idempotency';
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

  // A4: claim-first idempotency — the client already sends clientOpId (see
  // lib/import/upload.ts) but the old code ignored it and minted a duplicate
  // job per retry. A replay returns the SAME job_id and re-mints fresh
  // presigned URLs for the SAME staged keys (the 15-min TTL means stored
  // URLs go stale — only the keys are stashed).
  const opId = resolveClientOpId(req, body);
  const jobId = randomUUID();
  const storage = await getStorageDriver();

  interface GrantSeed { key: string; sha256: string; mimetype: string; filename: string }
  async function mintGrants(seeds: GrantSeed[]) {
    const grants = [];
    for (const f of seeds) {
      const url = await storage.presignPut(f.key, f.mimetype, 15 * 60);
      grants.push({
        key: f.key,
        url,
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        sha256: f.sha256,
        mimetype: f.mimetype,
        filename: f.filename,
        content_type: f.mimetype,
      });
    }
    return grants;
  }

  const { result, replayed, clientOpId } = await idempotentCreate({
    projectId: body.project_id,
    opId,
    kind: 'import.presign',
    payload: { files: files.length },
    create: async () => {
      await sql()`INSERT INTO import_jobs (id, project_id, kind, status, total, checkpoint)
        VALUES (${jobId}, ${body.project_id}, 'upload', 'queued', ${files.length},
          ${JSON.stringify({ presigned_at: new Date().toISOString() })}::jsonb)`;
      const seeds: GrantSeed[] = files.map((f) => ({
        key: keys.upload(jobId, randomUUID(), stagedExtension(f.mimetype!)),
        sha256: f.sha256!.toLowerCase(),
        mimetype: f.mimetype!.toLowerCase(),
        filename: f.filename!,
      }));
      void extForMimetype;
      const grants = await mintGrants(seeds);
      return { job_id: jobId, grants, seeds };
    },
    findPrior: async () => {
      const stashed = await readStashedResult<{ job_id: string; seeds: GrantSeed[] }>(opId!);
      if (!stashed?.job_id || !stashed?.seeds) return null;
      const grants = await mintGrants(stashed.seeds);
      return { job_id: stashed.job_id, grants, seeds: stashed.seeds };
    },
    // Stash the seeds (keys), not the URLs — replays re-mint fresh URLs.
    toStash: (r) => ({ job_id: r.job_id, seeds: r.seeds }),
  });
  if (replayed) {
    if (!result) {
      // First attempt died after claiming but before finishing: the client
      // must retry with a FRESH op id (wire-format rule 5).
      return ok({ job_id: null, grants: [], replayed: true, clientOpId,
        note: 'first attempt did not complete; retry with a fresh clientOpId' });
    }
    return ok({ job_id: result.job_id, grants: result.grants, replayed: true, clientOpId });
  }
  return ok({ job_id: result!.job_id, grants: result!.grants, ...(clientOpId ? { clientOpId } : {}) }, 201);
});
