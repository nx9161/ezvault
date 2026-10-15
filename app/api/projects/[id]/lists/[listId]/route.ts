// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; listId: string }> };

async function checkList(projectId: string, listId: string) {
  const rows = await sql()`SELECT * FROM lists WHERE id = ${listId} AND project_id = ${projectId}`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'list not found');
  return rows[0];
}

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id, listId } = await ctx.params;
  await requireProject(id);
  const list = await checkList(id, listId);
  const items = await sql()`SELECT s.id AS subject_id, li.position FROM list_items li
    JOIN subjects s ON s.id = li.item_id
    WHERE li.list_id = ${listId} AND s.project_id = ${id} ORDER BY li.position`;
  return ok({ ...list, items });
});

/** Rename + recolor (+ reposition). */
export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const { id, listId } = await ctx.params;
  await requireProject(id);
  await checkList(id, listId);
  const body = await parseJson<{ name?: string; color?: string | null; position?: number }>(req);
  const sets: string[] = [];
  const params: unknown[] = [listId];
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) throw new HttpError(400, 'validation', 'name must not be empty');
    params.push(name.slice(0, 200));
    sets.push(`name = $${params.length}`);
  }
  if (body.color !== undefined) {
    if (body.color !== null && !/^#[0-9a-fA-F]{6}$/.test(body.color)) {
      throw new HttpError(400, 'validation', 'color must be #rrggbb');
    }
    params.push(body.color);
    sets.push(`color = $${params.length}`);
  }
  if (body.position !== undefined) {
    if (!Number.isInteger(body.position) || body.position < 0) {
      throw new HttpError(400, 'validation', 'position must be a non-negative integer');
    }
    params.push(body.position);
    sets.push(`position = $${params.length}`);
  }
  if (!sets.length) throw new HttpError(400, 'validation', 'nothing to update');
  const qq = (text: string, p?: unknown[]) => ({ text, params: p });
  await tx(() => [
    qq(`UPDATE lists SET ${sets.join(', ')} WHERE id = $1`, params),
    bumpRevQuery(id),
  ]);
  return ok(await checkList(id, listId));
});

/** Delete a list (items become unfiled — list_items cascade). */
export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const { id, listId } = await ctx.params;
  await requireProject(id);
  await checkList(id, listId);
  await tx((q) => [
    q(`DELETE FROM lists WHERE id = $1`, [listId]),
    bumpRevQuery(id),
  ]);
  return ok({ deleted: listId });
});
