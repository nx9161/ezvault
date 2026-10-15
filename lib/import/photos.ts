// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/import/photos.ts — photo row creation (upload / register / tpy-shared)
 * and compound job undo.
 *
 * createPhotoRows: dual-checksum dedupe honoring duplicate_policy, one item
 * per photo unless itemId is given (Tropy parity), rows staged with
 * r2_key NULL / missing_original=true until /process finalizes them.
 * Created subject ids are appended to import_jobs.checkpoint.subject_ids so
 * /jobs/[jobId]/undo can transactionally remove everything.
 */

import { randomUUID } from 'node:crypto';
import { sql, tx, bumpRevQuery, bumpCountersQuery, type TxQuery } from '../db/index';
import { getStorageDriver } from '../storage/driver';
import type { DuplicatePolicy } from '../types';

export interface PhotoEntry {
  originalFilename: string;
  mimetype: string;
  checksumSha256: string;
  tpyChecksumMd5?: string | null;
  sizeBytes?: number;
  width?: number;
  height?: number;
  exif?: Record<string, unknown>;
  page?: number;
  density?: number | null;
  position?: number;
  templateId?: string | null;
  /**
   * F2: list the photo's item into this list, inserted in the SAME
   * transaction as the photo rows. Must be a project-scoped list id — the
   * caller validates scope; a NULL/undefined value files nothing.
   */
  listId?: string | null;
  /**
   * F2: client's folder-relative path, stored as photos.relative_path
   * (audit only — never rendered, never exported).
   */
  relativePath?: string | null;
}

export interface CreatedPhoto {
  subjectId: string;
  itemId: string;
  dedupe: 'created' | 'skipped_duplicate' | 'kept_both';
}

/**
 * Create subject+images+photos rows for one batch. Returns per-entry results
 * in input order.
 */
