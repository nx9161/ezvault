// SPDX-License-Identifier: MIT
import { handle, ok, requireProject, HttpError } from '@/lib/api/route-utils';
import { pushProjectToOmeka } from '@/lib/omeka/service';
import { OmekaError } from '@/lib/omeka/client';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/projects/[id]/omeka/push-project — push every non-trashed
 * item in the project. Runs the import_jobs pattern (kind 'omeka'): the
 * response and the job report carry per-item results; a failed item
 * never aborts the batch and never reports as pushed.
 */
export const POST = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  try {
    const result = await pushProjectToOmeka(id);
    return ok(result);
  } catch (err) {
    if (err instanceof OmekaError) {
      const status = err.status >= 400 && err.status < 600 ? err.status : 502;
      throw new HttpError(status, 'omeka_error', err.message, err.body || undefined);
    }
    throw err;
  }
});
