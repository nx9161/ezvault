// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { getPhotoJson, trashSubject } from '@/lib/api/shapes';
import { isValidDensity } from '@/lib/import/density';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; photoId: string }> };

export const GET = handle(async (req: Request, ctx: Ctx) => {
  // Wave D (row 36): developer API tokens honored on this route ('read').
  const { enforceTokenScope } = await import('@/lib/token-auth');
  await enforceTokenScope(req, 'read');
  const { id, photoId } = await ctx.params;
  await requireProject(id);
  return ok(await getPhotoJson(id, photoId));
});

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const { id, photoId } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{
    template_id?: string | null; position?: number; keep_original?: boolean;
    density?: number | null; clientOpId?: string;
  }>(req);
  const chk = await sql()`SELECT subject_id FROM photos JOIN subjects s ON s.id = photos.subject_id
    WHERE photos.subject_id = ${photoId} AND s.project_id = ${id}`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'photo not found');

  if (body.template_id) {
    const t = await sql()`SELECT id FROM templates WHERE id = ${body.template_id} AND project_id = ${id}`;
    if (!t.length) throw new HttpError(400, 'validation', 'template not found in this project');
  }
  const qq = (text: string, params?: unknown[]) => ({ text, params });
  await tx(() => {
    const queries = [];
    if (body.template_id !== undefined) {
      queries.push(qq(`UPDATE subjects SET template_id = $2, updated_at = now() WHERE id = $1`, [photoId, body.template_id]));
    }
    if (body.position !== undefined) {
      if (!Number.isInteger(body.position) || body.position < 0) {
        throw new HttpError(400, 'validation', 'position must be a non-negative integer');
      }
      queries.push(qq(`UPDATE photos SET position = $2 WHERE subject_id = $1`, [photoId, body.position]));
    }
    if (body.keep_original !== undefined) {
      queries.push(qq(`UPDATE photos SET keep_original = $2 WHERE subject_id = $1`, [photoId, body.keep_original]));
    }
    if (body.density !== undefined) {
      // Wave B1 (row 7): per-photo render-density override (PPI);
      // null clears it back to the project default.
      if (body.density !== null && !isValidDensity(body.density)) {
        throw new HttpError(400, 'validation', 'density must be an integer between 36 and 1200, or null');
      }
      queries.push(qq(`UPDATE photos SET density = $2 WHERE subject_id = $1`, [photoId, body.density]));
    }
    queries.push(bumpRevQuery(id));
    if (body.clientOpId) {
      queries.push(qq(`INSERT INTO command_log (project_id, op_id, kind, payload) VALUES ($1,$2,'photo.update',$3::jsonb)
        ON CONFLICT (op_id) DO NOTHING`, [id, body.clientOpId, JSON.stringify(body)]));
    }
    return queries;
  });
  return ok(await getPhotoJson(id, photoId));
});

/** Trash a photo (reason=user); bytes are kept until trash is emptied. */
export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const { id, photoId } = await ctx.params;
  await requireProject(id);
  const chk = await sql()`SELECT subject_id FROM photos JOIN subjects s ON s.id = photos.subject_id
    WHERE photos.subject_id = ${photoId} AND s.project_id = ${id}`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'photo not found');
  await trashSubject(id, photoId, 'user');
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
  return ok({ trashed: photoId, rev: Number(rev[0]['rev']) });
});
