// SPDX-License-Identifier: MIT
import { handle, ok, parseCappedJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { runTpyImport, type TpyRunOptions } from '@/lib/import/tpy';
import { extractAssetsZip } from '@/lib/import/zip-extract';
import { requireRateLimit } from '@/lib/ratelimit';
import { checkCpuGuard } from '@/lib/cpu-budget';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/import/tpy/run — execute the import from import.jsonl.
 * 50 subjects per transaction; tpy_import_map idempotency (safe to resume —
 * run again with a fresh limit to continue). In standard mode with an
 * assets.zip key, the zip is extracted first (B8: streamed, 2GB/20k-entry
 * caps, path-traversal rejected). Advanced mode re-links by filename->md5.
 * When done=false, call again (checkpoint resume).
 */
export const POST = handle(async (req: Request) => {
  await requireRateLimit('import:tpy:run');
  await checkCpuGuard();
  const body = await parseCappedJson<{
    job_id?: string; project_id?: string;
    mode?: 'standard' | 'advanced';
    duplicate_policy?: 'skip' | 'keep_both' | 'ask';
    template_map?: Record<string, 'use_existing' | 'create_new'>;
    asset_keys?: Record<string, string>;
    conversions?: Record<string, string>;
    assets_zip_key?: string;
    limit?: number;
  }>(req);
  if (!body.job_id) throw new HttpError(400, 'validation', 'job_id is required');
  if (!body.project_id) throw new HttpError(400, 'validation', 'project_id is required');
  await requireProject(body.project_id);
  const jobRows = await sql()`SELECT checkpoint FROM import_jobs
    WHERE id = ${body.job_id} AND project_id = ${body.project_id} AND kind = 'tpy'`;
  if (!jobRows.length) throw new HttpError(404, 'not_found', 'tpy import job not found');
  const checkpoint = (jobRows[0]['checkpoint'] ?? {}) as { analyze?: { subject_total?: number }; conflict_log?: unknown[] };
  if (!checkpoint.analyze) {
    throw new HttpError(409, 'conflict', 'run /import/tpy/analyze first');
  }

  const mode = body.mode ?? 'standard';
  let assetKeys = body.asset_keys ?? {};
  if (mode === 'standard' && body.assets_zip_key) {
    const prefix = `tpy-staging/${body.job_id}/`;
    if (!body.assets_zip_key.startsWith(prefix) || body.assets_zip_key.includes('..')) {
      throw new HttpError(400, 'validation', 'assets_zip_key not in this job staging prefix');
    }
    // B8: streamed extraction, traversal rejected, 2GB + 20k entry caps.
    const extracted = await extractAssetsZip(body.job_id, body.assets_zip_key);
    assetKeys = { ...assetKeys, ...extracted.keys };
    await sql()`UPDATE import_jobs SET checkpoint = COALESCE(checkpoint,'{}'::jsonb)
      || ${JSON.stringify({ zip_conflicts: extracted.conflicts, zip_entries: extracted.entries })}::jsonb
      WHERE id = ${body.job_id}`;
  }

  const opts: TpyRunOptions = {
    mode,
    duplicatePolicy: body.duplicate_policy ?? 'skip',
    templateMap: body.template_map,
    assetKeys,
    conversions: body.conversions,
    limit: body.limit && body.limit > 0 ? Math.min(body.limit, 1000) : undefined,
  };
  const result = await runTpyImport(body.job_id, body.project_id, opts);

  // Persist conflicts to the job conflict log (report route reads this).
  if (result.conflicts.length) {
    await sql()`UPDATE import_jobs
      SET checkpoint = COALESCE(checkpoint,'{}'::jsonb)
          || jsonb_build_object('conflict_log',
             COALESCE(checkpoint->'conflict_log','[]'::jsonb) || ${JSON.stringify(result.conflicts)}::jsonb),
          updated_at = now()
      WHERE id = ${body.job_id}`;
  }
  if (result.done) {
    await sql()`UPDATE import_jobs SET status = 'done', updated_at = now() WHERE id = ${body.job_id}`;
  }
  // W2-D: the relink UI's missing list. The wizard reads
  // report.missing_originals — nothing produced it server-side before, so
  // the relink step never rendered. Job-scoped via tpy_import_map.
  const missingOriginals = await sql()`SELECT p.subject_id AS photo_subject_id,
      p.original_filename AS filename
    FROM photos p JOIN tpy_import_map m ON m.new_subject_id = p.subject_id
    WHERE m.job_id = ${body.job_id} AND p.missing_original = true
    ORDER BY p.original_filename`;
  return ok({
    job_id: body.job_id,
    ...result,
    missing_originals: missingOriginals.map((r) => ({
      filename: r['filename'] as string,
      photo_subject_id: r['photo_subject_id'] as string,
    })),
  });
});
