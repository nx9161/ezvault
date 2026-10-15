// SPDX-License-Identifier: MIT
import { handle, ok, HttpError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { getStorageDriver } from '@/lib/storage/driver';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ jobId: string }> };

/**
 * Cancel a job: stops further client orchestration and deletes any staged
 * uploads/{jobId}/ keys (originals/ objects are only touched by undo).
 */
export const POST = handle(async (_req: Request, ctx: Ctx) => {
  const { jobId } = await ctx.params;
  const rows = await sql()`SELECT id, status FROM import_jobs WHERE id = ${jobId}`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'job not found');
  if (['done', 'cancelled'].includes(rows[0]['status'] as string)) {
    return ok({ id: jobId, status: rows[0]['status'], staged_deleted: 0 });
  }
  await sql()`UPDATE import_jobs SET status = 'cancelled', updated_at = now() WHERE id = ${jobId}`;
  const storage = await getStorageDriver();
  const staged = await storage.listKeys(`uploads/${jobId}/`);
  let deleted = 0;
  for (const k of staged) {
    try { await storage.delete(k); deleted++; } catch { /* best-effort */ }
  }
  return ok({ id: jobId, status: 'cancelled', staged_deleted: deleted });
});
