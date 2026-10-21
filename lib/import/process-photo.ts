// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/import/process-photo.ts — one-photo processing pipeline (phase2 §6.1.4).
 *
 * One photo per invocation. Steps:
 *   1. CPU-guard check first (503 if paused) — uploads are never gated, but
 *      /process IS (it burns CPU).
 *   2. Head staged object; Range-GET magic probe (B1 re-verified here too).
 *   3. Decode source = browser artifact (HEIC/AVIF JPEG) when provided,
 *      else the staged original. Server decodes JPG/PNG/GIF/WEBP/TIFF/SVG.
 *   4. B5: sharp metadata dimension pre-check + limitInputPixels 50M → 422.
 *   5. B6: SVG → server-side sanitize before persisting.
 *   6. Thumb 1600px WebP q80; move original to originals/ (byte-preserved);
 *      EXIF via sharp (non-HEIC) or client-supplied (HEIC).
 *   7. ONE transaction: photo row finalize + storage_counters (FOR UPDATE,
 *      lock order counters→photos→jobs) + cpu_seconds (process.cpuUsage())
 *      + projects.rev bump.
 *
 * B18 decision (recorded truth): client sha256 is server-verified at
 * /complete via streaming full-file SHA-256 (constant memory); /process
 * re-verifies magic bytes before decode.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { getStorageDriver, keys, extForMimetype } from '../storage/driver';
import { detectFormat, magicMatchesMimetype, mimetypeForFormat } from './magic';
import { isAllowedUploadMimetype, MAX_INPUT_PIXELS, MAGIC_PROBE_BYTES } from './validation';
import { sanitizeSvg, SvgRejectedError } from './svg-sanitize';
import { countPdfPages, renderPdfPage, decodeJp2ToPng } from './render';
import { resolveDensity } from './density';
import { planPageSplit } from './pages';
import { sql, tx, bumpRevQuery, bumpCountersQuery } from '../db/index';
import { checkCpuGuard, chargeCpu } from '../cpu-budget';
import { HttpError } from '../api/route-utils';

export interface ProcessPhotoInput {
  projectId: string;
  jobId: string;
  stagedKey: string;
  /** Browser-decoded JPEG artifact (HEIC/HEIF/AVIF path) — thumb source. */
  artifactKey?: string;
  itemId?: string;
  photoSubjectId: string; // created by /complete
  originalFilename: string;
  mimetype: string;
  checksumSha256: string;
  clientExif?: Record<string, unknown>;
  /**
   * Wave B1 (row 34): split multi-page PDF/TIFF into one photo per page.
   * The ImportDialog sends this via /complete → job checkpoint; the process
   * route forwards it. Default (undefined) = split, matching the dialog's
   * default (checkbox unchecked = split).
   */
  splitPages?: boolean;
  /** Wave B1 (row 34): keep a split file's pages under ONE item. */
  groupIntoItem?: boolean;
}

/** Stream-verify SHA-256 of a staged object (constant memory). B18. */
export async function verifyStagedSha256(stagedKey: string, expectedHex: string): Promise<void> {
  const storage = await getStorageDriver();
  if (storage.name === 'local') {
    const { diskPath } = await import('../storage/local');
    const { createReadStream } = await import('node:fs');
    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const rs = createReadStream(diskPath(stagedKey));
      rs.on('data', (c) => hash.update(c));
      rs.on('end', () => resolve());
      rs.on('error', reject);
    });
    if (hash.digest('hex') !== expectedHex.toLowerCase()) {
      throw new HttpError(422, 'checksum_mismatch', 'staged file checksum does not match client sha256');
    }
    return;
  }
  // R2: stream the object through an incremental hash (no full buffering).
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const client = (storage as unknown as { client: S3Client }).client;
  const bucket = process.env.R2_BUCKET_DATA || 'ezvault-data';
  const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: stagedKey }));
  if (!out.Body) throw new HttpError(422, 'unreadable', 'staged object has no body');
  const hash = createHash('sha256');
  const stream = out.Body as unknown as AsyncIterable<Uint8Array>;
  for await (const chunk of stream) hash.update(chunk);
  if (hash.digest('hex') !== expectedHex.toLowerCase()) {
    throw new HttpError(422, 'checksum_mismatch', 'staged file checksum does not match client sha256');
  }
}

