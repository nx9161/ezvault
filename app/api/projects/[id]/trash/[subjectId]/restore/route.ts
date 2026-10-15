// SPDX-License-Identifier: MIT
import { handle, ok, requireProject } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { restoreSubject } from '@/lib/api/shapes';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; subjectId: string }> };

/** Restore a trashed subject (items re-file to prior lists/positions). */
export const POST = handle(async (_req: Request, ctx: Ctx) => {
  const { id, subjectId } = await ctx.params;
  await requireProject(id);
  await restoreSubject(id, subjectId);
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
  return ok({ restored: subjectId, rev: Number(rev[0]['rev']) });
});
