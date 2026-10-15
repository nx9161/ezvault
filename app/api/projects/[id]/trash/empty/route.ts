// SPDX-License-Identifier: MIT
import { handle, ok, requireProject, HttpError } from '@/lib/api/route-utils';
import { emptyTrash } from '@/lib/api/shapes';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * Irreversible empty-trash: R2 deletes queued, counters decremented
 * in-transaction, audit rows in deleted_photos. Requires explicit
 * { confirm: true } — there is no undo.
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const body = await req.json().catch(() => ({})) as { confirm?: boolean };
  if (body.confirm !== true) {
    throw new HttpError(400, 'validation', 'emptying the trash is irreversible — send { confirm: true }');
  }
  const result = await emptyTrash(id);
  return ok({ ...result, irreversible: true });
});
