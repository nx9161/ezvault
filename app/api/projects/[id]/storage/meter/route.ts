// SPDX-License-Identifier: MIT
import { handle, ok, requireProject } from '@/lib/api/route-utils';
import { getStorageMeter } from '@/lib/api/meter';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/[id]/storage/meter — storage budget from transactional
 * DB counters (ADR-2.7). Policy: ok | warn | block (block at 100% of 10GB;
 * presign refuses 507 while blocked).
 */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  return ok(await getStorageMeter(id));
});
