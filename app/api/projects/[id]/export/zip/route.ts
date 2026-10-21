// SPDX-License-Identifier: MIT
import { handle, requireProject, HttpError, isUuid } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { getStorageDriver } from '@/lib/storage/driver';
import { loadExportItems } from '@/lib/export/items-data';
import { resolveItemTitles } from '@/lib/api/item-enrichment';
import { createZipStream, storageChunks, bytesChunks, zipSegment } from '@/lib/export/zip-stream';
import type { ZipSourceFile } from '@/lib/export/zip-stream';
import { requireRateLimit } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/[id]/export/zip — user-facing archive export (row 24).
 * One ZIP, streamed to the response (never staged, never fully buffered):
 *   metadata.json   — the JSON-LD document for the exported scope
 *                     (metadata + tags + lists + notes; same builder as
 *                     the JSON-LD export route)
 *   manifest.json   — EZVault manifest: scope, per-photo checksums, and
 *                     the honest list of originals that were missing
 *   <item>/<file>   — each photo's ORIGINAL bytes, under a folder named
 *                     for the item (title + short id; collisions suffixed)
 * ?itemIds=a,b,c exports a selection; ?itemId= one item; no param = the
 * whole project. Trashed items are excluded. This is NOT the encrypted
 * monthly backup — it is the plain user archive.
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
  const scopedIds = bundles.map((b) => b.csv.id);
  const titles = await resolveItemTitles(scopedIds);
  const storage = await getStorageDriver();

  const { buildProjectJsonLd } = await import('@/lib/export/jsonld.js');
  const format = (project as Record<string, unknown>)['notes_export_format'] === 'markdown'
    ? 'markdown'
    : 'html';
  const doc = await buildProjectJsonLd(sql, project, { format, itemIds: scopedIds });
  const metadataBytes = new TextEncoder().encode(JSON.stringify(doc, null, 2));

  const files: ZipSourceFile[] = [
    { name: 'metadata.json', compress: true, chunks: bytesChunks(metadataBytes) },
  ];
  const manifestItems: Record<string, unknown>[] = [];
  const missing: { item_id: string; filename: string }[] = [];

  for (const bundle of bundles) {
    const itemId = bundle.csv.id;
    const title = titles.get(itemId);
    const folder = `${zipSegment(title && title.trim() ? title : 'Untitled')}--${itemId.slice(0, 8)}`;
    const usedNames = new Map<string, number>();
    const entries: Record<string, unknown>[] = [];
    for (const photo of bundle.photos) {
      if (photo.missing_original || !photo.r2_key) {
        missing.push({ item_id: itemId, filename: photo.original_filename });
        entries.push({ filename: photo.original_filename, missing: true });
        continue;
      }
      let name = zipSegment(photo.original_filename);
      const seen = usedNames.get(name) ?? 0;
      usedNames.set(name, seen + 1);
      if (seen > 0) {
        const dot = name.lastIndexOf('.');
        name = dot > 0 ? `${name.slice(0, dot)} (${seen + 1})${name.slice(dot)}` : `${name} (${seen + 1})`;
      }
      const key = photo.r2_key;
      const size = photo.size_bytes;
      files.push({
        name: `${folder}/${name}`,
        compress: false,
        chunks: () => storageChunks(storage, key, size),
      });
      entries.push({
        filename: photo.original_filename,
        path: `${folder}/${name}`,
        size: size,
        sha256: photo.checksum_sha256,
        mimetype: photo.mimetype,
      });
    }
    manifestItems.push({ id: itemId, title: title ?? null, photos: entries });
  }

  const manifest = {
    format: 'ezvault-archive/1',
    project: String((project as Record<string, unknown>)['name'] ?? 'project'),
    project_id: id,
    exported_at: new Date().toISOString(),
    items: manifestItems,
    missing_originals: missing,
  };
  files.push({
    name: 'manifest.json',
    compress: true,
    chunks: bytesChunks(new TextEncoder().encode(JSON.stringify(manifest, null, 2))),
  });

  const projectName = String((project as Record<string, unknown>)['name'] ?? 'project');
  const filename = `${projectName.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()}-archive.zip`;
  return new Response(createZipStream(files), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
});