export async function createPhotoRows(
  projectId: string,
  jobId: string,
  entries: PhotoEntry[],
  opts: { itemId?: string; duplicatePolicy?: DuplicatePolicy } = {},
): Promise<CreatedPhoto[]> {
  const policy = opts.duplicatePolicy ?? 'skip';
  const out: CreatedPhoto[] = [];
  const createdIds: string[] = [];

  // Reuse or create the parent item when itemId is fixed.
  let fixedItemId = opts.itemId;
  if (fixedItemId) {
    const chk = await sql()`SELECT subject_id FROM items JOIN subjects s ON s.id = items.subject_id
      WHERE items.subject_id = ${fixedItemId} AND s.project_id = ${projectId}`;
    if (!chk.length) throw new Error('item not found in this project');
  }

  for (const [idx, e] of entries.entries()) {
    // Dual-checksum dedupe: md5 first (tpy parity), then sha256.
    let existing: string | null = null;
    if (e.tpyChecksumMd5) {
      const r = await sql()`SELECT p.subject_id FROM photos p JOIN subjects s ON s.id = p.subject_id
        WHERE s.project_id = ${projectId} AND p.tpy_checksum_md5 = ${e.tpyChecksumMd5} LIMIT 1`;
      if (r.length) existing = r[0]['subject_id'] as string;
    }
    if (!existing) {
      const r = await sql()`SELECT p.subject_id FROM photos p JOIN subjects s ON s.id = p.subject_id
        WHERE s.project_id = ${projectId} AND p.checksum_sha256 = ${e.checksumSha256} LIMIT 1`;
      if (r.length) existing = r[0]['subject_id'] as string;
    }
    if (existing && policy === 'skip') {
      out.push({ subjectId: existing, itemId: '', dedupe: 'skipped_duplicate' });
      continue;
    }

    const photoId = randomUUID();
    const imageId = randomUUID();
    let itemId = fixedItemId;
    const queries: TxQuery[] = [];
    const q = (text: string, params?: unknown[]): TxQuery => ({ text, params });

    if (!itemId) {
      itemId = randomUUID();
      queries.push(q(`INSERT INTO subjects (id, project_id, kind) VALUES ($1,$2,'item')`, [itemId, projectId]));
      queries.push(q(`INSERT INTO items (subject_id) VALUES ($1)`, [itemId]));
    }
    queries.push(q(`INSERT INTO subjects (id, project_id, kind, template_id) VALUES ($1,$2,'photo',$3)`,
      [photoId, projectId, e.templateId ?? null]));
    queries.push(q(`INSERT INTO images (id, width, height) VALUES ($1,$2,$3)`,
      [imageId, e.width ?? 0, e.height ?? 0]));
    queries.push(q(
      `INSERT INTO photos (subject_id, item_id, image_id, position, r2_key, thumb_r2_key,
         missing_original, original_filename, mimetype, checksum_sha256, tpy_checksum_md5,
         size_bytes, width, height, exif, page, density, relative_path)
       VALUES ($1,$2,$3,$4,NULL,'pending',true,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)`,
      [photoId, itemId, imageId, e.position ?? idx,
        e.originalFilename.slice(0, 255), e.mimetype, e.checksumSha256, e.tpyChecksumMd5 ?? null,
        e.sizeBytes ?? 0, e.width ?? 0, e.height ?? 0,
        JSON.stringify(e.exif ?? {}), e.page ?? 0, e.density ?? null,
        (e.relativePath ?? '').slice(0, 1000) || null],
    ));
    // F2: file the new item into its folder list in the SAME transaction —
    // position appended at the end of the list. ON CONFLICT DO NOTHING keeps
    // a resubmitted /complete idempotent-ish per batch.
    if (e.listId) {
      queries.push(q(
        `INSERT INTO list_items (list_id, item_id, position)
         VALUES ($1,$2,(SELECT COALESCE(MAX(position)+1,0) FROM list_items WHERE list_id=$1))
         ON CONFLICT DO NOTHING`,
        [e.listId, itemId],
      ));
    }
    queries.push(q(
      `INSERT INTO tpy_import_map (job_id, tpy_subject_id, new_subject_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [jobId, `upload:${e.checksumSha256}`, photoId],
    ));
    queries.push(bumpRevQuery(projectId));
    await tx(() => queries);

    createdIds.push(photoId);
    out.push({
      subjectId: photoId,
      itemId: itemId!,
      dedupe: existing ? 'kept_both' : 'created',
    });
  }

  if (createdIds.length) {
    await sql()`UPDATE import_jobs
      SET checkpoint = COALESCE(checkpoint,'{}'::jsonb) || ${JSON.stringify({ subject_ids: createdIds })}::jsonb,
          updated_at = now()
      WHERE id = ${jobId}`;
  }
  return out;
}

/** Subject ids created under a job (upload/jsonld: checkpoint; tpy: import map). */
export async function jobSubjectIds(jobId: string): Promise<string[]> {
  const rows = await sql()`SELECT checkpoint, kind FROM import_jobs WHERE id = ${jobId}`;
  if (!rows.length) return [];
  const cp = (rows[0]['checkpoint'] ?? {}) as { subject_ids?: string[] };
  if (Array.isArray(cp.subject_ids) && cp.subject_ids.length) return cp.subject_ids;
  const mapped = await sql()`SELECT new_subject_id FROM tpy_import_map WHERE job_id = ${jobId}`;
  return mapped.map((r) => r['new_subject_id'] as string);
}

/**
 * Compound transactional undo for a job: R2 object deletes + counter
 * decrements + row deletes (subjects cascade), one undo step.
 * Returns the number of subjects removed.
 */
export async function undoJob(jobId: string, projectId: string): Promise<number> {
  const subjectIds = await jobSubjectIds(jobId);
  if (!subjectIds.length) {
    await sql()`UPDATE import_jobs SET status = 'cancelled', updated_at = now() WHERE id = ${jobId}`;
    return 0;
  }
  const storage = await getStorageDriver();

  // Collect R2 keys + byte sizes BEFORE deleting rows.
  const photoRows = await sql()`SELECT subject_id, r2_key, thumb_r2_key, size_bytes FROM photos
    WHERE subject_id = ANY(${subjectIds})`;
  let bytesOriginals = 0;
  let bytesThumbs = 0;
  const keys: string[] = [];
  for (const r of photoRows) {
    const rk = r['r2_key'] as string | null;
    const tk = r['thumb_r2_key'] as string | null;
    if (rk) {
      keys.push(rk);
      bytesOriginals += Number(r['size_bytes'] ?? 0);
    }
    if (tk && !tk.includes(':')) {
      keys.push(tk);
      const h = await storage.head(tk).catch(() => null);
      bytesThumbs += h?.size ?? 0;
    }
  }
  await storage.deleteMany(keys);

  await tx((q) => [
    bumpCountersQuery(projectId, {
      originals: -bytesOriginals,
      thumbs: -bytesThumbs,
    }),
    q(`DELETE FROM subjects WHERE id = ANY($1)`, [subjectIds]),
    q(`UPDATE import_jobs SET status = 'cancelled', updated_at = now() WHERE id = $1`, [jobId]),
    bumpRevQuery(projectId),
  ]);
  return subjectIds.length;
}
