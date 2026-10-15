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

type Ctx = { params: Promise<{ id: string; photoId: string }> };

/**
 * GET ?format=png|jpg — bake edits server-side (§6.4) and return a
 * presigned download of the baked file (exports/ staging, 7-day lifecycle).
 * CPU-charged and CPU-guard honored; rate-limited (B16).
 */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id, photoId } = await ctx.params;
  await requireProject(id);
  await requireRateLimit('export:file');
  await checkCpuGuard();
  const cpuStart = process.cpuUsage();

  const url = new URL(req.url);
  const format = url.searchParams.get('format') ?? 'png';
  if (format !== 'png' && format !== 'jpg') return apiError('validation', 'format must be png|jpg', 400);

  const photo = await getPhotoJson(id, photoId).catch(() => null);
  if (!photo) throw new HttpError(404, 'not_found', 'photo not found');
  if (!photo.r2_key || photo.missing_original) {
    throw new HttpError(404, 'not_found', 'original is missing (re-link required)');
  }

  const storage = await getStorageDriver();
  const originalBytes = await storage.getBytes(photo.r2_key);
  const baked = await bakeImage(originalBytes, { edits: photo.edits, format });

  const exportKey = keys.exportFile(randomUUID(), `${photo.original_filename.replace(/\.[^.]+$/, '')}-baked.${format === 'jpg' ? 'jpg' : 'png'}`);
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
