// SPDX-License-Identifier: MIT
import { handle, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { getStorageDriver, keys } from '@/lib/storage/driver';
import { requireRateLimit } from '@/lib/ratelimit';
import { requirePluginEnabled } from '@/lib/plugins/server';

import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/[id]/export/jsonld — Tropy-compatible envelope via the
 * shared lib/export/jsonld.js module (also used by the backup workflow).
 * ?format=html|markdown selects note rendering; ?itemId= exports one item.
 * Written to exports/ staging (7-day lifecycle), 302'd back. B16-rated.
 */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const project = await requireProject(id);
  await requirePluginEnabled(id, 'jsonld-export');
  await requireRateLimit('export:jsonld');

  const url = new URL(req.url);
  const format = url.searchParams.get('format') === 'markdown' ? 'markdown' : 'html';
  const itemId = url.searchParams.get('itemId') ?? undefined;
  if (itemId) {
    const chk = await sql()`SELECT id FROM subjects WHERE id = ${itemId} AND project_id = ${id} AND kind = 'item'`;
    if (!chk.length) throw new HttpError(404, 'not_found', 'item not found');
  }

  const { buildProjectJsonLd } = await import('@/lib/export/jsonld.js');
  const projectName = String((project as Record<string, unknown>)['name'] ?? 'project');
  const doc = await buildProjectJsonLd(sql(), project, { format, itemId });
  const body = JSON.stringify(doc, null, 2);

  const jobId = randomUUID();
  const filename = `${itemId ? 'item' : projectName.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()}-${jobId.slice(0, 8)}.json`;
  const exportKey = keys.exportFile(jobId, filename);
  const storage = await getStorageDriver();
  await storage.putBytes(exportKey, Buffer.from(body, 'utf8'), { contentType: 'application/ld+json' });

  const dl = await storage.presignGet(exportKey, {
    disposition: 'attachment',
    contentType: 'application/ld+json',
    filename,
  });
  return new Response(null, {
    status: 302,
    headers: { Location: dl, 'Cache-Control': 'private, max-age=240' },
  });
});
