// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, pagination, nextCursor, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, queryRaw, bumpRevQuery } from '@/lib/db/index';
import { idempotentCreate, readStashedResult, resolveClientOpId } from '@/lib/api/idempotency';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

const SORTS: Record<string, string> = {
  created: 's.created_at DESC',
  created_asc: 's.created_at ASC',
};

export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const url = new URL(req.url);
  const { limit, offset } = pagination(url);
  const listId = url.searchParams.get('list');
  const tagId = url.searchParams.get('tag');
  const q = url.searchParams.get('q')?.trim() ?? '';
  const sortKey = url.searchParams.get('sort') ?? 'created';
  const sort = SORTS[sortKey] ?? SORTS['created'];

  // Dynamically-built but fully parameterized: user input only via $n params.
  const params: unknown[] = [id];
  let p = 1;
  const joins: string[] = [];
  const filters: string[] = [`s.project_id = $${p++}`, `s.kind = 'item'`];
  if (listId) {
    joins.push(`JOIN list_items li ON li.item_id = s.id AND li.list_id = $${p}`);
    params.push(listId);
    p++;
  }
  if (tagId) {
    joins.push(`JOIN taggings tg ON tg.subject_id = s.id AND tg.tag_id = $${p}`);
    params.push(tagId);
    p++;
  }
  let textJoin = '';
  if (q) {
    textJoin = `LEFT JOIN search_documents sd ON sd.subject_id = s.id`;
    filters.push(`sd.doc @@ (websearch_to_tsquery('english', $${p}) || websearch_to_tsquery('simple', $${p}))`);
    params.push(q);
    p++;
  }
  const where = filters.join(' AND ');
  const base = `FROM subjects s ${joins.join(' ')} ${textJoin} WHERE ${where}`;

  const rows = await queryRaw(
    `SELECT s.id AS subject_id, s.template_id, s.created_at, s.updated_at,
            (SELECT COUNT(*)::int FROM photos p WHERE p.item_id = s.id) AS photo_count,
            (SELECT COUNT(*)::int FROM selections sel JOIN photos p ON p.subject_id = sel.photo_id
             WHERE p.item_id = s.id) AS selection_count,
            (SELECT COUNT(*)::int FROM notes n WHERE n.subject_id = s.id AND n.deleted_at IS NULL) AS note_count
     ${base} ORDER BY ${sort} LIMIT $${p} OFFSET $${p + 1}`,
    [...params, limit, offset],
  );
  const totalRows = await queryRaw<{ c: number }>(`SELECT COUNT(*)::int AS c ${base}`, params);
  return ok({
    items: rows,
    total: totalRows[0]?.c ?? 0,
    ...(nextCursor(offset, limit, rows.length) ? { nextCursor: nextCursor(offset, limit, rows.length) } : {}),
  });
});

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{
    template_id?: string | null; list_id?: string | null; position?: number; clientOpId?: string;
  }>(req);

  if (body.template_id) {
    const t = await sql()`SELECT id FROM templates WHERE id = ${body.template_id} AND project_id = ${id}`;
    if (!t.length) throw new HttpError(400, 'validation', 'template not found in this project');
  }
  if (body.list_id) {
    const l = await sql()`SELECT id FROM lists WHERE id = ${body.list_id} AND project_id = ${id}`;
    if (!l.length) throw new HttpError(400, 'validation', 'list not found in this project');
  }
  // A4: claim-first idempotency — the claim runs BEFORE any side effect, so
  // a retried request can never create a second item (fixes the old
  // check-then-act race, and the old replay lookup that could return an
  // arbitrary subject of the project instead of the created one).
  const opId = resolveClientOpId(req, body);
  const itemId = randomUUID();
  const qq = (text: string, params?: unknown[]): { text: string; params?: unknown[] } => ({ text, params });
  const { result, replayed, clientOpId } = await idempotentCreate({
    projectId: id,
    opId,
    kind: 'item.create',
    payload: { template_id: body.template_id ?? null, list_id: body.list_id ?? null },
    create: async () => {
      await tx(() => {
        const queries = [
          qq(`INSERT INTO subjects (id, project_id, kind, template_id) VALUES ($1,$2,'item',$3)`,
            [itemId, id, body.template_id ?? null]),
          qq(`INSERT INTO items (subject_id) VALUES ($1)`, [itemId]),
        ];
        if (body.list_id) {
          queries.push(qq(`INSERT INTO list_items (list_id, item_id, position)
            VALUES ($1,$2,COALESCE($3, (SELECT COALESCE(MAX(position)+1,0) FROM list_items WHERE list_id=$1)))`,
            [body.list_id, itemId, body.position ?? null]));
        }
        queries.push(bumpRevQuery(id));
        return queries;
      });
      return { subject_id: itemId };
    },
    findPrior: async () => {
      const stashed = await readStashedResult<{ subject_id: string }>(opId!);
      return stashed?.subject_id ? { subject_id: stashed.subject_id } : null;
    },
  });
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
  if (replayed) {
    return ok({
      subject_id: result?.subject_id ?? null, replayed: true,
      rev: Number(rev[0]['rev']), clientOpId,
    });
  }
  return ok({ subject_id: itemId, rev: Number(rev[0]['rev']), ...(clientOpId ? { clientOpId } : {}) }, 201);
});
