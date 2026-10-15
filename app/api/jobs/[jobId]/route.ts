// SPDX-License-Identifier: MIT
import 'server-only';
import { handle, ok, parseJson, HttpError } from '@/lib/api/route-utils';
import { sql, tx } from '@/lib/db/index';
import { assertJobExists, getJobState } from '@/lib/api/jobs';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ jobId: string }> };

/**
 * GET /api/jobs/[jobId] — job state for the client (rendered progress UI).
 *
 * Failure contract (for the frontend builder): when the job failed,
 * `error` (string | null) carries the human-readable reason (e.g.
 * 'idle timeout: no client progress for 24h',
 * 'presign expired: upload never completed (staged files swept after
 * 24h)', 'abandoned: no client progress for 7d; staged files swept').
 * Render it verbatim whenever non-null. The column is `error`, NOT `err`.
 */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { jobId } = await ctx.params;
  return ok(await getJobState(jobId));
});

/** Client heartbeat — merge into the job checkpoint (progress reporting). */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { jobId } = await ctx.params;
  await assertJobExists(jobId);
  const body = await parseJson<{ checkpoint?: Record<string, unknown> }>(req);
  const checkpoint = body.checkpoint ?? {};
  if (typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    throw new HttpError(400, 'validation', 'checkpoint must be an object');
  }
  const qq = (text: string, params?: unknown[]) => ({ text, params });
  await tx(() => [
    qq(`UPDATE import_jobs SET checkpoint = COALESCE(checkpoint,'{}'::jsonb) || $2::jsonb,
        updated_at = now() WHERE id = $1`, [jobId, JSON.stringify(checkpoint)]),
  ]);
  const rows = await sql()`SELECT id, status, checkpoint FROM import_jobs WHERE id = ${jobId}`;
  const j = rows[0];
  return ok({ id: j['id'], status: j['status'], checkpoint: j['checkpoint'] ?? {} });
});
