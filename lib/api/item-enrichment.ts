// SPDX-License-Identifier: MIT
import 'server-only';
// Batched read-model enrichment for item listings.
//
// A2 discipline: every export here runs a FIXED number of queries
// regardless of page size — no per-item queries, ever. Callers pass the
// whole page's ids at once.

import { sql } from '@/lib/db/index';

/** Dublin Core property URIs recognized as the template title field. */
const TITLE_URIS = new Set(
  ['http://purl.org/dc/terms/title', 'http://purl.org/dc/elements/1.1/title'].map((u) =>
    u.toLowerCase(),
  ),
);

interface TemplateField {
  property_uri?: string;
  label?: string;
  order?: number;
}

function pickTitlePropertyUri(fields: TemplateField[] | null): string | null {
  if (!Array.isArray(fields) || !fields.length) return null;
  const ci = (s: string | undefined) => (s ?? '').toLowerCase();
  const byUri = fields.find((f) => TITLE_URIS.has(ci(f.property_uri)));
  if (byUri?.property_uri) return byUri.property_uri;
  const byLabel = fields.find((f) => ci(f.label) === 'title');
  if (byLabel?.property_uri) return byLabel.property_uri;
  const ordered = [...fields].sort(
    (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER),
  );
  return ordered[0]?.property_uri ?? null;
}

/**
 * Display titles for a batch of item subject ids.
 * Title = the metadata value for the item's template's title field
 * (Dublin Core title property, else a 'Title'-labelled field, else the
 * first field by order). Items without a title field or value map to null.
 */
export async function resolveItemTitles(
  subjectIds: string[],
): Promise<Map<string, string | null>> {
  const titles = new Map<string, string | null>();
  if (!subjectIds.length) return titles;

  const subjects = await sql()`SELECT id, template_id FROM subjects
    WHERE id = ANY(${subjectIds})`;
  const byTemplate = new Map<string, string[]>();
  const templateIds: string[] = [];
  for (const r of subjects) {
    const tid = r['template_id'] as string | null;
    const sid = r['id'] as string;
    if (!tid) continue;
    if (!byTemplate.has(tid)) {
      byTemplate.set(tid, []);
      templateIds.push(tid);
    }
    byTemplate.get(tid)!.push(sid);
  }
  if (!templateIds.length) return titles;

  const titleUris: string[] = [];
  const templateTitleUri = new Map<string, string | null>();
  const trows = await sql()`SELECT id, fields FROM templates WHERE id = ANY(${templateIds})`;
  for (const r of trows) {
    const uri = pickTitlePropertyUri(r['fields'] as TemplateField[] | null);
    templateTitleUri.set(r['id'] as string, uri);
    if (uri) titleUris.push(uri);
  }
  if (!titleUris.length) return titles;

  // One grouped pass for the whole batch: first non-empty value per
  // subject, oldest metadata row wins (Tropy parity — the original value).
  const mrows = await sql()`SELECT m.subject_id, m.property_uri, mv.text
    FROM metadata m JOIN metadata_values mv ON mv.value_id = m.value_id
    WHERE m.subject_id = ANY(${subjectIds}) AND m.property_uri = ANY(${titleUris})
    ORDER BY m.created_at`;
  for (const r of mrows) {
    const sid = r['subject_id'] as string;
    if (titles.has(sid)) continue;
    const text = (r['text'] as string ?? '').trim();
    if (text) titles.set(sid, text);
  }
  // Templates whose title field produced no value: explicit null (wire
  // contract — the adapter falls back to a short-id label).
  return titles;
}

/**
 * First photo's image_id per item (lowest photos.position, then oldest).
 * Missing -> absent from the map. Callers resolve
 * cover = stored cover_image_id ?? this map ?? null.
 */
export async function resolveItemCovers(
  subjectIds: string[],
): Promise<Map<string, string>> {
  const covers = new Map<string, string>();
  if (!subjectIds.length) return covers;
  const rows = await sql()`SELECT DISTINCT ON (p.item_id) p.item_id, p.image_id
    FROM photos p WHERE p.item_id = ANY(${subjectIds})
    ORDER BY p.item_id, p.position, p.created_at`;
  for (const r of rows) covers.set(r['item_id'] as string, r['image_id'] as string);
  return covers;
}
