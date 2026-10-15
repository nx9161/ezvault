// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; tagId: string }> };

/** Rename (global) / recolor. */
export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const { id, tagId } = await ctx.params;
  await requireProject(id);
  const chk = await sql()`SELECT id FROM tags WHERE id = ${tagId} AND project_id = ${id}`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'tag not found');
  const body = await parseJson<{ name?: string; color?: string }>(req);
  const sets: string[] = [];
  const params: unknown[] = [tagId];
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) throw new HttpError(400, 'validation', 'name must not be empty');
    params.push(name.slice(0, 200));
    sets.push(`name = $${params.length}`);
  }
  if (body.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(body.color)) throw new HttpError(400, 'validation', 'color must be #rrggbb');
    params.push(body.color);
    sets.push(`color = $${params.length}`);
  }
  if (!sets.length) throw new HttpError(400, 'validation', 'nothing to update');
  const qq = (text: string, p?: unknown[]) => ({ text, params: p });
  try {
    await tx(() => [
      qq(`UPDATE tags SET ${sets.join(', ')} WHERE id = $1`, params),
      bumpRevQuery(id),
    ]);
  } catch (err) {
    if (String(err).includes('duplicate key')) throw new HttpError(409, 'conflict', 'tag name already exists (case-insensitive)');
    throw err;
  }
  const rows = await sql()`SELECT id, project_id, name, color FROM tags WHERE id = ${tagId}`;
  return ok(rows[0]);
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const { id, tagId } = await ctx.params;
  await requireProject(id);
  const chk = await sql()`SELECT id FROM tags WHERE id = ${tagId} AND project_id = ${id}`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'tag not found');
  await tx((q) => [
    q(`DELETE FROM tags WHERE id = $1`, [tagId]),
    bumpRevQuery(id),
  ]);
  return ok({ deleted: tagId });
});
