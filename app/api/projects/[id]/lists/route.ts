// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { idempotentCreate, readStashedResult, resolveClientOpId } from '@/lib/api/idempotency';
import { randomUUID } from 'node:crypto';
import type { ListNode } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** Build the list tree for a project (single query + in-memory nesting). */
export async function listTree(projectId: string): Promise<ListNode[]> {
  const rows = await sql()`SELECT l.id, l.name, l.parent_list_id, l.position, l.color,
      (SELECT COUNT(*)::int FROM list_items li WHERE li.list_id = l.id) AS item_count
    FROM lists l WHERE l.project_id = ${projectId} ORDER BY l.position, l.name`;
  const byId = new Map<string, ListNode>();
  const roots: ListNode[] = [];
  for (const r of rows) {
    byId.set(r['id'] as string, {
      id: r['id'] as string, project_id: projectId, name: r['name'] as string,
      parent_list_id: r['parent_list_id'] as string | null,
      position: Number(r['position']), color: r['color'] as string | null,
      children: [], item_count: Number(r['item_count']),
    });
  }
  for (const node of byId.values()) {
    if (node.parent_list_id && byId.has(node.parent_list_id)) {
      byId.get(node.parent_list_id)!.children!.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  return ok({ lists: await listTree(id) });
});

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{
    name?: string; parent_list_id?: string | null; position?: number; color?: string | null; clientOpId?: string;
  }>(req);
  const name = (body.name ?? '').trim();
  if (!name) throw new HttpError(400, 'validation', 'name is required');
  if (body.parent_list_id) {
    const p = await sql()`SELECT id FROM lists WHERE id = ${body.parent_list_id} AND project_id = ${id}`;
    if (!p.length) throw new HttpError(400, 'validation', 'parent list not found in this project');
  }
  if (body.color !== undefined && body.color !== null && !/^#[0-9a-fA-F]{6}$/.test(body.color)) {
    throw new HttpError(400, 'validation', 'color must be #rrggbb');
  }
  // A4: claim-first idempotency — a retried request returns the original
  // list instead of minting a duplicate.
  const opId = resolveClientOpId(req, body);
  const listId = randomUUID();
  const qq = (text: string, params?: unknown[]) => ({ text, params });
  const { result, replayed, clientOpId } = await idempotentCreate<{
    list_id: string; row?: Record<string, unknown> | null;
  }>({
    projectId: id,
    opId,
    kind: 'list.create',
    payload: { name: name.slice(0, 200) },
    create: async () => {
      await tx(() => [
        qq(`INSERT INTO lists (id, project_id, name, parent_list_id, position, color)
            VALUES ($1,$2,$3,$4,$5,$6)`,
          [listId, id, name.slice(0, 200), body.parent_list_id ?? null, body.position ?? 0, body.color ?? null]),
        bumpRevQuery(id),
      ]);
      return { list_id: listId };
    },
    findPrior: async () => {
      const stashed = await readStashedResult<{ list_id: string }>(opId!);
      if (!stashed?.list_id) return null;
      const rows = await sql()`SELECT * FROM lists WHERE id = ${stashed.list_id} AND project_id = ${id}`;
      return rows.length ? { list_id: stashed.list_id, row: rows[0] } : null;
    },
  });
  if (replayed) {
    return ok({ ...(result?.row ?? {}), replayed: true, clientOpId });
  }
  const rows = await sql()`SELECT * FROM lists WHERE id = ${listId}`;
  return ok({ ...rows[0], ...(clientOpId ? { clientOpId } : {}) }, 201);
});
