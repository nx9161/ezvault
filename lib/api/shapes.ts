// SPDX-License-Identifier: MIT
/**
 * lib/api/shapes.ts — consistent JSON shaping for subjects/photos/items
 * plus trash/restore primitives shared by the item/photo/selection routes.
 */

import { sql, tx, bumpRevQuery, bumpCountersQuery, type TxQuery } from '../db/index';
import { getStorageDriver } from '../storage/driver';
import { HttpError } from './route-utils';
import type { TrashReason } from '../types';

export interface PhotoJson {
  subject_id: string;
  project_id: string;
  kind: 'photo';
  item_id: string;
  image_id: string;
  position: number;
  r2_key: string | null;
  thumb_r2_key: string;
  missing_original: boolean;
  original_filename: string;
  mimetype: string;
  checksum_sha256: string;
  tpy_checksum_md5: string | null;
  size_bytes: number;
  width: number;
  height: number;
  exif: Record<string, unknown>;
  page: number;
  density: number | null;
  keep_original: boolean;
  template_id: string | null;
  edits: {
    angle: number; mirror: boolean; brightness: number; contrast: number;
    hue: number; saturation: number; negative: boolean; sharpen: number;
  };
  created_at: string;
}

export async function getPhotoJson(projectId: string, photoSubjectId: string): Promise<PhotoJson> {
  const rows = await sql()`
    SELECT s.id AS subject_id, s.project_id, s.template_id,
           p.item_id, p.position, p.r2_key, p.thumb_r2_key, p.missing_original,
           p.original_filename, p.mimetype, p.checksum_sha256, p.tpy_checksum_md5,
           p.size_bytes, p.width, p.height, p.exif, p.page, p.density, p.keep_original,
           p.created_at,
           i.id AS image_id, i.angle, i.mirror, i.brightness, i.contrast, i.hue,
           i.saturation, i.negative, i.sharpen
    FROM photos p
    JOIN subjects s ON s.id = p.subject_id
    JOIN images i ON i.id = p.image_id
    WHERE s.project_id = ${projectId} AND p.subject_id = ${photoSubjectId}`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'photo not found');
  return photoRowToJson(rows[0]);
}

/** Map one joined photo row to its API shape. */
function photoRowToJson(r: Record<string, unknown>): PhotoJson {
  return {
    subject_id: r['subject_id'] as string,
    project_id: r['project_id'] as string,
    kind: 'photo',
    item_id: r['item_id'] as string,
    image_id: r['image_id'] as string,
    position: Number(r['position']),
    r2_key: r['r2_key'] as string | null,
    thumb_r2_key: r['thumb_r2_key'] as string,
    missing_original: Boolean(r['missing_original']),
    original_filename: r['original_filename'] as string,
    mimetype: r['mimetype'] as string,
    checksum_sha256: r['checksum_sha256'] as string,
    tpy_checksum_md5: r['tpy_checksum_md5'] as string | null,
    size_bytes: Number(r['size_bytes']),
    width: Number(r['width']),
    height: Number(r['height']),
    exif: (r['exif'] ?? {}) as Record<string, unknown>,
    page: Number(r['page']),
    density: r['density'] != null ? Number(r['density']) : null,
    keep_original: Boolean(r['keep_original']),
    template_id: r['template_id'] as string | null,
    edits: {
      angle: Number(r['angle']), mirror: Boolean(r['mirror']),
      brightness: Number(r['brightness']), contrast: Number(r['contrast']),
      hue: Number(r['hue']), saturation: Number(r['saturation']),
      negative: Boolean(r['negative']), sharpen: Number(r['sharpen']),
    },
    created_at: r['created_at'] as string,
  };
}

/**
 * A2: batched photo JSON for grid endpoints — ONE query for N photos
 * instead of N sequential getPhotoJson() round trips. Returns rows in input
 * order; throws 404 when any id is missing (same as the single loader).
 */
export async function getPhotoJsonBatch(
  projectId: string,
  photoSubjectIds: string[],
): Promise<PhotoJson[]> {
  if (!photoSubjectIds.length) return [];
  const rows = await sql()`
    SELECT s.id AS subject_id, s.project_id, s.template_id,
           p.item_id, p.position, p.r2_key, p.thumb_r2_key, p.missing_original,
           p.original_filename, p.mimetype, p.checksum_sha256, p.tpy_checksum_md5,
           p.size_bytes, p.width, p.height, p.exif, p.page, p.density, p.keep_original,
           p.created_at,
           i.id AS image_id, i.angle, i.mirror, i.brightness, i.contrast, i.hue,
           i.saturation, i.negative, i.sharpen
    FROM photos p
    JOIN subjects s ON s.id = p.subject_id
    JOIN images i ON i.id = p.image_id
    WHERE s.project_id = ${projectId} AND p.subject_id = ANY(${photoSubjectIds})`;
  if (rows.length !== photoSubjectIds.length) {
    throw new HttpError(404, 'not_found', 'photo not found');
  }
  const byId = new Map(rows.map((r) => [r['subject_id'] as string, photoRowToJson(r)]));
  return photoSubjectIds.map((sid) => byId.get(sid)!);
}

