// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError, isUuid } from '@/lib/api/route-utils';
import { mergeItems } from '@/lib/items/merge';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/projects/[id]/items/merge — merge source items into a target
 * (parity row 32). Body: { target_id, source_ids, clientOpId? }.
 * One transaction; sources are trashed with reason `merge`; the whole
 * merge is ONE undoable command (inverse in command_log — undo via
 * POST /items/merge/undo with the same clientOpId). Rule: CONTRACT.md.
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{ target_id?: unknown; source_ids?: unknown; clientOpId?: unknown }>(req);
  if (!isUuid(body.target_id)) throw new HttpError(400, 'validation', 'target_id (uuid) is required');
  if (!Array.isArray(body.source_ids) || !body.source_ids.length || body.source_ids.some((x) => !isUuid(x))) {
    throw new HttpError(400, 'validation', 'source_ids must be a non-empty array of item UUIDs');
  }
  const clientOpId = typeof body.clientOpId === 'string' && isUuid(body.clientOpId) ? body.clientOpId : undefined;
  const result = await mergeItems(id, body.target_id, body.source_ids as string[], clientOpId);
  return ok(result);
});
