// SPDX-License-Identifier: MIT
import { handle, ok, requireProject } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const counters = await sql()`SELECT bytes_originals, bytes_thumbs, bytes_exports, updated_at
    FROM storage_counters WHERE project_id = ${id}`;
  const c = (counters[0] ?? { bytes_originals: 0, bytes_thumbs: 0, bytes_exports: 0 }) as {
    bytes_originals: number | string; bytes_thumbs: number | string; bytes_exports: number | string; updated_at?: string;
  };
  const counts = await sql()`
    SELECT
      (SELECT COUNT(*)::int FROM subjects s JOIN items i ON i.subject_id = s.id WHERE s.project_id = ${id}) AS items,
      (SELECT COUNT(*)::int FROM subjects s JOIN photos p ON p.subject_id = s.id WHERE s.project_id = ${id}) AS photos,
      (SELECT COUNT(*)::int FROM subjects s JOIN selections sel ON sel.subject_id = s.id WHERE s.project_id = ${id}) AS selections,
      (SELECT COUNT(*)::int FROM notes n JOIN subjects s ON s.id = n.subject_id WHERE s.project_id = ${id} AND n.deleted_at IS NULL) AS notes,
      (SELECT COUNT(*)::int FROM tags WHERE project_id = ${id}) AS tags,
      (SELECT COUNT(*)::int FROM lists WHERE project_id = ${id}) AS lists`;
  const k = counts[0] as Record<string, number>;
  return ok({
    project_id: id,
    item_count: k.items, photo_count: k.photos, selection_count: k.selections,
    note_count: k.notes, tag_count: k.tags, list_count: k.lists,
    bytes_originals: Number(c.bytes_originals), bytes_thumbs: Number(c.bytes_thumbs),
    bytes_exports: Number(c.bytes_exports),
  });
});
