// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; listId: string }> };

async function checkList(projectId: string, listId: string) {
  const rows = await sql()`SELECT id FROM lists WHERE id = ${listId} AND project_id = ${projectId}`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'list not found');
}

/** File an item into the list (position appended by default). */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id, listId } = await ctx.params;
  await requireProject(id);
  await checkList(id, listId);
  const body = await parseJson<{ item_id?: string; position?: number }>(req);
  if (!body.item_id) throw new HttpError(400, 'validation', 'item_id is required');
  const item = await sql()`SELECT id FROM subjects WHERE id = ${body.item_id} AND project_id = ${id} AND kind = 'item'`;
  if (!item.length) throw new HttpError(404, 'not_found', 'item not found');
  const qq = (text: string, params?: unknown[]) => ({ text, params });
  await tx(() => [
    qq(`INSERT INTO list_items (list_id, item_id, position)
        VALUES ($1,$2,COALESCE($3,(SELECT COALESCE(MAX(position)+1,0) FROM list_items WHERE list_id=$1)))
        ON CONFLICT (list_id, item_id) DO UPDATE SET position = EXCLUDED.position`,
      [listId, body.item_id, body.position ?? null]),
    bumpRevQuery(id),
  ]);
  return ok({ filed: body.item_id, list_id: listId });
});

/** Unfile an item (body: item_id) or clear the list (body: {all: true}). */
export const DELETE = handle(async (req: Request, ctx: Ctx) => {
  const { id, listId } = await ctx.params;
  await requireProject(id);
  await checkList(id, listId);
  const body = await parseJson<{ item_id?: string; all?: boolean }>(req);
  const qq = (text: string, params?: unknown[]) => ({ text, params });
  if (body.all) {
    await tx(() => [
      qq(`DELETE FROM list_items WHERE list_id = $1`, [listId]),
      bumpRevQuery(id),
    ]);
    return ok({ unfiled: 'all', list_id: listId });
  }
  if (!body.item_id) throw new HttpError(400, 'validation', 'item_id is required (or all: true)');
  await tx(() => [
    qq(`DELETE FROM list_items WHERE list_id = $1 AND item_id = $2`, [listId, body.item_id]),
    bumpRevQuery(id),
  ]);
  return ok({ unfiled: body.item_id, list_id: listId });
});
