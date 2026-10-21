// SPDX-License-Identifier: MIT
/**
 * lib/items/copy-plan.ts — pure planning helpers for item copy (row 32).
 *
 * Framework-free (no server-only, no DB): lib/items/copy.ts loads rows,
 * asks this module for the plan, then executes it. Kept separate so the
 * transcription-copy and bulk-aggregation rules are unit-testable with
 * fake storage / fake copy functions (test/copy-transcriptions.test.mjs).
 *
 * Transcription copy rule (row 32 fix, 2026-10-21): when a photo is
 * copied, every NON-DELETED transcription row of its image is copied to
 * the NEW image id — text/config/status/angle/mirror/words/page
 * geometry verbatim, a FRESH row id, and, when the source row has an
 * ALTO object, that object is copied in storage to the new row's key
 * (`keys.transcription(targetProjectId, newId)`) so the copy stays
 * delete-independent like everything else in the copy. The copied keys
 * join the copy's shared rollback list: any later failure deletes them.
 */

import { keys } from '@/lib/storage/driver';

export interface SourceTranscriptionRow {
  id: string;
  image_id: string;
  text: string;
  alto_r2_key: string | null;
  config: unknown;
  status: string;
  angle: number | string;
  mirror: boolean;
  words: unknown;
  page_width: number | null;
  page_height: number | null;
}

export interface PlannedTranscriptionCopy {
  source_id: string;
  /** fresh row id for the copied transcription */
  new_id: string;
  /** the NEW image id (from the copy's image id map) */
  new_image_id: string;
  text: string;
  /** storage key of the source ALTO object, or null when none stored */
  source_alto_key: string | null;
  /** fresh ALTO key under the target project, or null when none stored */
  alto_r2_key: string | null;
  config: unknown;
  status: string;
  angle: number | string;
  mirror: boolean;
  words: unknown;
  page_width: number | null;
  page_height: number | null;
}

/**
 * Plan the transcription copies for a set of source rows. Rows whose
 * image is not in the copy's image map are skipped (defensive: the
 * caller loads rows by the source image ids, so this should not fire).
 * `newId` is injected so tests can be deterministic.
 */
export function planTranscriptionCopies(
  rows: readonly SourceTranscriptionRow[],
  imageIdMap: ReadonlyMap<string, string>,
  targetProjectId: string,
  newId: () => string,
): PlannedTranscriptionCopy[] {
  const planned: PlannedTranscriptionCopy[] = [];
  for (const r of rows) {
    const newImageId = imageIdMap.get(r.image_id);
    if (!newImageId) continue;
    const newTranscriptionId = newId();
    planned.push({
      source_id: r.id,
      new_id: newTranscriptionId,
      new_image_id: newImageId,
      text: r.text,
      source_alto_key: r.alto_r2_key ?? null,
      alto_r2_key: r.alto_r2_key ? keys.transcription(targetProjectId, newTranscriptionId) : null,
      config: r.config ?? {},
      status: r.status,
      angle: r.angle,
      mirror: r.mirror,
      words: r.words ?? [],
      page_width: r.page_width ?? null,
      page_height: r.page_height ?? null,
    });
  }
  return planned;
}

/** Minimal storage surface the transcription object copy needs. */
export interface CopyStorage {
  copy(srcKey: string, destKey: string, opts?: { contentType?: string }): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
}

/**
 * Copy every planned ALTO object to its fresh key, appending each new
 * key to the caller's shared `copiedKeys` rollback list. Throws on the
 * first failure — the caller rolls back `copiedKeys` (originals,
 * thumbs AND transcription objects) exactly like its other copies.
 */
export async function copyTranscriptionObjects(
  planned: readonly PlannedTranscriptionCopy[],
  storage: CopyStorage,
  copiedKeys: string[],
): Promise<void> {
  for (const p of planned) {
    if (!p.source_alto_key || !p.alto_r2_key) continue;
    await storage.copy(p.source_alto_key, p.alto_r2_key, { contentType: 'application/xml' });
    copiedKeys.push(p.alto_r2_key);
  }
}

/** Roll back every copied storage object; never throws (best effort). */
export async function rollbackCopiedObjects(
  storage: CopyStorage,
  copiedKeys: readonly string[],
): Promise<void> {
  if (copiedKeys.length === 0) return;
  await storage.deleteMany([...copiedKeys]).catch(() => undefined);
}

/** Positional params for one planned transcription INSERT (see copy.ts). */
export function transcriptionInsertParams(p: PlannedTranscriptionCopy): unknown[] {
  return [
    p.new_id,
    p.new_image_id,
    p.text,
    p.alto_r2_key,
    JSON.stringify(p.config ?? {}),
    p.status,
    p.angle,
    p.mirror,
    JSON.stringify(p.words ?? []),
    p.page_width,
    p.page_height,
  ];
}

// ---------------------------------------------------------------------------
// Bulk copy aggregation (row 32 fix): copy N items one by one; a failure
// on one item is recorded with its reason and does NOT stop the rest —
// the caller reports honest copied/failed counts, never silent drops.
// ---------------------------------------------------------------------------

export interface BulkCopyFailure {
  item_id: string;
  error: string;
}

export interface BulkCopyOutcome<R> {
  copied: { source_item_id: string; result: R }[];
  failed: BulkCopyFailure[];
}

export async function runBulkCopy<R>(
  itemIds: readonly string[],
  copyOne: (itemId: string) => Promise<R>,
): Promise<BulkCopyOutcome<R>> {
  const copied: BulkCopyOutcome<R>['copied'] = [];
  const failed: BulkCopyFailure[] = [];
  const seen = new Set<string>();
  for (const itemId of itemIds) {
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    try {
      const result = await copyOne(itemId);
      copied.push({ source_item_id: itemId, result });
    } catch (err) {
      failed.push({
        item_id: itemId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { copied, failed };
}
