// SPDX-License-Identifier: MIT
import { handle, ok, parseCappedJson, requireProject, HttpError, apiError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { getStorageDriver, keys } from '@/lib/storage/driver';
import { isAllowedUploadMimetype, stagedExtension, MAX_PHOTO_BYTES } from '@/lib/import/validation';
import { isStorageBlocked, getStorageMeter } from '@/lib/api/meter';
import { requireRateLimit } from '@/lib/ratelimit';
import { idempotentCreate, readStashedResult, resolveClientOpId } from '@/lib/api/idempotency';
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

  // List inserts commit in their own txn (name-deduped, safe to re-run);
  // the job row is created INSIDE the idempotency gate below.
  queries.push(bumpRevQuery(body.project_id));
  await tx(() => queries);

  // A4: claim-first idempotency — the old code parsed clientOpId but ignored
  // it, minting a duplicate job + grants per retry. A replay returns the SAME
  // job_id with freshly minted URLs for the SAME staged keys.
  const opId = resolveClientOpId(req, body);
  const storage = await getStorageDriver();
  const mapping = Object.fromEntries([...listCache.entries()].map(([k, v]) => [k, { list_id: v }]));
  interface FolderSeed { path: string; key: string; mimetype: string; sha256: string; list_id: string | null }
  async function mintFolderGrants(seeds: FolderSeed[]) {
    const grants = [];
    for (const s of seeds) {
      const url = await storage.presignPut(s.key, s.mimetype, 15 * 60);
      grants.push({
        path: s.path, key: s.key, url,
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        content_type: s.mimetype, sha256: s.sha256, list_id: s.list_id,
      });
    }
    return grants;
  }
  const jobId = randomUUID();
  const { result, replayed, clientOpId } = await idempotentCreate({
    projectId: body.project_id,
    opId,
    kind: 'import.folder-session',
    payload: { files: files.length },
    create: async () => {
      await sql()`INSERT INTO import_jobs (id, project_id, kind, status, total, checkpoint)
        VALUES (${jobId}, ${body.project_id}, 'folder', 'queued', ${files.length},
          ${JSON.stringify({ dir_lists: Object.fromEntries(listCache) })}::jsonb)`;
      const seeds: FolderSeed[] = files.map((f) => {
        const p = norm(f.path!);
        const mimetype = f.mimetype!.toLowerCase();
        const dirParts = p.split('/').slice(0, -1);
        return {
          path: p,
          key: keys.upload(jobId, randomUUID(), stagedExtension(mimetype)),
          mimetype,
          sha256: f.sha256!.toLowerCase(),
          list_id: dirParts.length ? (listCache.get(dirParts.join('/')) ?? null) : null,
        };
      });
      const grants = await mintFolderGrants(seeds);
      return { job_id: jobId, mapping, grants, seeds };
    },
    findPrior: async () => {
      const stashed = await readStashedResult<{ job_id: string; mapping: unknown; seeds: FolderSeed[] }>(opId!);
      if (!stashed?.job_id || !stashed?.seeds) return null;
      const grants = await mintFolderGrants(stashed.seeds);
      return { job_id: stashed.job_id, mapping: stashed.mapping, grants, seeds: stashed.seeds };
    },
    toStash: (r) => ({ job_id: r.job_id, mapping: r.mapping, seeds: r.seeds }),
  });
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${body.project_id}`;
  if (replayed) {
    if (!result) {
      return ok({ job_id: null, mapping: {}, grants: [], replayed: true, clientOpId,
        rev: Number(rev[0]['rev']),
        note: 'first attempt did not complete; retry with a fresh clientOpId' });
    }
    return ok({ job_id: result.job_id, mapping: result.mapping, grants: result.grants,
      rev: Number(rev[0]['rev']), replayed: true, clientOpId });
  }
  return ok({
    job_id: result!.job_id,
    mapping: result!.mapping,
    grants: result!.grants,
    rev: Number(rev[0]['rev']),
    ...(clientOpId ? { clientOpId } : {}),
  }, 201);
});
