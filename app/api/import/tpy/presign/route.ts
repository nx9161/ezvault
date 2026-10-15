// SPDX-License-Identifier: MIT
import { handle, ok, parseCappedJson, requireProject, HttpError, apiError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { getStorageDriver, keys } from '@/lib/storage/driver';
import { isStorageBlocked } from '@/lib/api/meter';
import { requireRateLimit } from '@/lib/ratelimit';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

const TPY_MAX_BYTES = 100 * 1024 * 1024;

/**
 * POST /api/import/tpy/presign — presign the .tpy (and optionally assets.zip).
 * Keys: tpy-staging/{jobId}/project.tpy [+ assets.zip]. 15-min TTL.
 */
export const POST = handle(async (req: Request) => {
  await requireRateLimit('import:tpy:presign');
  const body = await parseCappedJson<{
    project_id?: string; tpy_size?: number; tpy_filename?: string; with_assets_zip?: boolean;
  }>(req);
  if (!body.project_id) throw new HttpError(400, 'validation', 'project_id is required');
  await requireProject(body.project_id);
  if (!body.tpy_size || body.tpy_size <= 0) throw new HttpError(400, 'validation', 'tpy_size is required');
  if (body.tpy_size > TPY_MAX_BYTES) {
    return apiError('too_large', 'the measured-safe .tpy ceiling is 100MB (B9)', 413);
  }
  if (await isStorageBlocked(body.project_id)) {
    return apiError('storage_blocked', 'storage policy is block — free space before importing', 507);
  }

  const jobId = randomUUID();
  await sql()`INSERT INTO import_jobs (id, project_id, kind, status, total, checkpoint)
    VALUES (${jobId}, ${body.project_id}, 'tpy', 'queued', 0, '{}'::jsonb)`;

  const storage = await getStorageDriver();
  const grants = [];
  const tpyKey = keys.tpyStaging(jobId, 'project.tpy');
  grants.push({
    kind: 'tpy' as const,
    key: tpyKey,
    filename: body.tpy_filename?.slice(0, 500) ?? 'project.tpy',
    url: await storage.presignPut(tpyKey, 'application/x-sqlite3', 15 * 60),
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    content_type: 'application/x-sqlite3',
  });
  if (body.with_assets_zip) {
    const zipKey = keys.tpyStaging(jobId, 'assets.zip');
    grants.push({
      kind: 'assets_zip' as const,
      key: zipKey,
      filename: 'assets.zip',
      url: await storage.presignPut(zipKey, 'application/zip', 15 * 60),
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      content_type: 'application/zip',
    });
  }
  return ok({ job_id: jobId, grants }, 201);
});
