// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError, isUuid } from '@/lib/api/route-utils';
import { copyItemToProject } from '@/lib/items/copy';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; itemId: string }> };

/**
 * POST /api/projects/[id]/items/[itemId]/copy — deep-copy an item into
 * another project (parity row 32). Body: { target_project_id }.
 * New rows everywhere + photo/thumbnail objects copied to FRESH storage
 * keys under the target project — delete-independent (CONTRACT.md).
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id, itemId } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{ target_project_id?: unknown }>(req);
  if (!isUuid(body.target_project_id)) {
    throw new HttpError(400, 'validation', 'target_project_id (uuid) is required');
  }
  const result = await copyItemToProject(id, itemId, body.target_project_id);
  return ok(result, 201);
});
