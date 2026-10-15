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

import { createHash } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { getStorageDriver, keys, extForMimetype } from '../storage/driver.js';
import { detectFormat, magicMatchesMimetype, mimetypeForFormat } from './magic.js';
import { isAllowedUploadMimetype, MAX_INPUT_PIXELS, MAGIC_PROBE_BYTES } from './validation.js';
import { sanitizeSvg, SvgRejectedError } from './svg-sanitize.js';
import { renderThumb } from '../export/bake.js';
import { sql, tx, bumpRevQuery, bumpCountersQuery } from '../db/index.js';
import { checkCpuGuard, chargeCpu } from '../cpu-budget.js';
import { HttpError } from '../api/route-utils.js';

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
}

/** Stream-verify SHA-256 of a staged object (constant memory). B18. */
export async function verifyStagedSha256(stagedKey: string, expectedHex: string): Promise<void> {
  const storage = await getStorageDriver();
  if (storage.name === 'local') {
    const { diskPath } = await import('../storage/local.js');
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

export interface ProcessedPhoto {
  photoSubjectId: string;
  r2Key: string;
  thumbKey: string;
  width: number;
  height: number;
  sizeBytes: number;
  exif: Record<string, unknown>;
  thumbBytes: number;
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
  const head = await storage.head(stagedKey);
  if (!head) throw new HttpError(404, 'not_found', 'staged upload not found (expired?)');

  // B1 (re-verify at process): magic bytes of the staged object.
  const probe = await storage.getRange(stagedKey, 0, MAGIC_PROBE_BYTES - 1);
  if (!magicMatchesMimetype(mimetype, probe)) {
    await storage.delete(stagedKey).catch(() => {});
    throw new HttpError(422, 'magic_mismatch', 'staged bytes do not match the claimed mimetype');
  }

  // Decode source: artifact for HEIC/AVIF, staged original otherwise.
  const decodeKey = artifactKey ?? stagedKey;
  const isHeicFamily = mimetype === 'image/heic' || mimetype === 'image/heif' || mimetype === 'image/avif';

  let originalBytes: Buffer;
  let decodeBytes: Buffer;
  if (storage.name === 'local') {
    const { diskPath } = await import('../storage/local.js');
    const { readFile } = await import('node:fs/promises');
    originalBytes = await readFile(diskPath(stagedKey));
    decodeBytes = decodeKey === stagedKey ? originalBytes : await readFile(diskPath(decodeKey));
  } else {
    // Stream into a buffer (cap: MAX_PHOTO_BYTES enforced at /complete).
    const bufs: Buffer[] = [];
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = (storage as unknown as { client: S3Client }).client;
    const bucket = process.env.R2_BUCKET_DATA || 'ezvault-data';
    for (const k of [stagedKey, decodeKey]) {
      if (k === stagedKey && bufs.length) { bufs.push(bufs[0]); continue; }
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

  // B5: dimension pre-check before full decode + pixel cap on the pipeline.
  const { default: sharp } = await import('sharp');
  let meta;
  try {
    meta = await sharp(decodeBytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new HttpError(422, 'undecodable', 'image could not be decoded');
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width * height > MAX_INPUT_PIXELS || width <= 0 || height <= 0) {
    throw new HttpError(422, 'too_many_pixels', `image exceeds the ${MAX_INPUT_PIXELS}px input cap`);
  }

  const thumbBytes = await renderThumb(decodeBytes);

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
  // counters -> photos -> jobs) + cpu_seconds + rev bump.
  const cpuDelta = process.cpuUsage(cpuStart);
  const cpuSeconds = (cpuDelta.user + cpuDelta.system) / 1e6;

  await tx((q) => [
    bumpCountersQuery(projectId, { originals: sizeBytes, thumbs: thumbSize }),
    q(
      `UPDATE photos SET r2_key = $2, thumb_r2_key = $3, width = $4, height = $5,
              size_bytes = $6, exif = $7::jsonb, mimetype = $8
       WHERE subject_id = $1`,
      [photoSubjectId, r2Key, thumbKey, width, height, sizeBytes, JSON.stringify(exif), mimetype],
    ),
    q(`UPDATE images SET width = $2, height = $3 WHERE id = (SELECT image_id FROM photos WHERE subject_id = $1)`,
      [photoSubjectId, width, height]),
    q(`UPDATE import_jobs SET done = done + 1, cpu_seconds = cpu_seconds + $2, updated_at = now() WHERE id = $1`,
      [jobId, cpuSeconds]),
    bumpRevQuery(projectId),
  ]);

  // Charge the rolling CPU window AFTER the commit (operational, non-blocking).
  await chargeCpu(cpuSeconds, jobId).catch(() => {});

  return { photoSubjectId, r2Key, thumbKey, width, height, sizeBytes, exif, thumbBytes: thumbSize };
}
