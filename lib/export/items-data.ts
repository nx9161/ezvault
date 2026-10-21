// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/export/items-data.ts — shared loader for the CSV / ZIP exports
 * (rows 23/24). Fixed query count regardless of selection size (A2
 * discipline): items, templates, item-level metadata, photos.
 *
 * Trashed items are EXCLUDED from user-facing exports (an archive is a
 * snapshot of the live collection; trash has its own restore/empty flow).
 */

import { sql } from '@/lib/db/index';
import type { CsvItemData, CsvTemplateField } from './csv-export';

export interface ExportPhoto {
  subject_id: string;
  item_id: string;
  r2_key: string | null;
  original_filename: string;
  mimetype: string;
  size_bytes: number;
  checksum_sha256: string;
  missing_original: boolean;
}

export interface ExportItemBundle {
  csv: CsvItemData;
  photos: ExportPhoto[];
}

interface TemplateRow {
  id: string;
  uri: string | null;
  fields: CsvTemplateField[];
}

export async function loadExportItems(
  projectId: string,
  itemIds?: readonly string[],
): Promise<ExportItemBundle[]> {
  const filter = itemIds?.length ? itemIds : null;
  const items = filter
    ? await sql()`SELECT s.id AS subject_id, s.template_id
        FROM subjects s JOIN items i ON i.subject_id = s.id
        WHERE s.project_id = ${projectId} AND s.kind = 'item'
          AND s.id = ANY(${[...filter]})
          AND NOT EXISTS (SELECT 1 FROM trash t WHERE t.subject_id = s.id)
        ORDER BY s.created_at`
    : await sql()`SELECT s.id AS subject_id, s.template_id
        FROM subjects s JOIN items i ON i.subject_id = s.id
        WHERE s.project_id = ${projectId} AND s.kind = 'item'
          AND NOT EXISTS (SELECT 1 FROM trash t WHERE t.subject_id = s.id)
        ORDER BY s.created_at`;
  if (!items.length) return [];

  const ids = items.map((r) => r['subject_id'] as string);

  const tplRows = await sql()`SELECT id, uri, fields FROM templates WHERE project_id = ${projectId}`;
  const tplById = new Map<string, TemplateRow>(
    tplRows.map((t) => [
      t['id'] as string,
      {
        id: t['id'] as string,
        uri: (t['uri'] as string | null) ?? null,
        fields: Array.isArray(t['fields']) ? (t['fields'] as CsvTemplateField[]) : [],
      },
    ]),
  );

  const metaRows = await sql()`SELECT m.subject_id, m.property_uri, v.text
    FROM metadata m JOIN metadata_values v ON v.value_id = m.value_id
    WHERE m.subject_id = ANY(${ids})
    ORDER BY m.created_at`;
  const metaBySubject = new Map<string, Map<string, string[]>>();
  for (const r of metaRows) {
    const sid = r['subject_id'] as string;
    if (!metaBySubject.has(sid)) metaBySubject.set(sid, new Map());
    const byProp = metaBySubject.get(sid)!;
    const uri = r['property_uri'] as string;
    if (!byProp.has(uri)) byProp.set(uri, []);
    byProp.get(uri)!.push(r['text'] as string);
  }

  const photoRows = await sql()`SELECT p.subject_id, p.item_id, p.r2_key,
      p.original_filename, p.mimetype, p.size_bytes, p.checksum_sha256, p.missing_original
    FROM photos p
    WHERE p.item_id = ANY(${ids})
    ORDER BY p.item_id, p.position`;
  const photosByItem = new Map<string, ExportPhoto[]>();
  for (const r of photoRows) {
    const itemId = r['item_id'] as string;
    if (!photosByItem.has(itemId)) photosByItem.set(itemId, []);
    photosByItem.get(itemId)!.push({
      subject_id: r['subject_id'] as string,
      item_id: itemId,
      r2_key: (r['r2_key'] as string | null) ?? null,
      original_filename: r['original_filename'] as string,
      mimetype: r['mimetype'] as string,
      size_bytes: Number(r['size_bytes']),
      checksum_sha256: r['checksum_sha256'] as string,
      missing_original: Boolean(r['missing_original']),
    });
  }

  return items.map((r) => {
    const sid = r['subject_id'] as string;
    const tpl = r['template_id'] ? tplById.get(r['template_id'] as string) : undefined;
    return {
      csv: {
        id: sid,
        templateUri: tpl?.uri ?? null,
        templateFields: tpl?.fields ?? [],
        metadata: metaBySubject.get(sid) ?? new Map(),
      },
      photos: photosByItem.get(sid) ?? [],
    };
  });
}
