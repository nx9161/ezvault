// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError, isUuid } from '@/lib/api/route-utils';
import { undoMerge } from '@/lib/items/merge';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/projects/[id]/items/merge/undo — reverse a merge (row 32).
 * Body: { clientOpId } — the op id the merge ran under. Applies the
 * inverse stored in command_log: photos/notes move back, added tags /
 * lists / metadata fills are removed, sources leave trash and re-file to
 * their prior lists. Idempotent: undoing an undone merge is a no-op.
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{ clientOpId?: unknown }>(req);
  if (!isUuid(body.clientOpId)) throw new HttpError(400, 'validation', 'clientOpId (uuid) is required');
  const result = await undoMerge(id, body.clientOpId);
  return ok(result);
});
