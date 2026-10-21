// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError, isUuid } from '@/lib/api/route-utils';
import { copyItemsToProject } from '@/lib/items/copy';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/projects/[id]/items/copy — bulk deep-copy of a SET of items
 * into another project (parity row 32). Body:
 * { item_ids, target_project_id }. Each item copies independently
 * (transcriptions included); the response lists copied results and
 * per-item failures with reasons — no silent drops. The single-item
 * route (/items/[itemId]/copy) remains for one-off copies.
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{ item_ids?: unknown; target_project_id?: unknown }>(req);
  if (!isUuid(body.target_project_id)) {
    throw new HttpError(400, 'validation', 'target_project_id (uuid) is required');
  }
  if (!Array.isArray(body.item_ids) || !body.item_ids.length || body.item_ids.some((x) => !isUuid(x))) {
    throw new HttpError(400, 'validation', 'item_ids must be a non-empty array of item UUIDs');
  }
  const result = await copyItemsToProject(id, body.item_ids as string[], body.target_project_id);
  return ok(result, 201);
});
