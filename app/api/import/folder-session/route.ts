// SPDX-License-Identifier: MIT
import { handle, ok, parseCappedJson, requireProject, HttpError, apiError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { getStorageDriver, keys } from '@/lib/storage/driver';
import { isAllowedUploadMimetype, stagedExtension, MAX_PHOTO_BYTES } from '@/lib/import/validation';
import { isStorageBlocked, getStorageMeter } from '@/lib/api/meter';
import { requireRateLimit } from '@/lib/ratelimit';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/import/folder-session — mirror a dropped folder tree into
 * nested lists, then return per-file presign grants keyed by the client's
 * relative path (plus the list each file's photo files into).
 *
 * Body: { project_id, files: [{ path, mimetype, size, sha256 }] }
 * Paths are relative ("a/b/photo.jpg"); backslashes normalized.
 */
export const POST = handle(async (req: Request) => {
  await requireRateLimit('import:folder-session');
  const body = await parseCappedJson<{
    project_id?: string;
    files?: { path?: string; mimetype?: string; size?: number; sha256?: string }[];
    clientOpId?: string;
  }>(req);
  if (!body.project_id) throw new HttpError(400, 'validation', 'project_id is required');
  await requireProject(body.project_id);
  const files = body.files ?? [];
  if (!files.length) throw new HttpError(400, 'validation', 'files[] is required');
  if (files.length > 5000) throw new HttpError(400, 'validation', 'at most 5000 files per folder session');

  const norm = (p: string) => String(p).replace(/\\/g, '/').replace(/^\/+/, '');
  const seen = new Set<string>();
  for (const [i, f] of files.entries()) {
    const p = norm(f.path ?? '');
    if (!p || p.includes('..') || p.length > 1000) throw new HttpError(400, 'validation', `files[${i}].path is invalid`);
    if (seen.has(p)) throw new HttpError(400, 'validation', `duplicate path: ${p}`);
    seen.add(p);
    if (!f.mimetype || !isAllowedUploadMimetype(f.mimetype)) {
      throw new HttpError(400, 'validation', `files[${i}].mimetype not on the v1 allowlist`);
    }
    if (!f.size || f.size <= 0) throw new HttpError(400, 'validation', `files[${i}].size must be positive`);
    if (f.size > MAX_PHOTO_BYTES) return apiError('too_large', `files[${i}] exceeds the ${MAX_PHOTO_BYTES}-byte cap`, 413);
    if (!f.sha256 || !/^[0-9a-f]{64}$/i.test(f.sha256)) {
      throw new HttpError(400, 'validation', `files[${i}].sha256 must be 64 hex chars`);
    }
  }

  if (await isStorageBlocked(body.project_id)) {
    return apiError('storage_blocked', 'storage policy is block — free space before uploading', 507);
  }
  const meter = await getStorageMeter(body.project_id);
  const batchBytes = files.reduce((n, f) => n + (f.size ?? 0), 0);
  if (meter.bytes_used + batchBytes > meter.bytes_limit) {
    return apiError('storage_blocked', 'folder does not fit in the remaining storage budget', 507);
  }

  // Build nested lists for every directory part (cache by dir path).
  const listCache = new Map<string, string>();
  const qq = (text: string, params?: unknown[]) => ({ text, params });
  const queries: { text: string; params?: unknown[] }[] = [];
  const ensureDir = async (dirParts: string[]): Promise<string | null> => {
    if (!dirParts.length) return null;
    let parentId: string | null = null;
    let acc = '';
    for (const part of dirParts) {
      acc = acc ? `${acc}/${part}` : part;
      if (listCache.has(acc)) { parentId = listCache.get(acc)!; continue; }
      const existing = parentId === null
        ? await sql()`SELECT id FROM lists WHERE project_id = ${body.project_id}
            AND name = ${part.slice(0, 200)} AND parent_list_id IS NULL`
        : await sql()`SELECT id FROM lists WHERE project_id = ${body.project_id}
            AND name = ${part.slice(0, 200)} AND parent_list_id = ${parentId}`;
      if (existing.length) {
        parentId = existing[0]['id'] as string;
      } else {
        const id = randomUUID();
        queries.push(qq(`INSERT INTO lists (id, project_id, name, parent_list_id, position)
          VALUES ($1,$2,$3,$4,(SELECT COALESCE(MAX(position)+1,0) FROM lists WHERE project_id=$2))`,
          [id, body.project_id, part.slice(0, 200), parentId]));
        parentId = id;
      }
      listCache.set(acc, parentId);
    }
    return parentId;
  };

  for (const f of files) {
    const parts = norm(f.path!).split('/').slice(0, -1);
    if (parts.length) await ensureDir(parts);
  }

  const jobId = randomUUID();
  queries.push(qq(`INSERT INTO import_jobs (id, project_id, kind, status, total, checkpoint)
    VALUES ($1,$2,'folder','queued',${files.length},
      ${JSON.stringify({ dir_lists: Object.fromEntries(listCache) })}::jsonb)`,
    [jobId, body.project_id]));
  queries.push(bumpRevQuery(body.project_id));
  await tx(() => queries);

  const storage = await getStorageDriver();
  const grants = [];
  for (const f of files) {
    const p = norm(f.path!);
    const mimetype = f.mimetype!.toLowerCase();
    const key = keys.upload(jobId, randomUUID(), stagedExtension(mimetype));
    const url = await storage.presignPut(key, mimetype, 15 * 60);
    const dirParts = p.split('/').slice(0, -1);
    grants.push({
      path: p,
      key,
      url,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      content_type: mimetype,
      sha256: f.sha256!.toLowerCase(),
      list_id: dirParts.length ? (listCache.get(dirParts.join('/')) ?? null) : null,
    });
  }
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${body.project_id}`;
  return ok({
    job_id: jobId,
    mapping: Object.fromEntries([...listCache.entries()].map(([k, v]) => [k, { list_id: v }])),
    grants,
    rev: Number(rev[0]['rev']),
  }, 201);
});
