// SPDX-License-Identifier: MIT
import { handle, ok, parseCappedJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { analyzeTpy } from '@/lib/import/tpy';
import { requireRateLimit } from '@/lib/ratelimit';
import { checkCpuGuard } from '@/lib/cpu-budget';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/import/tpy/analyze — sql.js WASM analysis:
 * application_id must be -621960955 (hard reject); user_version pinned
 * {2112312400}, newer warns + best-effort; B9 ceilings + RSS guard;
 * writes import.jsonl ONCE; unknown tables go to unknown_rows.jsonl
 * (never dropped — surfaced as raw_import, B24).
 */
export const POST = handle(async (req: Request) => {
  await requireRateLimit('import:tpy:analyze');
  await checkCpuGuard();
  const body = await parseCappedJson<{ job_id?: string; project_id?: string; staged_key?: string }>(req);
  if (!body.job_id) throw new HttpError(400, 'validation', 'job_id is required');
  if (!body.project_id) throw new HttpError(400, 'validation', 'project_id is required');
  if (!body.staged_key) throw new HttpError(400, 'validation', 'staged_key is required');
  await requireProject(body.project_id);
  const jobRows = await sql()`SELECT id FROM import_jobs
    WHERE id = ${body.job_id} AND project_id = ${body.project_id} AND kind = 'tpy'`;
  if (!jobRows.length) throw new HttpError(404, 'not_found', 'tpy import job not found');

  const report = await analyzeTpy(body.job_id, body.staged_key);
  await sql()`UPDATE import_jobs
    SET checkpoint = COALESCE(checkpoint,'{}'::jsonb)
        || ${JSON.stringify({
          analyze: {
            user_version: report.userVersion,
            user_version_warning: report.userVersionWarning,
            counts: report.counts,
            template_uris: report.templateUris,
            unknown_tables: report.unknownTables,
            subject_total: report.subjectTotal,
          },
          conflict_log: [],
        })}::jsonb,
        total = ${report.subjectTotal},
        updated_at = now()
    WHERE id = ${body.job_id}`;
  return ok({ job_id: body.job_id, ...report });
});
