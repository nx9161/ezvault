// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, pagination, nextCursor, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const url = new URL(req.url);
  const { limit, offset } = pagination(url);
  // A2: one grouped pass instead of a correlated count subquery per tag.
  // The subjects join preserves the old same-project count semantics
  // (taggings reference subjects; cross-project taggings are not counted).
  const rows = await sql()`SELECT t.id, t.name, t.color,
      COUNT(s.id)::int AS subject_count
    FROM tags t
    LEFT JOIN taggings tg ON tg.tag_id = t.id
    LEFT JOIN subjects s ON s.id = tg.subject_id AND s.project_id = ${id}
    WHERE t.project_id = ${id}
    GROUP BY t.id, t.name, t.color
    ORDER BY t.name LIMIT ${limit} OFFSET ${offset}`;
  const total = await sql()`SELECT COUNT(*)::int AS c FROM tags WHERE project_id = ${id}`;
  return ok({
    items: rows,
    total: (total[0]['c'] as number),
    ...(nextCursor(offset, limit, rows.length) ? { nextCursor: nextCursor(offset, limit, rows.length) } : {}),
  });
});

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{ name?: string; color?: string; clientOpId?: string }>(req);
  const name = (body.name ?? '').trim();
  if (!name) throw new HttpError(400, 'validation', 'name is required');
  if (body.color && !/^#[0-9a-fA-F]{6}$/.test(body.color)) {
    throw new HttpError(400, 'validation', 'color must be #rrggbb');
  }
  const tagId = randomUUID();
  const qq = (text: string, params?: unknown[]) => ({ text, params });
  try {
    await tx(() => {
      const queries = [
        qq(`INSERT INTO tags (id, project_id, name, color) VALUES ($1,$2,$3,$4)`,
          [tagId, id, name.slice(0, 200), body.color ?? '#B3541E']),
        bumpRevQuery(id),
      ];
      if (body.clientOpId) {
        queries.push(qq(`INSERT INTO command_log (project_id, op_id, kind, payload) VALUES ($1,$2,'tag.create',$3::jsonb)
          ON CONFLICT (op_id) DO NOTHING`, [id, body.clientOpId, JSON.stringify({ name })]));
      }
      return queries;
    });
  } catch (err) {
    if (String(err).includes('duplicate key')) throw new HttpError(409, 'conflict', 'tag name already exists (case-insensitive)');
    throw err;
  }
  const rows = await sql()`SELECT id, project_id, name, color FROM tags WHERE id = ${tagId}`;
  return ok({ ...rows[0], ...(body.clientOpId ? { clientOpId: body.clientOpId } : {}) }, 201);
});
