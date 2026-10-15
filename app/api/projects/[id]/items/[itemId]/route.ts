// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { trashSubject } from '@/lib/api/shapes';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; itemId: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id, itemId } = await ctx.params;
  await requireProject(id);
  const rows = await sql()`SELECT s.id AS subject_id, s.template_id, s.created_at, s.updated_at,
      i.cover_image_id,
      (SELECT COUNT(*)::int FROM photos p WHERE p.item_id = s.id) AS photo_count,
      (SELECT COUNT(*)::int FROM selections sel JOIN photos p ON p.subject_id = sel.photo_id
       WHERE p.item_id = s.id) AS selection_count,
      (SELECT COUNT(*)::int FROM notes n WHERE n.subject_id = s.id AND n.deleted_at IS NULL) AS note_count,
      (SELECT jsonb_agg(jsonb_build_object('list_id', li.list_id, 'position', li.position))
       FROM list_items li WHERE li.item_id = s.id) AS lists
    FROM subjects s JOIN items i ON i.subject_id = s.id
    WHERE s.project_id = ${id} AND s.id = ${itemId}`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'item not found');
  return ok(rows[0]);
});

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const { id, itemId } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{ template_id?: string | null; cover_image_id?: string | null; clientOpId?: string }>(req);
  const chk = await sql()`SELECT id FROM subjects WHERE id = ${itemId} AND project_id = ${id} AND kind = 'item'`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'item not found');

  if (body.template_id) {
    const t = await sql()`SELECT id FROM templates WHERE id = ${body.template_id} AND project_id = ${id}`;
    if (!t.length) throw new HttpError(400, 'validation', 'template not found in this project');
  }
  const qq = (text: string, params?: unknown[]) => ({ text, params });
  await tx(() => {
    const queries = [];
    if (body.template_id !== undefined) {
      queries.push(qq(`UPDATE subjects SET template_id = $2, updated_at = now() WHERE id = $1`, [itemId, body.template_id]));
    }
    if (body.cover_image_id !== undefined) {
      queries.push(qq(`UPDATE items SET cover_image_id = $2 WHERE subject_id = $1`, [itemId, body.cover_image_id]));
    }
    queries.push(bumpRevQuery(id));
    if (body.clientOpId) {
      queries.push(qq(`INSERT INTO command_log (project_id, op_id, kind, payload) VALUES ($1,$2,'item.update',$3::jsonb)
        ON CONFLICT (op_id) DO NOTHING`, [id, body.clientOpId, JSON.stringify(body)]));
    }
    return queries;
  });
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
  return ok({ subject_id: itemId, rev: Number(rev[0]['rev']) });
});

/** Trash an item (reason=user); photos cascade logically via the item. */
export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const { id, itemId } = await ctx.params;
  await requireProject(id);
  await trashSubject(id, itemId, 'user');
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
  return ok({ trashed: itemId, rev: Number(rev[0]['rev']) });
});
