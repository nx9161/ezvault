// SPDX-License-Identifier: MIT
import { handle, ok, parseCappedJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { getStorageDriver } from '@/lib/storage/driver';
import { pruneTrashPhotos } from '@/lib/api/shapes';
import { checkCpuGuard, chargeCpu } from '@/lib/cpu-budget';
import { randomUUID, createHash } from 'node:crypto';
import type { StorageCompressRequest } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

const MODES = ['compress', 'flagged-only', 'prune'] as const;
type Mode = (typeof MODES)[number];

/**
 * POST /api/projects/[id]/storage/compress — owner-picked retention
 * actions (ADR-2.8; the choice is per-run, never automatic). Body:
 *   { mode?: 'compress'|'flagged-only'|'prune', photoIds?: string[],
 *     clientOpId?: string }
 * `photo_subject_ids` is accepted as a legacy alias of `photoIds`.
 *
 * - compress: all eligible originals -> WebP q80 except keep_original=true
 *   (write->verify->swap->delete). Up to 50 photos per call.
 * - flagged-only: compress ONLY the photoIds[] the owner picked in the
 *   95% dialog (400 when photoIds[] is empty).
 * - prune: permanently delete photos already in trash (R2 object deletes +
 *   storage_counters decrement + deleted_photos audit rows, all
 *   in-transaction). Irreversible — no undo.
 *
 * Every mode is CPU-guarded (503 when the budget window is spent) and
 * CPU-charged like the rest of the expensive paths (B16 / §8). The exact
 * wire contract lives in CONTRACT.md § "Storage retention modes (F4)".
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  await checkCpuGuard();
  const { id } = await ctx.params;
  await requireProject(id);
  const body = await parseCappedJson<StorageCompressRequest>(req);
  const mode: Mode = body.mode ?? 'compress';
  if (!MODES.includes(mode)) {
    throw new HttpError(400, 'validation', "mode must be 'compress'|'flagged-only'|'prune'");
  }
  // Legacy alias: the first shipped client sent photo_subject_ids.
  const photoIds = [
    ...(body.photoIds ?? []),
    ...(body.photo_subject_ids ?? []),
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);
  const meta = body.clientOpId ? { clientOpId: body.clientOpId } : {};

  if (mode === 'prune') {
    const cpuStart = process.cpuUsage();
    const pruned = await pruneTrashPhotos(id);
    const cpuDelta = process.cpuUsage(cpuStart);
    await chargeCpu((cpuDelta.user + cpuDelta.system) / 1e6).catch(() => {});
    return ok({ mode, irreversible: true, ...pruned, ...meta });
  }

  if (mode === 'flagged-only' && !photoIds.length) {
    throw new HttpError(400, 'validation', "flagged-only requires a non-empty photoIds[]");
  }
  const wanted = [...new Set(photoIds)];

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
      const compressed = await sharp(original).rotate().webp({ quality: 80 }).toBuffer();
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
  return ok({ mode, results, processed: results.length, ...meta });
});