/** Move a subject to trash (reason + prior list positions for items). */
export async function trashSubject(
  projectId: string, subjectId: string, reason: TrashReason,
): Promise<void> {
  const s = await sql()`SELECT id, kind FROM subjects WHERE id = ${subjectId} AND project_id = ${projectId}`;
  if (!s.length) throw new HttpError(404, 'not_found', 'subject not found');
  const kind = s[0]['kind'] as string;
  let priorLists: unknown[] = [];
  if (kind === 'item') {
    const rows = await sql()`SELECT list_id, position FROM list_items WHERE item_id = ${subjectId}`;
    priorLists = rows.map((r) => ({ list_id: r['list_id'], position: Number(r['position']) }));
  }
  await tx((q) => [
    q(`INSERT INTO trash (subject_id, reason, prior_lists) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (subject_id) DO UPDATE SET reason = EXCLUDED.reason, deleted_at = now()`,
      [subjectId, reason, JSON.stringify(priorLists)]),
    ...(kind === 'item'
      ? [q(`DELETE FROM list_items WHERE item_id = $1`, [subjectId]) as TxQuery]
      : []),
    bumpRevQuery(projectId),
  ]);
}

/** Restore a trashed subject; items re-file to their prior lists/positions. */
export async function restoreSubject(projectId: string, subjectId: string): Promise<void> {
  const t = await sql()`SELECT t.subject_id, t.prior_lists, s.kind FROM trash t
    JOIN subjects s ON s.id = t.subject_id
    WHERE t.subject_id = ${subjectId} AND s.project_id = ${projectId}`;
  if (!t.length) throw new HttpError(404, 'not_found', 'trashed subject not found');
  const kind = t[0]['kind'] as string;
  const priorLists = (t[0]['prior_lists'] ?? []) as { list_id: string; position: number }[];
  await tx((q) => {
    const queries: TxQuery[] = [q(`DELETE FROM trash WHERE subject_id = $1`, [subjectId])];
    if (kind === 'item') {
      for (const pl of priorLists) {
        queries.push(q(
          `INSERT INTO list_items (list_id, item_id, position) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [pl.list_id, subjectId, pl.position],
        ));
      }
    }
    queries.push(bumpRevQuery(projectId));
    return queries;
  });
}

/**
 * Irreversible empty-trash: R2 deletes queued, counters decremented in-txn,
 * audit rows in deleted_photos. Trashed items cascade to their photos
 * (collect their R2 keys first).
 */
export async function emptyTrash(projectId: string): Promise<{ subjects: number; r2_deleted: number }> {
  const trashed = await sql()`SELECT t.subject_id FROM trash t
    JOIN subjects s ON s.id = t.subject_id WHERE s.project_id = ${projectId}`;
  if (!trashed.length) return { subjects: 0, r2_deleted: 0 };
  const ids = trashed.map((r) => r['subject_id'] as string);
  const storage = await getStorageDriver();

  // All photos under the trashed subjects (direct + via trashed items).
  const photoRows = await sql()`
    SELECT DISTINCT p.subject_id, p.r2_key, p.thumb_r2_key, p.size_bytes,
           p.checksum_sha256, p.original_filename
    FROM photos p JOIN subjects s ON s.id = p.subject_id
    WHERE s.project_id = ${projectId}
      AND (p.subject_id = ANY(${ids}) OR p.item_id = ANY(${ids}))`;
  let bytesOriginals = 0;
  let bytesThumbs = 0;
  const keys: string[] = [];
  const audit: { photo_subject_id: string; r2_key: string; checksum_sha256: string }[] = [];
  for (const r of photoRows) {
    const rk = r['r2_key'] as string | null;
    const tk = r['thumb_r2_key'] as string | null;
    if (rk) {
      keys.push(rk);
      bytesOriginals += Number(r['size_bytes'] ?? 0);
      audit.push({
        photo_subject_id: r['subject_id'] as string,
        r2_key: rk,
        checksum_sha256: r['checksum_sha256'] as string,
      });
    }
    if (tk && !tk.includes(':')) {
      keys.push(tk);
      const h = await storage.head(tk).catch(() => null);
      bytesThumbs += h?.size ?? 0;
    }
  }
  // CR-3: DB transaction FIRST, R2 deletes after commit (see undoJob in
  // lib/import/photos.ts for the rationale — ghost rows on irreversible ops
  // are worse than leaked bytes).
  await tx((q) => {
    const queries: TxQuery[] = [
      bumpCountersQuery(projectId, { originals: -bytesOriginals, thumbs: -bytesThumbs }),
    ];
    for (const a of audit) {
      queries.push(q(
        `INSERT INTO deleted_photos (photo_subject_id, r2_key, checksum_sha256) VALUES ($1,$2,$3)`,
        [a.photo_subject_id, a.r2_key, a.checksum_sha256],
      ));
    }
    queries.push(q(`DELETE FROM subjects WHERE id = ANY($1)`, [ids]));
    queries.push(bumpRevQuery(projectId));
    return queries;
  });
  await storage.deleteMany(keys).catch((err) => {
    console.error('emptyTrash: R2 deleteMany failed after DB commit:', err);
  });
  return { subjects: ids.length, r2_deleted: keys.length };
}

/**
 * F4 prune mode (ADR-2.8): permanently delete PHOTOS already in trash —
 * directly-trashed photo subjects plus photos under trashed items (their
 * items stay trashed, photoless). R2 original+thumb objects are deleted
 * first; then, in one transaction: deleted_photos audit rows,
 * storage_counters decrements, subject row deletes (trash rows cascade via
 * ON DELETE CASCADE). Irreversible — no undo. The caller CPU-guards and
 * CPU-charges the run (the compress route does both around this call).
 */
export async function pruneTrashPhotos(projectId: string): Promise<{
  deleted_photos: number; r2_deleted: number; bytes_reclaimed: number;
}> {
  const trashed = await sql()`SELECT t.subject_id FROM trash t
    JOIN subjects s ON s.id = t.subject_id WHERE s.project_id = ${projectId}`;
  if (!trashed.length) return { deleted_photos: 0, r2_deleted: 0, bytes_reclaimed: 0 };
  const ids = trashed.map((r) => r['subject_id'] as string);
  const storage = await getStorageDriver();

  // Photos under the trashed subjects (direct photo subjects + via trashed
  // items) — same collection pattern as emptyTrash.
  const photoRows = await sql()`
    SELECT DISTINCT p.subject_id, p.r2_key, p.thumb_r2_key, p.size_bytes,
           p.checksum_sha256
    FROM photos p JOIN subjects s ON s.id = p.subject_id
    WHERE s.project_id = ${projectId}
      AND (p.subject_id = ANY(${ids}) OR p.item_id = ANY(${ids}))`;
  let bytesOriginals = 0;
  let bytesThumbs = 0;
  const keys: string[] = [];
  const audit: { photo_subject_id: string; r2_key: string; checksum_sha256: string }[] = [];
  for (const r of photoRows) {
    const rk = r['r2_key'] as string | null;
    const tk = r['thumb_r2_key'] as string | null;
    if (rk) {
      keys.push(rk);
      bytesOriginals += Number(r['size_bytes'] ?? 0);
      audit.push({
        photo_subject_id: r['subject_id'] as string,
        r2_key: rk,
        checksum_sha256: r['checksum_sha256'] as string,
      });
    }
    if (tk && !tk.includes(':')) {
      keys.push(tk);
      const h = await storage.head(tk).catch(() => null);
      bytesThumbs += h?.size ?? 0;
    }
  }
  const photoIds = [...new Set(audit.map((a) => a.photo_subject_id))];
  // CR-3: DB transaction FIRST, R2 deletes after commit (same rationale as
  // emptyTrash above).
  await tx((q) => {
    const queries: TxQuery[] = [
      bumpCountersQuery(projectId, { originals: -bytesOriginals, thumbs: -bytesThumbs }),
    ];
    for (const a of audit) {
      queries.push(q(
        `INSERT INTO deleted_photos (photo_subject_id, r2_key, checksum_sha256) VALUES ($1,$2,$3)`,
        [a.photo_subject_id, a.r2_key, a.checksum_sha256],
      ));
    }
    if (photoIds.length) {
      queries.push(q(`DELETE FROM subjects WHERE id = ANY($1)`, [photoIds]));
    }
    queries.push(bumpRevQuery(projectId));
    return queries;
  });
  await storage.deleteMany(keys).catch((err) => {
    console.error('pruneTrashPhotos: R2 deleteMany failed after DB commit:', err);
  });
  return { deleted_photos: photoIds.length, r2_deleted: keys.length, bytes_reclaimed: bytesOriginals + bytesThumbs };
}
