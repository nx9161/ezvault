// SPDX-License-Identifier: MIT
import { handle, requireProject, HttpError, isUuid } from '@/lib/api/route-utils';
import { loadExportItems } from '@/lib/export/items-data';
import { buildItemsCsv } from '@/lib/export/csv-export';
import { requireRateLimit } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/[id]/export/csv — item metadata CSV (parity row 23).
 * One row per item; header = the items' template property URIs (see
 * lib/export/csv-export.ts for the exact shape). ?itemIds=a,b,c exports a
 * selection; ?itemId= one item; no param = the whole project. Trashed
 * items are excluded. All cells pass the B15 formula-injection sanitizer.
 */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const project = await requireProject(id);
  await requireRateLimit('export:jsonld');

  const url = new URL(req.url);
  let itemIds: string[] | undefined;
  const single = url.searchParams.get('itemId');
  const many = url.searchParams.get('itemIds');
  if (single) itemIds = [single];
  else if (many) itemIds = many.split(',').map((s) => s.trim()).filter(Boolean);
  if (itemIds) {
    if (!itemIds.length || itemIds.some((x) => !isUuid(x))) {
      throw new HttpError(400, 'validation', 'itemIds must be comma-separated item UUIDs');
    }
    itemIds = [...new Set(itemIds)];
  }

  const bundles = await loadExportItems(id, itemIds);
  if (itemIds && bundles.length !== itemIds.length) {
    throw new HttpError(404, 'not_found', 'one or more items not found');
  }
  const csv = buildItemsCsv(bundles.map((b) => b.csv));
  const projectName = String((project as Record<string, unknown>)['name'] ?? 'project');
  const filename = `${projectName.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()}-items.csv`;
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
});
