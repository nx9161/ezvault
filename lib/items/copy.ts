// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/items/copy.ts — deep-copy an item into another project (row 32).
 *
 * Delete-independence is binding: the copy NEVER shares storage keys or
 * rows with the source. Every photo original + thumbnail is copied to a
 * FRESH key under the target project (`originals/{target}/{newPhoto}.…`),
 * and every row (subjects, items, images, photos, selections, metadata
 * values + links, taggings, notes) is newly inserted with new ids.
 * Deleting the source item (or the whole source project) cannot break
 * the copy, and vice versa.
 *
 * Cross-project mappings:
 *   - template: matched in the target by URI, else by name; if neither
 *     exists, the template definition is copied into the target project.
 *   - tags: matched by name (citext), created with the source color when
 *     missing.
 *   - lists: NOT copied — list trees are project-local organization; the
 *     copy lands unfiled in the target project (CONTRACT.md, row 32).
 *   - transcriptions: keyed to images in a wave-C table with no v1 data;
 *     not copied.
 */

import { randomUUID } from 'node:crypto';
import { sql, tx, bumpRevQuery, bumpCountersQuery, type TxQuery } from '@/lib/db/index';
import { HttpError } from '@/lib/api/route-utils';
import { getStorageDriver, keys, extForMimetype } from '@/lib/storage/driver';

const qq = (text: string, params?: unknown[]): TxQuery => ({ text, params });

export interface CopyResult {
  item_id: string;
  target_project_id: string;
  photos_copied: number;
  selections_copied: number;
  notes_copied: number;
  rev: number;
}

