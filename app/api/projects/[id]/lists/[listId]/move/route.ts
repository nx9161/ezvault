// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; listId: string }> };

/**
 * Re-nest a list under a new parent. The DB cycle-guard trigger
 * (forbid_list_cycle) rejects moves that would create a cycle.
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id, listId } = await ctx.params;
  await requireProject(id);
  const chk = await sql()`SELECT id FROM lists WHERE id = ${listId} AND project_id = ${id}`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'list not found');
  const body = await parseJson<{ parent_list_id?: string | null; position?: number }>(req);
  const parentId = body.parent_list_id ?? null;
  if (parentId) {
    const p = await sql()`SELECT id FROM lists WHERE id = ${parentId} AND project_id = ${id}`;
    if (!p.length) throw new HttpError(400, 'validation', 'parent list not found in this project');
    if (parentId === listId) throw new HttpError(400, 'validation', 'a list cannot be its own parent');
  }
  const qq = (text: string, params?: unknown[]) => ({ text, params });
  try {
    await tx(() => {
      const queries = [
        qq(`UPDATE lists SET parent_list_id = $2${body.position !== undefined ? ', position = $3' : ''} WHERE id = $1`,
          body.position !== undefined ? [listId, parentId, body.position] : [listId, parentId]),
        bumpRevQuery(id),
      ];
      return queries;
    });
  } catch (err) {
    if (String(err).includes('list cycle rejected')) {
      throw new HttpError(400, 'validation', 'move rejected: it would create a list cycle');
    }
    throw err;
  }
  const rows = await sql()`SELECT * FROM lists WHERE id = ${listId}`;
  return ok(rows[0]);
});
