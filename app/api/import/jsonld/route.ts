// SPDX-License-Identifier: MIT
import { handle, ok, parseCappedJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { acceptJsonLd } from '@/lib/import/jsonld-accept';
import { requireRateLimit } from '@/lib/ratelimit';
import { checkCpuGuard } from '@/lib/cpu-budget';
import { requirePluginEnabled } from '@/lib/plugins/server';


export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/import/jsonld — accept a JSON-LD project document.
 * B10: strict documentLoader rejects ALL remote contexts (inline allowlisted
 * tropy.org context only). B11: depth-64 / 200k-key caps → 413.
 * Body: { project_id, document, ttp?, path_keys?, duplicate_policy? }.
 */
export const POST = handle(async (req: Request) => {
  await requireRateLimit('import:jsonld');
  await checkCpuGuard();
  const body = await parseCappedJson<{
    project_id?: string;
    document?: unknown;
    ttp?: { uri: string; name: string; fields: { property_uri: string; label: string }[] }[];
    path_keys?: Record<string, string>;
    duplicate_policy?: 'skip' | 'keep_both' | 'ask';
  }>(req);
  if (!body.project_id) throw new HttpError(400, 'validation', 'project_id is required');
  await requireProject(body.project_id);
  await requirePluginEnabled(body.project_id, 'jsonld-import');
  if (body.document === undefined || body.document === null || typeof body.document !== 'object') {
    throw new HttpError(400, 'validation', 'document (JSON-LD) is required');
  }
  if (body.duplicate_policy && !['skip', 'keep_both', 'ask'].includes(body.duplicate_policy)) {
    throw new HttpError(400, 'validation', 'duplicate_policy must be skip|keep_both|ask');
  }
  const result = await acceptJsonLd(body.project_id, body.document, {
    ttp: body.ttp,
    pathKeys: body.path_keys,
    duplicatePolicy: body.duplicate_policy ?? 'skip',
  });
  const { sql } = await import('@/lib/db/index');
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${body.project_id}`;
  return ok({ ...result, job_id: result.jobId, rev: Number(rev[0]['rev']) }, 201);
});
