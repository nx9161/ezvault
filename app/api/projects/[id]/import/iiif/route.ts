// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { importIiifManifest } from '@/lib/iiif/import';
import { requireRateLimit } from '@/lib/ratelimit';
import { checkCpuGuard } from '@/lib/cpu-budget';
import { sql } from '@/lib/db/index';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/projects/[id]/import/iiif { manifest_url, template_id? } —
 * IIIF manifest import (row 26). The manifest and every canvas image are
 * fetched server-side under the SSRF guard (https only, no private /
 * loopback targets — lib/fetch-guard.ts); images enter the standard
 * presign→complete→process pipeline's server half (magic-byte verify,
 * staged object, processPhoto). One item per canvas, grouped in a list
 * named from the manifest label. Response carries per-canvas results.
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  await requireRateLimit('import:jsonld');
  await checkCpuGuard();
  const body = await parseJson<{ manifest_url?: string; template_id?: string | null }>(req);
  if (!body.manifest_url?.trim()) throw new HttpError(400, 'validation', 'manifest_url is required');
  const result = await importIiifManifest(id, body.manifest_url.trim(), { templateId: body.template_id ?? null });
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
  return ok({ ...result, rev: Number(rev[0]['rev']) }, 201);
});
