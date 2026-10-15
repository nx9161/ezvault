// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { trashSubject } from '@/lib/api/shapes';
import type { TrashReason } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; subjectId: string }> };

/** Trash any subject with an explicit reason (user/auto/merge). */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id, subjectId } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{ reason?: TrashReason }>(req);
  const reason = body.reason ?? 'user';
  if (!['user', 'auto', 'merge'].includes(reason)) {
    throw new HttpError(400, 'validation', 'reason must be user|auto|merge');
  }
  await trashSubject(id, subjectId, reason);
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
  return ok({ trashed: subjectId, reason, rev: Number(rev[0]['rev']) });
});