/**
 * Stream-hash a staged object, returning the lowercase hex SHA-256
 * (constant memory). W2-D: the relink route uses this for the explicit-link
 * path, where there is no client claim to verify — the server computes the
 * digest itself so the photo row always records a real checksum.
 */
export async function sha256OfStaged(stagedKey: string): Promise<string> {
  const storage = await getStorageDriver();
  const hash = createHash('sha256');
  if (storage.name === 'local') {
    const { diskPath } = await import('../storage/local');
    const { createReadStream } = await import('node:fs');
    await new Promise<void>((resolve, reject) => {
      const rs = createReadStream(diskPath(stagedKey));
      rs.on('data', (c) => hash.update(c));
      rs.on('end', () => resolve());
      rs.on('error', reject);
    });
    return hash.digest('hex');
  }
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const client = (storage as unknown as { client: S3Client }).client;
  const bucket = process.env.R2_BUCKET_DATA || 'ezvault-data';
  const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: stagedKey }));
  if (!out.Body) throw new HttpError(422, 'unreadable', 'staged object has no body');
  for await (const chunk of out.Body as unknown as AsyncIterable<Uint8Array>) hash.update(chunk);
  return hash.digest('hex');
}

export interface ProcessedPhoto {
  photoSubjectId: string;
  r2Key: string;
  thumbKey: string;
  width: number;
  height: number;
  sizeBytes: number;
  exif: Record<string, unknown>;
  thumbBytes: number;
  /** Wave B1 (row 34): photo rows created by page-split expansion. */
  splitPhotoIds: string[];
}

/**
 * Wave B1 (row 34): create the page-1..N photo rows for a split multi-page
 * file. Rows mirror createPhotoRows' staged shape (r2_key NULL,
 * missing_original, thumb 'pending') so each is finalized by its own
 * /process call. Grouped mode files every page under the source item;
 * split mode mints one item per page (and mirrors the source item's list
 * filing). Idempotent per (project, checksum, page): pages that already
 * have a row are skipped. Returns rows created.
 */