export async function copyItemToProject(
  projectId: string,
  itemId: string,
  targetProjectId: string,
): Promise<CopyResult> {
  const target = await sql()`SELECT id FROM projects WHERE id = ${targetProjectId}`;
  if (!target.length) throw new HttpError(404, 'not_found', 'target project not found');

  const src = await sql()`SELECT s.id, s.template_id, i.cover_image_id
    FROM subjects s JOIN items i ON i.subject_id = s.id
    WHERE s.id = ${itemId} AND s.project_id = ${projectId} AND s.kind = 'item'
      AND NOT EXISTS (SELECT 1 FROM trash t WHERE t.subject_id = s.id)`;
  if (!src.length) throw new HttpError(404, 'not_found', 'item not found');
  const sourceTemplateId = (src[0]['template_id'] as string | null) ?? null;
  const sourceCoverImageId = (src[0]['cover_image_id'] as string | null) ?? null;

  // ---- template mapping -------------------------------------------------
  let targetTemplateId: string | null = null;
  let templateInsert: TxQuery | null = null;
  if (sourceTemplateId) {
    const tpl = await sql()`SELECT name, uri, label_i18n, fields FROM templates WHERE id = ${sourceTemplateId}`;
    if (tpl.length) {
      const name = tpl[0]['name'] as string;
      const uri = (tpl[0]['uri'] as string | null) ?? null;
      const existing = uri
        ? await sql()`SELECT id FROM templates WHERE project_id = ${targetProjectId} AND uri = ${uri} LIMIT 1`
        : await sql()`SELECT id FROM templates WHERE project_id = ${targetProjectId} AND name = ${name} LIMIT 1`;
      const byName = existing.length
        ? existing
        : await sql()`SELECT id FROM templates WHERE project_id = ${targetProjectId} AND name = ${name} LIMIT 1`;
      if (byName.length) {
        targetTemplateId = byName[0]['id'] as string;
      } else {
        targetTemplateId = randomUUID();
        templateInsert = qq(
          `INSERT INTO templates (id, project_id, name, uri, label_i18n, fields) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
          [targetTemplateId, targetProjectId, name, uri,
            JSON.stringify(tpl[0]['label_i18n'] ?? {}), JSON.stringify(tpl[0]['fields'] ?? [])],
        );
      }
    }
  }

  // ---- load the source graph -------------------------------------------
  const photoRows = await sql()`SELECT p.subject_id, p.image_id, p.position, p.r2_key, p.thumb_r2_key,
      p.missing_original, p.original_filename, p.mimetype, p.checksum_sha256, p.tpy_checksum_md5,
      p.size_bytes, p.width, p.height, p.exif, p.page, p.density, p.keep_original,
      im.width AS im_width, im.height AS im_height, im.angle, im.mirror, im.brightness, im.contrast,
      im.hue, im.saturation, im.negative, im.sharpen
    FROM photos p JOIN images im ON im.id = p.image_id
    WHERE p.item_id = ${itemId} ORDER BY p.position`;
  const photoIds = photoRows.map((r) => r['subject_id'] as string);
  const selRows = photoIds.length
    ? await sql()`SELECT sel.subject_id, sel.photo_id, sel.name, sel.x, sel.y, sel.width, sel.height, sel.position,
        s.template_id
      FROM selections sel JOIN subjects s ON s.id = sel.subject_id
      WHERE sel.photo_id = ANY(${photoIds}) ORDER BY sel.position`
    : [];
  const subjectIds = [itemId, ...photoIds, ...selRows.map((r) => r['subject_id'] as string)];
  // Selection templates are project-local too; selections keep their
  // template only when copying within one project — cross-project they
  // fall back to no template (their metadata still copies verbatim).
  const sameProject = targetProjectId === projectId;

  const metaRows = await sql()`SELECT m.subject_id, m.property_uri, m.language, v.datatype, v.text, v.data
    FROM metadata m JOIN metadata_values v ON v.value_id = m.value_id
    WHERE m.subject_id = ANY(${subjectIds}) ORDER BY m.created_at`;
  const tagRows = await sql()`SELECT tg.tag_id, tg.subject_id, t.name, t.color
    FROM taggings tg JOIN tags t ON t.id = tg.tag_id
    WHERE tg.subject_id = ANY(${subjectIds})`;
  const noteRows = await sql()`SELECT subject_id, text, state, language FROM notes
    WHERE subject_id = ANY(${subjectIds}) AND deleted_at IS NULL ORDER BY created_at`;

  // ---- id plan -----------------------------------------------------------
  const newItemId = randomUUID();
  const photoIdMap = new Map<string, string>(); // old photo subject -> new
  const imageIdMap = new Map<string, string>(); // old image -> new
  for (const r of photoRows) {
    photoIdMap.set(r['subject_id'] as string, randomUUID());
    imageIdMap.set(r['image_id'] as string, randomUUID());
  }
  const selIdMap = new Map<string, string>();
  for (const r of selRows) selIdMap.set(r['subject_id'] as string, randomUUID());
  const mapSubject = (old: string): string | null =>
    old === itemId ? newItemId : photoIdMap.get(old) ?? selIdMap.get(old) ?? null;

  // ---- storage copies (fresh keys under the target project) --------------
  const storage = await getStorageDriver();
  const copiedKeys: string[] = [];
  let bytesOriginals = 0;
  let bytesThumbs = 0;
  const newPhotoKeys = new Map<string, { r2_key: string | null; thumb_r2_key: string }>();
  try {
    for (const r of photoRows) {
      const oldPhotoId = r['subject_id'] as string;
      const newPhotoId = photoIdMap.get(oldPhotoId)!;
      const oldKey = (r['r2_key'] as string | null) ?? null;
      const oldThumb = r['thumb_r2_key'] as string;
      const ext = oldKey?.split('.').pop() ?? extForMimetype(r['mimetype'] as string);
      let newKey: string | null = null;
      if (oldKey && !r['missing_original']) {
        newKey = keys.original(targetProjectId, newPhotoId, ext);
        await storage.copy(oldKey, newKey, { contentType: r['mimetype'] as string });
        copiedKeys.push(newKey);
        bytesOriginals += Number(r['size_bytes']);
      }
      const newThumbKey = keys.thumb(targetProjectId, newPhotoId);
      const thumbHead = oldThumb && !oldThumb.includes(':') ? await storage.head(oldThumb).catch(() => null) : null;
      if (thumbHead) {
        await storage.copy(oldThumb, newThumbKey, { contentType: 'image/webp' });
        copiedKeys.push(newThumbKey);
        bytesThumbs += thumbHead.size;
      }
      newPhotoKeys.set(oldPhotoId, { r2_key: newKey, thumb_r2_key: newThumbKey });
    }
  } catch (err) {
    // Roll the storage side back so a failed copy leaves no orphans.
    await storage.deleteMany(copiedKeys).catch(() => undefined);
    throw err;
  }

  // ---- tags in the target project ---------------------------------------
  const targetTagIdByName = new Map<string, string>();
  const tagInserts: TxQuery[] = [];
  const seenTagNames = new Set<string>();
  for (const r of tagRows) {
    const name = r['name'] as string;
    const lower = name.toLowerCase();
    if (seenTagNames.has(lower)) continue;
    seenTagNames.add(lower);
    const existing = await sql()`SELECT id FROM tags WHERE project_id = ${targetProjectId} AND name = ${name} LIMIT 1`;
    if (existing.length) {
      targetTagIdByName.set(lower, existing[0]['id'] as string);
    } else {
      const newTagId = randomUUID();
      targetTagIdByName.set(lower, newTagId);
      tagInserts.push(qq(`INSERT INTO tags (id, project_id, name, color) VALUES ($1,$2,$3,$4)`,
        [newTagId, targetProjectId, name, (r['color'] as string) ?? '#B3541E']));
    }
  }

  // ---- the copy transaction ----------------------------------------------
  const queries: TxQuery[] = [];
  if (templateInsert) queries.push(templateInsert);
  queries.push(...tagInserts);
  queries.push(qq(`INSERT INTO subjects (id, project_id, kind, template_id) VALUES ($1,$2,'item',$3)`,
    [newItemId, targetProjectId, targetTemplateId]));
  queries.push(qq(`INSERT INTO items (subject_id, cover_image_id) VALUES ($1,$2)`,
    [newItemId, sourceCoverImageId ? imageIdMap.get(sourceCoverImageId) ?? null : null]));

  for (const r of photoRows) {
    const oldPhotoId = r['subject_id'] as string;
    const newPhotoId = photoIdMap.get(oldPhotoId)!;
    const newImageId = imageIdMap.get(r['image_id'] as string)!;
    const photoKeys = newPhotoKeys.get(oldPhotoId)!;
    queries.push(qq(`INSERT INTO images (id, width, height, angle, mirror, brightness, contrast, hue, saturation, negative, sharpen)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [newImageId, r['im_width'], r['im_height'], r['angle'], r['mirror'], r['brightness'],
        r['contrast'], r['hue'], r['saturation'], r['negative'], r['sharpen']]));
    queries.push(qq(`INSERT INTO subjects (id, project_id, kind, template_id) VALUES ($1,$2,'photo',NULL)`,
      [newPhotoId, targetProjectId]));
    queries.push(qq(`INSERT INTO photos (subject_id, item_id, image_id, position, r2_key, thumb_r2_key,
        missing_original, original_filename, mimetype, checksum_sha256, tpy_checksum_md5, size_bytes,
        width, height, exif, page, density, keep_original)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18)`,
      [newPhotoId, newItemId, newImageId, r['position'], photoKeys.r2_key, photoKeys.thumb_r2_key,
        r['missing_original'], r['original_filename'], r['mimetype'], r['checksum_sha256'],
        r['tpy_checksum_md5'] ?? null, r['size_bytes'], r['width'], r['height'],
        JSON.stringify(r['exif'] ?? {}), r['page'], r['density'] ?? null, r['keep_original']]));
  }
  for (const r of selRows) {
    const newSelId = selIdMap.get(r['subject_id'] as string)!;
    queries.push(qq(`INSERT INTO subjects (id, project_id, kind, template_id) VALUES ($1,$2,'selection',$3)`,
      [newSelId, targetProjectId, sameProject ? ((r['template_id'] as string | null) ?? null) : null]));
    queries.push(qq(`INSERT INTO selections (subject_id, photo_id, name, x, y, width, height, position)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newSelId, photoIdMap.get(r['photo_id'] as string)!, r['name'], r['x'], r['y'], r['width'], r['height'], r['position']]));
  }
  for (const r of metaRows) {
    const newSubject = mapSubject(r['subject_id'] as string);
    if (!newSubject) continue;
    const valueId = randomUUID();
    queries.push(qq(`INSERT INTO metadata_values (value_id, datatype, text, data) VALUES ($1,$2,$3,$4::jsonb)`,
      [valueId, r['datatype'], r['text'], r['data'] ? JSON.stringify(r['data']) : null]));
    queries.push(qq(`INSERT INTO metadata (subject_id, property_uri, value_id, language) VALUES ($1,$2,$3,$4)`,
      [newSubject, r['property_uri'], valueId, (r['language'] as string | null) ?? null]));
  }
  const taggingSeen = new Set<string>();
  for (const r of tagRows) {
    const newSubject = mapSubject(r['subject_id'] as string);
    const newTagId = targetTagIdByName.get((r['name'] as string).toLowerCase());
    if (!newSubject || !newTagId) continue;
    const key = `${newTagId}:${newSubject}`;
    if (taggingSeen.has(key)) continue;
    taggingSeen.add(key);
    queries.push(qq(`INSERT INTO taggings (tag_id, subject_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [newTagId, newSubject]));
  }
  let notesCopied = 0;
  for (const r of noteRows) {
    const newSubject = mapSubject(r['subject_id'] as string);
    if (!newSubject) continue;
    notesCopied += 1;
    queries.push(qq(`INSERT INTO notes (id, subject_id, text, state, language) VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [randomUUID(), newSubject, r['text'], JSON.stringify(r['state'] ?? {}), (r['language'] as string | null) ?? null]));
  }
  if (bytesOriginals || bytesThumbs) {
    queries.push(bumpCountersQuery(targetProjectId, { originals: bytesOriginals, thumbs: bytesThumbs }));
  }
  queries.push(bumpRevQuery(targetProjectId));

  try {
    await tx(() => queries);
  } catch (err) {
    await storage.deleteMany(copiedKeys).catch(() => undefined);
    throw err;
  }

  const rev = await sql()`SELECT rev FROM projects WHERE id = ${targetProjectId}`;
  return {
    item_id: newItemId,
    target_project_id: targetProjectId,
    photos_copied: photoRows.length,
    selections_copied: selRows.length,
    notes_copied: notesCopied,
    rev: Number(rev[0]['rev']),
  };
}
