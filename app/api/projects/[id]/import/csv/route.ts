// SPDX-License-Identifier: MIT
import { handle, ok, parseCappedJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { importCsvItems } from '@/lib/import/csv-import';
import { requireRateLimit } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/projects/[id]/import/csv — CSV metadata import (row 23).
 * Body: { csv: string, template_id }. Headers are property URIs; each data
 * row becomes one NEW item under the chosen template. Runs the import-job
 * pattern (kind 'csv'); the response carries the honest per-row report.
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  await requireRateLimit('import:jsonld');
  const body = await parseCappedJson<{ csv?: unknown; template_id?: unknown }>(req);
  if (typeof body.csv !== 'string' || !body.csv.trim()) {
    throw new HttpError(400, 'validation', 'csv (file contents) is required');
  }
  if (typeof body.template_id !== 'string' || !body.template_id) {
    throw new HttpError(400, 'validation', 'template_id is required');
  }
  const result = await importCsvItems(id, body.csv, body.template_id);
  const { sql } = await import('@/lib/db/index');
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
  return ok({ ...result, rev: Number(rev[0]['rev']) }, 201);
});
