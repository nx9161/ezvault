// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/iiif/import.ts — IIIF manifest import orchestration (row 26).
 *
 * Flow: SSRF-guarded manifest fetch (lib/fetch-guard.ts — https only, no
 * private/loopback targets, redirects re-validated) -> parse
 * (lib/iiif/manifest.ts, Presentation v2 + v3) -> one item per canvas in
 * a list named from the manifest label -> image bytes harvested
 * server-side through the SAME pipeline as any upload: guarded fetch ->
 * magic-byte verify (lib/import/magic.ts) -> staged object -> photo rows
 * (lib/import/photos.ts) -> processPhoto (thumbnails, counters, rev).
 *
 * Metadata: manifest label/description/metadata pairs are applied to
 * every canvas item via the chosen template — a pair maps when its label
 * matches a template field label or property local name (case
 * insensitive), or when the pair label IS a property URI the template
 * carries. The canvas label becomes the title field when the template
 * has one. Unmapped pairs are preserved verbatim in an item note (the
 * JSON-LD import's never-drop convention, lib/import/jsonld-accept.ts).
 *
 * Failure semantics (Wave D fix, finding 4): the per-canvas item is
 * removed again when its image harvest fails or its photo dedupes —
 * failed canvases leave nothing behind, and deduped canvases count as
 * `skipped` in the job report, never as `imported`.
 */

import { createHash, randomUUID } from 'node:crypto';
import { sql, tx, bumpRevQuery, type TxQuery } from '../db/index';
import { HttpError } from '../api/route-utils';
import { guardedFetchBytes, SsrfError } from '../fetch-guard';
import { parseIiifManifest, planHarvest, mapManifestMetadata, type IiifManifest, type TemplateFieldLite } from './manifest';
import { detectFormat, mimetypeForFormat } from '../import/magic';
import { MAX_PHOTO_BYTES } from '../import/validation';
import { createPhotoRows } from '../import/photos';
import { processPhoto } from '../import/process-photo';
import { getStorageDriver, keys, extForMimetype } from '../storage/driver';

const MANIFEST_MAX_BYTES = 5 * 1024 * 1024;

function noteStateFor(lines: string[]): Record<string, unknown> {
  return {
    type: 'doc',
    content: lines.map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}

async function resolveTemplateId(projectId: string, requested?: string | null): Promise<{ id: string; fields: TemplateFieldLite[] }> {
  if (requested) {
    const rows = await sql()`SELECT id, fields FROM templates WHERE id = ${requested} AND project_id = ${projectId}`;
    if (!rows.length) throw new HttpError(400, 'validation', 'template not found in this project');
    return { id: rows[0]['id'] as string, fields: (rows[0]['fields'] as TemplateFieldLite[]) ?? [] };
  }
  const project = await sql()`SELECT default_template_id FROM projects WHERE id = ${projectId}`;
  const defaultId = project[0]?.['default_template_id'] as string | null;
  if (defaultId) {
    const rows = await sql()`SELECT id, fields FROM templates WHERE id = ${defaultId} AND project_id = ${projectId}`;
    if (rows.length) return { id: rows[0]['id'] as string, fields: (rows[0]['fields'] as TemplateFieldLite[]) ?? [] };
  }
  const existing = await sql()`SELECT id, fields FROM templates WHERE project_id = ${projectId} AND name = 'Generic' LIMIT 1`;
  if (existing.length) return { id: existing[0]['id'] as string, fields: (existing[0]['fields'] as TemplateFieldLite[]) ?? [] };
  const created = await sql()`INSERT INTO templates (project_id, name, fields) VALUES (${projectId}, 'Generic', '[]'::jsonb) RETURNING id, fields`;
  return { id: created[0]['id'] as string, fields: [] };
}

export interface IiifImportResult {
  job_id: string;
  list_id: string;
  manifest_label: string;
  version: 2 | 3;
  imported: number;
  /** Canvases whose photo deduped against an existing photo — SKIPPED, not imported. */
  skipped: number;
  failed: number;
  results: { canvas_id: string; title: string; status: 'imported' | 'duplicate' | 'failed'; item_id?: string; error?: string }[];
}

export async function importIiifManifest(
  projectId: string,
  manifestUrl: string,
  opts: { templateId?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<IiifImportResult> {
  let manifest: IiifManifest;
  try {
    const fetched = await guardedFetchBytes(manifestUrl, {
      maxBytes: MANIFEST_MAX_BYTES,
      fetchImpl: opts.fetchImpl ? (u, i) => opts.fetchImpl!(u, i) : undefined,
      headers: { accept: 'application/ld+json, application/json' },
    });
    manifest = parseIiifManifest(JSON.parse(fetched.bytes.toString('utf8')));
  } catch (err) {
    if (err instanceof SsrfError) throw new HttpError(400, 'ssrf_rejected', err.message);
    if (err instanceof SyntaxError) throw new HttpError(400, 'validation', 'manifest response is not valid JSON');
    throw err;
  }

  const template = await resolveTemplateId(projectId, opts.templateId);
  const plan = planHarvest(manifest);
  const jobId = randomUUID();
  const listId = randomUUID();
  const storage = await getStorageDriver();

  await tx((q: (text: string, params?: unknown[]) => TxQuery) => [
    q(`INSERT INTO import_jobs (id, project_id, kind, status, total) VALUES ($1,$2,'iiif','running',$3)`, [jobId, projectId, plan.length]),
    q(`INSERT INTO lists (id, project_id, name, position) VALUES ($1,$2,$3,(SELECT COALESCE(MAX(position)+1,0) FROM lists WHERE project_id=$2))`,
      [listId, projectId, manifest.label.slice(0, 200)]),
    bumpRevQuery(projectId),
  ]);

  const results: IiifImportResult['results'] = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of plan) {
    const itemId = randomUUID();
    // Set once the item+note transaction commits: from then on, ANY
    // failure (or a duplicate photo) must remove the pre-created item —
    // a failed/skipped canvas never leaves a photo-less item behind
    // (Wave D fix, finding 4; deleting the subject cascades to items,
    // metadata, notes, list membership and any photo rows).
    let itemCommitted = false;
    const cleanupItem = async () => {
      if (!itemCommitted) return;
      await tx((q: (text: string, params?: unknown[]) => TxQuery) => [
        q(`DELETE FROM subjects WHERE id = $1`, [itemId]),
        bumpRevQuery(projectId),
      ]).catch(() => { /* best effort — the job report still carries the failure */ });
    };
    try {
      // Item + template-mapped metadata + preservation note (one txn).
      const { values, unmapped } = mapManifestMetadata(manifest, entry.title, template.fields);
      const queries: TxQuery[] = [];
      const q = (text: string, params?: unknown[]): TxQuery => ({ text, params });
      queries.push(q(`INSERT INTO subjects (id, project_id, kind, template_id) VALUES ($1,$2,'item',$3)`, [itemId, projectId, template.id]));
      queries.push(q(`INSERT INTO items (subject_id) VALUES ($1)`, [itemId]));
      for (const v of values) {
        const valueId = randomUUID();
        queries.push(q(`INSERT INTO metadata_values (value_id, datatype, text) VALUES ($1,$2,$3)`, [valueId, v.datatype, v.text.slice(0, 100_000)]));
        queries.push(q(`INSERT INTO metadata (subject_id, property_uri, value_id) VALUES ($1,$2,$3)`, [itemId, v.property_uri, valueId]));
      }
      const noteLines: string[] = [];
      if (unmapped.length) {
        noteLines.push('Unmapped IIIF manifest metadata:');
        for (const p of unmapped) noteLines.push(`${p.label}: ${p.value}`);
      }
      noteLines.push(`Imported from IIIF manifest: ${manifestUrl}`);
      queries.push(q(`INSERT INTO notes (subject_id, text, state) VALUES ($1,$2,$3::jsonb)`,
        [itemId, noteLines.join('\n').slice(0, 100_000), JSON.stringify(noteStateFor(noteLines))]));
      queries.push(bumpRevQuery(projectId));
      await tx(() => queries);
      itemCommitted = true;

      // Harvest the canvas image through the standard upload pipeline.
      const fetched = await guardedFetchBytes(entry.imageUrl, {
        maxBytes: MAX_PHOTO_BYTES,
        fetchImpl: opts.fetchImpl ? (u, i) => opts.fetchImpl!(u, i) : undefined,
      });
      const format = detectFormat(fetched.bytes.subarray(0, 16 * 1024));
      if (!format) throw new Error('harvested bytes are not a recognized image format (magic-byte check failed)');
      const mimetype = mimetypeForFormat(format);
      const sha256 = createHash('sha256').update(fetched.bytes).digest('hex');
      const stagedKey = keys.upload(jobId, randomUUID(), extForMimetype(mimetype));
      await storage.putBytes(stagedKey, fetched.bytes, { contentType: mimetype });
      const [created] = await createPhotoRows(projectId, jobId, [{
        originalFilename: entry.filename,
        mimetype,
        checksumSha256: sha256,
        sizeBytes: fetched.bytes.length,
        width: entry.width ?? 0,
        height: entry.height ?? 0,
        listId,
      }], { itemId, duplicatePolicy: 'skip' });
      if (created.dedupe === 'skipped_duplicate') {
        // Duplicate: the photo already exists in the project, so this
        // canvas adds nothing — count it as SKIPPED (not imported) and
        // remove the pre-created item (the bytes live on the existing
        // photo's item, untouched).
        await cleanupItem();
        results.push({ canvas_id: entry.canvasId, title: entry.title, status: 'duplicate' });
        await sql()`UPDATE import_jobs SET done = done + 1, updated_at = now() WHERE id = ${jobId}`;
        skipped++;
        continue;
      }
      await processPhoto({
        jobId, projectId,
        photoSubjectId: created.subjectId,
        itemId,
        originalFilename: entry.filename,
        mimetype,
        checksumSha256: sha256,
        stagedKey,
        splitPages: false,
      });
      results.push({ canvas_id: entry.canvasId, title: entry.title, status: 'imported', item_id: itemId });
      imported++;
      await sql()`UPDATE import_jobs SET done = done + 1, updated_at = now() WHERE id = ${jobId}`;
    } catch (err) {
      const message = err instanceof SsrfError ? err.message
        : err instanceof HttpError ? err.message
        : err instanceof Error ? err.message : String(err);
      // Failed harvest: remove the pre-created item + note so the
      // project is left exactly as if this canvas never ran.
      await cleanupItem();
      results.push({ canvas_id: entry.canvasId, title: entry.title, status: 'failed', error: message.slice(0, 1000) });
      failed++;
      await sql()`UPDATE import_jobs SET failed = failed + 1, updated_at = now() WHERE id = ${jobId}`;
    }
  }

  const status = failed === 0 ? 'done' : imported > 0 ? 'done' : 'failed';
  await sql()`UPDATE import_jobs SET status = ${status}, report = ${JSON.stringify({ manifest_url: manifestUrl, list_id: listId, label: manifest.label, results })}::jsonb,
    error = ${failed ? `${failed} canvas(es) failed to import` : null}, updated_at = now() WHERE id = ${jobId}`;
  return { job_id: jobId, list_id: listId, manifest_label: manifest.label, version: manifest.version, imported, skipped, failed, results };
}
