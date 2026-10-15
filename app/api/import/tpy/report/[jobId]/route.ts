// SPDX-License-Identifier: MIT
import { handle, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { csvCell, csvRow } from '@/lib/export/csv-sanitize';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ jobId: string }> };

/**
 * GET — import report as CSV (imported-vs-expected + conflicts).
 * Every cell goes through the B15 formula sanitizer ('=,+,-,@,\t,\r
 * get a leading apostrophe) so a downloaded report can never execute
 * as a spreadsheet formula.
 */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { jobId } = await ctx.params;
  const rows = await sql()`SELECT project_id, kind, status, total, done, failed, checkpoint
    FROM import_jobs WHERE id = ${jobId}`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'job not found');
  const j = rows[0];
  if (j['kind'] !== 'tpy') throw new HttpError(400, 'validation', 'report is only available for tpy jobs');
  await requireProject(j['project_id'] as string);

  const checkpoint = (j['checkpoint'] ?? {}) as {
    analyze?: { counts?: Record<string, number>; subject_total?: number };
    conflict_log?: { tpy_id?: number | string; kind?: string; reason?: string; detail?: string }[];
  };
  const expected = checkpoint.analyze?.counts ?? {};
  const imported = await sql()`SELECT kind, COUNT(*)::int AS c FROM tpy_import_map
    WHERE job_id = ${jobId} GROUP BY kind`;

  const lines: string[] = [];
  lines.push(csvRow(['table', 'expected', 'imported']));
  const kinds = new Set([...Object.keys(expected), ...imported.map((r) => r['kind'] as string)]);
  for (const k of [...kinds].sort()) {
    lines.push(csvRow([csvCell(k), csvCell(expected[k] ?? ''), csvCell(imported.find((r) => r['kind'] === k)?.['c'] ?? '')]));
  }
  lines.push('');
  lines.push(csvRow(['tpy_id', 'kind', 'reason', 'detail']));
  for (const c of checkpoint.conflict_log ?? []) {
    lines.push(csvRow([csvCell(c.tpy_id), csvCell(c.kind), csvCell(c.reason), csvCell(c.detail)]));
  }

  const body = lines.join('\r\n');
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="tpy-import-report-${jobId}.csv"`,
      'Cache-Control': 'private, max-age=240',
    },
  });
});
