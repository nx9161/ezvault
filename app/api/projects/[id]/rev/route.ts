// SPDX-License-Identifier: MIT
import { handle, ok, requireProject } from '@/lib/api/route-utils';
import { getRev } from '@/lib/db/index';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** Cheap cross-tab staleness check (single-row read). */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  return ok({ project_id: id, rev: await getRev(id) });
});
