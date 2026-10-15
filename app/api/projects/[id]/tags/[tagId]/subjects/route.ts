// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; tagId: string }> };

async function checkTag(projectId: string, tagId: string) {
  const chk = await sql()`SELECT id FROM tags WHERE id = ${tagId} AND project_id = ${projectId}`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'tag not found');
}

/** Attach a tag to subjects (body: subjectIds[]). */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id, tagId } = await ctx.params;
  await requireProject(id);
  await checkTag(id, tagId);
  const body = await parseJson<{ subjectIds?: string[] }>(req);
  const subjectIds = [...new Set(body.subjectIds ?? [])];
  if (!subjectIds.length) throw new HttpError(400, 'validation', 'subjectIds is required');
  const found = await sql()`SELECT id FROM subjects WHERE project_id = ${id} AND id = ANY(${subjectIds})`;
  if (found.length !== subjectIds.length) throw new HttpError(404, 'not_found', 'one or more subjects not found');
  const qq = (text: string, params?: unknown[]): { text: string; params?: unknown[] } => ({ text, params });
  await tx(() => {
    const queries = subjectIds.map((sid) =>
      qq(`INSERT INTO taggings (tag_id, subject_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [tagId, sid]));
    queries.push(bumpRevQuery(id));
    return queries;
  });
  return ok({ attached: subjectIds.length });
});

/** Detach a tag from subjects (body: subjectIds[]). */
export const DELETE = handle(async (req: Request, ctx: Ctx) => {
  const { id, tagId } = await ctx.params;
  await requireProject(id);
  await checkTag(id, tagId);
  const body = await parseJson<{ subjectIds?: string[] }>(req);
  const subjectIds = [...new Set(body.subjectIds ?? [])];
  if (!subjectIds.length) throw new HttpError(400, 'validation', 'subjectIds is required');
  await tx((q) => [
    q(`DELETE FROM taggings WHERE tag_id = $1 AND subject_id = ANY($2)`, [tagId, subjectIds]),
    bumpRevQuery(id),
  ]);
  return ok({ detached: subjectIds.length });
});
