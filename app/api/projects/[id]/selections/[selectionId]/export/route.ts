// SPDX-License-Identifier: MIT
import { handle, requireProject, HttpError, apiError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { getStorageDriver, keys } from '@/lib/storage/driver';
import { bakeImage } from '@/lib/export/bake';
import { getPhotoJson } from '@/lib/api/shapes';
import { checkCpuGuard, chargeCpu } from '@/lib/cpu-budget';
import { requireRateLimit } from '@/lib/ratelimit';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; selectionId: string }> };

/**
 * GET ?format=png|jpg — export the selection region with edits baked
 * (§6.4: .extract() first, then the fixed pipeline). CPU-charged + guarded.
 */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id, selectionId } = await ctx.params;
  await requireProject(id);
  await requireRateLimit('export:file');
  await checkCpuGuard();
  const cpuStart = process.cpuUsage();

  const url = new URL(req.url);
  const format = url.searchParams.get('format') ?? 'png';
  if (format !== 'png' && format !== 'jpg') return apiError('validation', 'format must be png|jpg', 400);

  const sel = await sql()`SELECT sel.photo_id, sel.x, sel.y, sel.width, sel.height, sel.name
    FROM selections sel JOIN subjects s ON s.id = sel.subject_id
    WHERE s.project_id = ${id} AND sel.subject_id = ${selectionId}`;
  if (!sel.length) throw new HttpError(404, 'not_found', 'selection not found');
  const photo = await getPhotoJson(id, sel[0]['photo_id'] as string).catch(() => null);
  if (!photo || !photo.r2_key || photo.missing_original) {
    throw new HttpError(404, 'not_found', 'original is missing (re-link required)');
  }

  const storage = await getStorageDriver();
  const rawBytes = await storage.getBytes(photo.r2_key);
  // Wave B1: same PDF/JP2/SVG-density rasterization as photo export.
  const { rasterizeOriginalForBake } = await import('@/lib/import/render');
  const { resolveDensity } = await import('@/lib/import/density');
  const projRows = await sql()`SELECT default_density FROM projects WHERE id = ${id}`;
  const density = resolveDensity(photo.density, projRows.length ? Number(projRows[0]['default_density']) : null);
  const originalBytes = await rasterizeOriginalForBake(rawBytes, photo.mimetype, photo.page, density);
  const baked = await bakeImage(originalBytes, {
    edits: photo.edits,
    format,
    density,
    extract: {
      x: Number(sel[0]['x']), y: Number(sel[0]['y']),
      width: Number(sel[0]['width']), height: Number(sel[0]['height']),
    },
  });

  const exportKey = keys.exportFile(randomUUID(), `selection-${selectionId}.${format === 'jpg' ? 'jpg' : 'png'}`);
  await storage.putBytes(exportKey, baked, {
    contentType: format === 'jpg' ? 'image/jpeg' : 'image/png',
  });

  const cpuDelta = process.cpuUsage(cpuStart);
  await chargeCpu((cpuDelta.user + cpuDelta.system) / 1e6).catch(() => {});

  const dl = await storage.presignGet(exportKey, {
    disposition: 'attachment',
    contentType: format === 'jpg' ? 'image/jpeg' : 'image/png',
    filename: exportKey.split('/').pop()!,
  });
  return new Response(null, {
    status: 302,
    headers: { Location: dl, 'Cache-Control': 'private, max-age=240' },
  });
});
