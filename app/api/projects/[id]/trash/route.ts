// SPDX-License-Identifier: MIT
import { handle, ok, pagination, nextCursor, requireProject } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** List trashed subjects (reason badge, date). */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const url = new URL(req.url);
  const { limit, offset } = pagination(url);
  const rows = await sql()`SELECT t.subject_id, t.reason, t.deleted_at, s.kind AS subject_kind,
      COALESCE(p.original_filename, sel.name, 'Item') AS label
    FROM trash t JOIN subjects s ON s.id = t.subject_id
    LEFT JOIN photos p ON p.subject_id = s.id
    LEFT JOIN selections sel ON sel.subject_id = s.id
    WHERE s.project_id = ${id}
    ORDER BY t.deleted_at DESC LIMIT ${limit} OFFSET ${offset}`;
  const total = await sql()`SELECT COUNT(*)::int AS c FROM trash t
    JOIN subjects s ON s.id = t.subject_id WHERE s.project_id = ${id}`;
  return ok({
    items: rows.map((r) => ({
      subject_id: r['subject_id'], project_id: id, subject_kind: r['subject_kind'],
      reason: r['reason'], deleted_at: r['deleted_at'], label: r['label'],
    })),
    total: (total[0]['c'] as number),
    ...(nextCursor(offset, limit, rows.length) ? { nextCursor: nextCursor(offset, limit, rows.length) } : {}),
  });
});
