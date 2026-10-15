// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { getStorageDriver } from '@/lib/storage/driver';
import { checkCpuGuard, chargeCpu } from '@/lib/cpu-budget';
import { randomUUID, createHash } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/projects/[id]/storage/compress — write->verify->swap->delete
 * WebP recompression of originals. `keep_original` photos are excluded.
 * Every photo is CPU-charged; the run aborts 503 when the budget window is
 * spent (B16 / §8). Body: { photo_subject_ids?: string[] }.
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  await checkCpuGuard();
  const { id } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{ photo_subject_ids?: string[] }>(req);
  const wanted = (body.photo_subject_ids ?? []).filter((s) => typeof s === 'string');

  const candidates = wanted.length
    ? await sql()`SELECT p.subject_id, p.r2_key, p.mimetype, p.original_filename
        FROM photos p JOIN subjects s ON s.id = p.subject_id
        WHERE s.project_id = ${id} AND p.keep_original = false
          AND p.missing_original = false AND p.mimetype NOT LIKE 'image/webp%'
          AND p.subject_id = ANY(${wanted})
        ORDER BY p.subject_id LIMIT 50`
    : await sql()`SELECT p.subject_id, p.r2_key, p.mimetype, p.original_filename
        FROM photos p JOIN subjects s ON s.id = p.subject_id
        WHERE s.project_id = ${id} AND p.keep_original = false
          AND p.missing_original = false AND p.mimetype NOT LIKE 'image/webp%'
        ORDER BY p.subject_id LIMIT 50`;

  const { default: sharp } = await import('sharp');
  const storage = await getStorageDriver();
  const results: { photo_subject_id: string; status: string; bytes_saved?: number }[] = [];

  for (const c of candidates) {
    const subjectId = c['subject_id'] as string;
    const oldKey = c['r2_key'] as string;
    // The new key keeps the originals/ prefix, .webp extension.
    const newKey = oldKey.replace(/(\.[a-z0-9]+)?$/i, '.webp');
    try {
      await checkCpuGuard();
      const cpuStart = process.cpuUsage();
      const original = await storage.getBytes(oldKey);
      if (!original.length) throw new Error('empty_original');
      const compressed = await sharp(original).rotate().webp({ quality: 82 }).toBuffer();
      if (!compressed.length || compressed.length >= original.length) {
        results.push({ photo_subject_id: subjectId, status: 'skipped:no_savings' });
        continue;
      }
      // Write temp -> verify size matches -> swap row -> delete old -> rename.
      const tmpKey = `${newKey}.tmp-${randomUUID()}`;
      await storage.putBytes(tmpKey, compressed, { contentType: 'image/webp' });
      const verify = await storage.head(tmpKey);
      if (!verify || verify.size !== compressed.length) {
        await storage.delete(tmpKey).catch(() => {});
        throw new Error('verify_failed');
      }
      const newHash = createHash('sha256').update(compressed).digest('hex');
      const delta = original.length - compressed.length;
      await tx((q) => [
        q(`UPDATE photos SET r2_key = $2, mimetype = 'image/webp',
             checksum_sha256 = $3, size_bytes = $4 WHERE subject_id = $1`,
          [subjectId, tmpKey, newHash, compressed.length]),
        // Lock order honored inside tx(): counters first, then jobs/photos.
        q(`UPDATE storage_counters SET bytes_originals = GREATEST(0, bytes_originals - $2),
             updated_at = now() WHERE project_id = $1`, [id, delta]),
        bumpRevQuery(id),
      ]);
      // Old bytes deleted only AFTER the row swap committed; then the temp
      // key becomes the canonical key.
      await storage.delete(oldKey).catch(() => {});
      await storage.copy(tmpKey, newKey).catch(() => {});
      await storage.delete(tmpKey).catch(() => {});
      await tx((q) => [
        q(`UPDATE photos SET r2_key = $2 WHERE subject_id = $1 AND r2_key = $3`, [subjectId, newKey, tmpKey]),
      ]);
      const cpuDelta = process.cpuUsage(cpuStart);
      await chargeCpu((cpuDelta.user + cpuDelta.system) / 1e6).catch(() => {});
      results.push({ photo_subject_id: subjectId, status: 'compressed', bytes_saved: delta });
    } catch (err) {
      if (err instanceof HttpError && err.status === 503) throw err; // CPU guard — stop the run
      results.push({
        photo_subject_id: subjectId,
        status: `failed:${err instanceof Error ? err.message : 'unknown'}`,
      });
    }
  }
  return ok({ results, processed: results.length });
});