async function expandPageSplit(args: {
  projectId: string;
  jobId: string;
  sourcePhotoId: string;
  originalFilename: string;
  mimetype: string;
  checksumSha256: string;
  sizeBytes: number;
  exif: Record<string, unknown>;
  pageCount: number;
  groupIntoItem: boolean;
  density: number;
}): Promise<string[]> {
  const src = await sql()`SELECT item_id FROM photos WHERE subject_id = ${args.sourcePhotoId}`;
  if (!src.length) return [];
  const sourceItemId = src[0]['item_id'] as string;

  const existing = await sql()`SELECT p.page FROM photos p JOIN subjects s ON s.id = p.subject_id
    WHERE s.project_id = ${args.projectId} AND p.checksum_sha256 = ${args.checksumSha256} AND p.page > 0`;
  const have = new Set(existing.map((r) => Number(r['page'])));

  const plan = planPageSplit(args.pageCount, args.groupIntoItem).slice(1); // page 0 = source
  const todo = plan.filter((e) => !have.has(e.page));
  if (!todo.length) return [];

  // Mirror the source item's list filing onto split-mode sibling items.
  const srcLists = await sql()`SELECT list_id FROM list_items WHERE item_id = ${sourceItemId}`;

  const createdIds: string[] = [];
  await tx((q) => {
    const queries: ReturnType<typeof q>[] = [];
    for (const entry of todo) {
      const photoId = randomUUID();
      const imageId = randomUUID();
      let targetItemId = sourceItemId;
      if (entry.newItem) {
        targetItemId = randomUUID();
        queries.push(q(`INSERT INTO subjects (id, project_id, kind) VALUES ($1,$2,'item')`, [targetItemId, args.projectId]));
        queries.push(q(`INSERT INTO items (subject_id) VALUES ($1)`, [targetItemId]));
        for (const l of srcLists) {
          queries.push(q(
            `INSERT INTO list_items (list_id, item_id, position)
             VALUES ($1,$2,(SELECT COALESCE(MAX(position)+1,0) FROM list_items WHERE list_id=$1))
             ON CONFLICT DO NOTHING`,
            [l['list_id'] as string, targetItemId],
          ));
        }
      }
      queries.push(q(`INSERT INTO subjects (id, project_id, kind, template_id) VALUES ($1,$2,'photo',NULL)`,
        [photoId, args.projectId]));
      queries.push(q(`INSERT INTO images (id, width, height) VALUES ($1,0,0)`, [imageId]));
      queries.push(q(
        `INSERT INTO photos (subject_id, item_id, image_id, position, r2_key, thumb_r2_key,
           missing_original, original_filename, mimetype, checksum_sha256, tpy_checksum_md5,
           size_bytes, width, height, exif, page, density, relative_path)
         VALUES ($1,$2,$3,$4,NULL,'pending',true,$5,$6,$7,NULL,$8,0,0,$9::jsonb,$10,$11,NULL)`,
        [photoId, targetItemId, imageId, entry.position,
          args.originalFilename.slice(0, 255), args.mimetype, args.checksumSha256,
          args.sizeBytes, JSON.stringify(args.exif ?? {}), entry.page, args.density],
      ));
      queries.push(q(
        `INSERT INTO tpy_import_map (job_id, tpy_subject_id, new_subject_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [args.jobId, `upload:${args.checksumSha256}`, photoId],
      ));
      createdIds.push(photoId);
    }
    queries.push(q(`UPDATE import_jobs SET total = total + $2, updated_at = now() WHERE id = $1`,
      [args.jobId, createdIds.length]));
    queries.push(bumpRevQuery(args.projectId));
    return queries;
  });

  // Compound-undo bookkeeping: same checkpoint append as createPhotoRows.
  await sql()`UPDATE import_jobs
    SET checkpoint = jsonb_set(
          COALESCE(checkpoint,'{}'::jsonb),
          '{subject_ids}',
          COALESCE(checkpoint->'subject_ids','[]'::jsonb) || ${JSON.stringify(createdIds)}::jsonb
        ),
        updated_at = now()
    WHERE id = ${args.jobId}`;
  return createdIds;
}

export async function processPhoto(input: ProcessPhotoInput): Promise<ProcessedPhoto> {
  const cpuStart = process.cpuUsage();
  await checkCpuGuard();

  const {
    projectId, jobId, stagedKey, artifactKey, photoSubjectId,
    originalFilename, mimetype, checksumSha256, clientExif,
  } = input;

  if (!isAllowedUploadMimetype(mimetype)) {
    throw new HttpError(422, 'bad_mimetype', `mimetype not on v1 allowlist: ${mimetype}`);
  }

  const storage = await getStorageDriver();
  let sourceKey = stagedKey;
  let head = await storage.head(stagedKey);
  if (!head) {
    // Wave B1 (row 34): a split page-N photo may be processed after the
    // page-0 photo already consumed + deleted the staged object. The
    // page-0 sibling's finalized original is byte-identical — read from
    // there instead of 404ing.
    const sib = await sql()`SELECT r2_key FROM photos p JOIN subjects s ON s.id = p.subject_id
      WHERE s.project_id = ${projectId} AND p.checksum_sha256 = ${checksumSha256}
        AND p.page = 0 AND p.r2_key IS NOT NULL LIMIT 1`;
    const sibKey = sib.length ? (sib[0]['r2_key'] as string) : null;
    if (sibKey) {
      sourceKey = sibKey;
      head = await storage.head(sibKey);
    }
  }
  if (!head) throw new HttpError(404, 'not_found', 'staged upload not found (expired?)');

  // B1 (re-verify at process): magic bytes of the staged object.
  const probe = await storage.getRange(sourceKey, 0, MAGIC_PROBE_BYTES - 1);
  if (!magicMatchesMimetype(mimetype, probe)) {
    if (sourceKey === stagedKey) await storage.delete(stagedKey).catch(() => {});
    throw new HttpError(422, 'magic_mismatch', 'staged bytes do not match the claimed mimetype');
  }

  // Decode source: artifact for HEIC/AVIF, staged original otherwise.
  const decodeKey = artifactKey ?? sourceKey;
  const isHeicFamily = mimetype === 'image/heic' || mimetype === 'image/heif' || mimetype === 'image/avif';

  let originalBytes: Buffer;
  let decodeBytes: Buffer;
  if (storage.name === 'local') {
    const { diskPath } = await import('../storage/local');
    const { readFile } = await import('node:fs/promises');
    originalBytes = await readFile(diskPath(sourceKey));
    decodeBytes = decodeKey === sourceKey ? originalBytes : await readFile(diskPath(decodeKey));
  } else {
    // Stream into a buffer (cap: MAX_PHOTO_BYTES enforced at /complete).
    const bufs: Buffer[] = [];
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = (storage as unknown as { client: S3Client }).client;
    const bucket = process.env.R2_BUCKET_DATA || 'ezvault-data';
    for (const k of [sourceKey, decodeKey]) {
      if (k === sourceKey && bufs.length) { bufs.push(bufs[0]); continue; }
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: k }));
      const chunks: Buffer[] = [];
      for await (const chunk of out.Body as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      bufs.push(Buffer.concat(chunks));
    }
    [originalBytes, decodeBytes] = bufs;
  }

  // B6: SVG sanitized BEFORE persisting to originals/.
  const detected = detectFormat(probe);
  if (detected === 'svg' || mimetype === 'image/svg+xml') {
    try {
      originalBytes = sanitizeSvg(originalBytes);
      decodeBytes = originalBytes;
    } catch (err) {
      if (err instanceof SvgRejectedError) throw new HttpError(422, 'svg_rejected', err.message);
      throw err;
    }
  }

  // Wave B1 (rows 7 + 34): this photo's page + stored density, and the
  // project's default render density. Effective density = per-photo
  // override → project default → 300 (lib/import/density.ts).
  const photoState = await sql()`SELECT page, density FROM photos WHERE subject_id = ${photoSubjectId}`;
  const photoPage = photoState.length ? Number(photoState[0]['page'] ?? 0) : 0;
  const storedDensity = photoState.length ? (photoState[0]['density'] as number | null) : null;
  const projState = await sql()`SELECT default_density FROM projects WHERE id = ${projectId}`;
  const projectDensity = projState.length ? (projState[0]['default_density'] as number | null) : null;
  const effectiveDensity = resolveDensity(
    storedDensity != null ? Number(storedDensity) : null,
    projectDensity != null ? Number(projectDensity) : null,
  );

  // Rasterize the formats the pinned libvips cannot decode (verified
  // 2026-10-21: sharp.format.pdf.input === false, sharp.format.jp2.input
  // === false) through the vetted render layer (INTEGRATION-DECISIONS 6+7).
  let pageCount = 1;
  if (detected === 'pdf') {
    try {
      pageCount = await countPdfPages(originalBytes);
      const raster = await renderPdfPage(
        originalBytes,
        Math.min(Math.max(photoPage, 0), pageCount - 1),
        effectiveDensity,
      );
      decodeBytes = raster.png;
    } catch (err) {
      throw new HttpError(422, 'undecodable', `PDF could not be rendered (${err instanceof Error ? err.message : 'render failed'})`);
    }
  } else if (detected === 'jp2') {
    try {
      decodeBytes = (await decodeJp2ToPng(originalBytes)).png;
    } catch (err) {
      throw new HttpError(422, 'undecodable', `JPEG 2000 could not be decoded (${err instanceof Error ? err.message : 'decode failed'})`);
    }
  }

  // B5: dimension pre-check before full decode + pixel cap on the pipeline.
  // A6: one sharp instance for metadata() AND the thumbnail — the header
  // decode is shared instead of renderThumb() spinning a second instance
  // over the same bytes (equivalent output: rotate + 1600px WebP q80).
  // Wave B1: SVG rasterizes at the effective density; a TIFF photo created
  // by page-splitting selects its page.
  const { default: sharp } = await import('sharp');
  const sharpOpts: import('sharp').SharpOptions = { limitInputPixels: MAX_INPUT_PIXELS };
  if (detected === 'svg') sharpOpts.density = effectiveDensity;
  if (detected === 'tiff' && photoPage > 0) sharpOpts.page = photoPage;
  const pipeline = sharp(decodeBytes, sharpOpts);
  let meta;
  try {
    meta = await pipeline.metadata();
  } catch {
    throw new HttpError(422, 'undecodable', 'image could not be decoded');
  }
  if (detected === 'tiff') pageCount = meta.pages ?? 1;
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width * height > MAX_INPUT_PIXELS || width <= 0 || height <= 0) {
    throw new HttpError(422, 'too_many_pixels', `image exceeds the ${MAX_INPUT_PIXELS}px input cap`);
  }

  const thumbBytes = await pipeline
    .rotate()
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();

  // EXIF: server-side sharp for non-HEIC; client-supplied for HEIC (ADR-2.16).
  let exif: Record<string, unknown> = {};
  if (isHeicFamily) {
    exif = clientExif ?? {};
  } else if (meta.exif) {
    try {
      const { default: exifr } = await import('exifr');
      exif = (await exifr.parse(decodeBytes).catch(() => ({}))) ?? {};
    } catch {
      exif = {};
    }
  }

  // Move to final keys.
  const ext = extForMimetype(mimetypeForFormat(detected ?? 'jpg'));
  const r2Key = keys.original(projectId, photoSubjectId, ext);
  const thumbKey = keys.thumb(projectId, photoSubjectId);
  await storage.putBytes(r2Key, originalBytes, {
    contentType: mimetype,
    metadata: { sha256: checksumSha256, 'original-filename': originalFilename.slice(0, 200) },
  });
  await storage.putBytes(thumbKey, thumbBytes, { contentType: 'image/webp' });
  await storage.delete(stagedKey).catch(() => {});
  if (artifactKey && artifactKey !== stagedKey) await storage.delete(artifactKey).catch(() => {});

  const sizeBytes = originalBytes.length;
  const thumbSize = thumbBytes.length;

  // ONE transaction: finalize photo + counters (FOR UPDATE, lock order
  // counters -> photos -> jobs) + done+1 + rev bump. cpu_seconds is charged
  // exactly once, post-commit, via chargeCpu() below (it updates both the
  // rolling window and the job row) — never in-txn AND post-commit.
  const cpuDelta = process.cpuUsage(cpuStart);
  const cpuSeconds = (cpuDelta.user + cpuDelta.system) / 1e6;

  await tx((q) => [
    bumpCountersQuery(projectId, { originals: sizeBytes, thumbs: thumbSize }),
    q(
      `UPDATE photos SET r2_key = $2, thumb_r2_key = $3, width = $4, height = $5,
              size_bytes = $6, exif = $7::jsonb, mimetype = $8, density = $9,
              missing_original = false
       WHERE subject_id = $1`,
      [photoSubjectId, r2Key, thumbKey, width, height, sizeBytes, JSON.stringify(exif), mimetype,
        // Wave B1: record the density actually rendered at for the formats
        // density applies to; other formats keep whatever was stored.
        detected === 'pdf' || detected === 'svg' || detected === 'tiff' ? effectiveDensity : storedDensity],
    ),
    q(`UPDATE images SET width = $2, height = $3 WHERE id = (SELECT image_id FROM photos WHERE subject_id = $1)`,
      [photoSubjectId, width, height]),
    q(`UPDATE import_jobs SET done = done + 1, updated_at = now() WHERE id = $1`,
      [jobId]),
    bumpRevQuery(projectId),
  ]);

  // Wave B1 (row 34): page-split expansion. Only the page-0 photo of an
  // explicitly-split upload job expands (tpy/relink callers never pass
  // splitPages, so their 1:1 photo mapping is untouched). Expansion
  // failure must not fail the source photo — it is recorded on the job.
  let splitPhotoIds: string[] = [];
  if (
    input.splitPages === true && photoPage === 0 && pageCount > 1 &&
    (detected === 'pdf' || detected === 'tiff')
  ) {
    try {
      splitPhotoIds = await expandPageSplit({
        projectId, jobId,
        sourcePhotoId: photoSubjectId,
        originalFilename, mimetype, checksumSha256,
        sizeBytes, exif,
        pageCount,
        groupIntoItem: input.groupIntoItem === true,
        density: effectiveDensity,
      });
    } catch (err) {
      console.error('page-split expansion failed:', err);
      await sql()`UPDATE import_jobs SET failed = failed + 1, updated_at = now() WHERE id = ${jobId}`.catch(() => {});
    }
  }

  // Charge the rolling CPU window AFTER the commit (operational, non-blocking).
  await chargeCpu(cpuSeconds, jobId).catch(() => {});

  return { photoSubjectId, r2Key, thumbKey, width, height, sizeBytes, exif, thumbBytes: thumbSize, splitPhotoIds };
}
