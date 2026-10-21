// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { pushItemToOmeka } from '@/lib/omeka/service';
import { OmekaError } from '@/lib/omeka/client';
import { sql } from '@/lib/db/index';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/projects/[id]/omeka/push { item_id } — push ONE item to the
 * configured Omeka S instance (create, or update when a sync row exists).
 * Omeka errors surface verbatim-ish (status + body excerpt); nothing is
 * reported as pushed that Omeka did not accept.
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{ item_id?: string }>(req);
  if (!body.item_id) throw new HttpError(400, 'validation', 'item_id is required');
  try {
    const result = await pushItemToOmeka(id, body.item_id);
    const rev = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
    return ok({ ...result, rev: Number(rev[0]['rev']) });
  } catch (err) {
    if (err instanceof OmekaError) {
      const status = err.status >= 400 && err.status < 600 ? err.status : 502;
      throw new HttpError(status, 'omeka_error', err.message, err.body || undefined);
    }
    throw err;
  }
});
