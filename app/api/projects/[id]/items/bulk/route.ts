// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

type BulkOp =
  | { op: 'add_tags'; tag_ids: string[] }
  | { op: 'remove_tags'; tag_ids: string[] }
  | { op: 'move_to_list'; list_id: string | null }
  | { op: 'apply_template'; template_id: string | null }
  | { op: 'trash'; reason?: 'user' | 'auto' | 'merge' };

/**
 * Bulk item ops — ONE undo step (single transaction + single rev bump;
 * one command_log row with the whole op set).
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{ item_ids?: string[]; ops?: BulkOp[]; clientOpId?: string }>(req);
  const itemIds = [...new Set(body.item_ids ?? [])];
  const ops = body.ops ?? [];
  if (!itemIds.length) throw new HttpError(400, 'validation', 'item_ids is required');
  if (!ops.length) throw new HttpError(400, 'validation', 'ops is required');

  // Validate all ids belong to this project.
  const found = await sql()`SELECT id FROM subjects WHERE project_id = ${id} AND kind = 'item' AND id = ANY(${itemIds})`;
  const foundSet = new Set(found.map((r) => r['id'] as string));
  const missing = itemIds.filter((x) => !foundSet.has(x));
  if (missing.length) throw new HttpError(404, 'not_found', `items not found: ${missing.slice(0, 5).join(',')}`);

  if (body.clientOpId) {
    const prior = await sql()`SELECT id FROM command_log WHERE op_id = ${body.clientOpId} LIMIT 1`;
    if (prior.length) {
      const rev = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
      return ok({ replayed: true, rev: Number(rev[0]['rev']), clientOpId: body.clientOpId });
    }
  }

  const qq = (text: string, params?: unknown[]): { text: string; params?: unknown[] } => ({ text, params });
  const queries: { text: string; params?: unknown[] }[] = [];
  for (const op of ops) {
    if (op.op === 'add_tags' || op.op === 'remove_tags') {
      const tagIds = [...new Set(op.tag_ids ?? [])];
      if (tagIds.length) {
        const tags = await sql()`SELECT id FROM tags WHERE project_id = ${id} AND id = ANY(${tagIds})`;
        if (tags.length !== tagIds.length) throw new HttpError(400, 'validation', 'unknown tag id');
        for (const itemId of itemIds) {
          for (const tagId of tagIds) {
            queries.push(op.op === 'add_tags'
              ? qq(`INSERT INTO taggings (tag_id, subject_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [tagId, itemId])
              : qq(`DELETE FROM taggings WHERE tag_id = $1 AND subject_id = $2`, [tagId, itemId]));
          }
        }
      }
    } else if (op.op === 'move_to_list') {
      if (op.list_id) {
        const l = await sql()`SELECT id FROM lists WHERE id = ${op.list_id} AND project_id = ${id}`;
        if (!l.length) throw new HttpError(400, 'validation', 'list not found in this project');
      }
      for (const itemId of itemIds) {
        queries.push(qq(`DELETE FROM list_items WHERE item_id = $1`, [itemId]));
        if (op.list_id) {
          queries.push(qq(`INSERT INTO list_items (list_id, item_id, position)
            VALUES ($1,$2,(SELECT COALESCE(MAX(position)+1,0) FROM list_items WHERE list_id=$1))`, [op.list_id, itemId]));
        }
      }
    } else if (op.op === 'apply_template') {
      if (op.template_id) {
        const t = await sql()`SELECT id FROM templates WHERE id = ${op.template_id} AND project_id = ${id}`;
        if (!t.length) throw new HttpError(400, 'validation', 'template not found in this project');
      }
      for (const itemId of itemIds) {
        queries.push(qq(`UPDATE subjects SET template_id = $2, updated_at = now() WHERE id = $1`, [itemId, op.template_id]));
      }
    } else if (op.op === 'trash') {
      const reason = op.reason ?? 'user';
      if (!['user', 'auto', 'merge'].includes(reason)) throw new HttpError(400, 'validation', 'invalid trash reason');
      // trashSubject does its own txn; inline it here to keep ONE transaction.
      for (const itemId of itemIds) {
        const pl = await sql()`SELECT list_id, position FROM list_items WHERE item_id = ${itemId}`;
        queries.push(qq(`INSERT INTO trash (subject_id, reason, prior_lists) VALUES ($1,$2,$3::jsonb)
          ON CONFLICT (subject_id) DO UPDATE SET reason = EXCLUDED.reason, deleted_at = now()`,
          [itemId, reason, JSON.stringify(pl.map((r) => ({ list_id: r['list_id'], position: Number(r['position']) })))]));
        queries.push(qq(`DELETE FROM list_items WHERE item_id = $1`, [itemId]));
      }
    } else {
      throw new HttpError(400, 'validation', `unknown bulk op: ${(op as { op: string }).op}`);
    }
  }
  queries.push(bumpRevQuery(id));
  if (body.clientOpId) {
    queries.push(qq(`INSERT INTO command_log (project_id, op_id, kind, payload) VALUES ($1,$2,'items.bulk',$3::jsonb)
      ON CONFLICT (op_id) DO NOTHING`, [id, body.clientOpId, JSON.stringify({ item_ids: itemIds, ops })]));
  }
  await tx(() => queries);
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
  return ok({ updated: itemIds.length, rev: Number(rev[0]['rev']), ...(body.clientOpId ? { clientOpId: body.clientOpId } : {}) });
});
