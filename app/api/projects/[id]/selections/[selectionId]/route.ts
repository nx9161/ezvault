// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { trashSubject } from '@/lib/api/shapes';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; selectionId: string }> };

async function selectionJson(projectId: string, selectionId: string) {
  const rows = await sql()`SELECT s.id AS subject_id, s.project_id, s.template_id,
      sel.photo_id, sel.name, sel.x, sel.y, sel.width, sel.height, sel.position,
      (SELECT COUNT(*)::int FROM notes n WHERE n.subject_id = sel.subject_id AND n.deleted_at IS NULL) AS note_count
    FROM selections sel JOIN subjects s ON s.id = sel.subject_id
    WHERE s.project_id = ${projectId} AND sel.subject_id = ${selectionId}`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'selection not found');
  const r = rows[0];
  return {
    subject_id: r['subject_id'], project_id: r['project_id'], kind: 'selection',
    photo_id: r['photo_id'], name: r['name'],
    x: Number(r['x']), y: Number(r['y']), width: Number(r['width']), height: Number(r['height']),
    position: Number(r['position']), template_id: r['template_id'],
    note_count: Number(r['note_count'] ?? 0),
  };
}

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id, selectionId } = await ctx.params;
  await requireProject(id);
  return ok(await selectionJson(id, selectionId));
});

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const { id, selectionId } = await ctx.params;
  await requireProject(id);
  await selectionJson(id, selectionId); // 404 if missing
  const body = await parseJson<{
    name?: string; x?: number; y?: number; width?: number; height?: number;
    template_id?: string | null; clientOpId?: string;
  }>(req);

  for (const f of ['x', 'y', 'width', 'height'] as const) {
    const v = body[f];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      throw new HttpError(400, 'validation', `${f} must be a non-negative number`);
    }
  }
  if (body.template_id) {
    const t = await sql()`SELECT id FROM templates WHERE id = ${body.template_id} AND project_id = ${id}`;
    if (!t.length) throw new HttpError(400, 'validation', 'template not found in this project');
  }
  const qq = (text: string, params?: unknown[]) => ({ text, params });
  await tx(() => {
    const queries = [];
    const sets: string[] = [];
    const params: unknown[] = [selectionId];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (body.name !== undefined) set('name', body.name.slice(0, 200));
    if (body.x !== undefined) set('x', Math.round(body.x));
    if (body.y !== undefined) set('y', Math.round(body.y));
    if (body.width !== undefined) {
      if (body.width <= 0) throw new HttpError(400, 'validation', 'width must be positive');
      set('width', Math.round(body.width));
    }
    if (body.height !== undefined) {
      if (body.height <= 0) throw new HttpError(400, 'validation', 'height must be positive');
      set('height', Math.round(body.height));
    }
    if (sets.length) queries.push(qq(`UPDATE selections SET ${sets.join(', ')} WHERE subject_id = $1`, params));
    if (body.template_id !== undefined) {
      queries.push(qq(`UPDATE subjects SET template_id = $2, updated_at = now() WHERE id = $1`, [selectionId, body.template_id]));
    }
    queries.push(bumpRevQuery(id));
    return queries;
  });
  return ok(await selectionJson(id, selectionId));
});

/** Delete a selection (its notes cascade). */
export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const { id, selectionId } = await ctx.params;
  await requireProject(id);
  await selectionJson(id, selectionId);
  await trashSubject(id, selectionId, 'user');
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
  return ok({ deleted: selectionId, rev: Number(rev[0]['rev']) });
});
