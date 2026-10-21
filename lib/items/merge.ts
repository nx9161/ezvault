// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/items/merge.ts — item merge + merge-undo (parity row 32).
 *
 * mergeItems(): N sources merge into one surviving target in ONE
 * transaction, planned by the pure lib/items/merge-plan.ts (survivor's
 * metadata wins; empty fields fill from sources in request order; photos /
 * notes / tags / lists union). Sources are trashed with reason `merge`.
 *
 * Undo: the merge writes its full inverse into its command_log payload
 * (keyed by the client op id). undoMerge() applies the inverse in one
 * transaction and stamps undone_at. A redo (same op id, undone_at set)
 * re-runs the merge against the restored state and refreshes the inverse.
 */

import { randomUUID } from 'node:crypto';
import { sql, tx, bumpRevQuery, type TxQuery } from '@/lib/db/index';
import { HttpError } from '@/lib/api/route-utils';
import { planMerge, type MergeItemData, type MergePlan } from './merge-plan';

const qq = (text: string, params?: unknown[]): TxQuery => ({ text, params });

interface MergeInverse {
  target_id: string;
  source_ids: string[];
  photo_moves: MergePlan['photoMoves'];
  note_moves: MergePlan['noteMoves'];
  added_tag_ids: string[];
  added_list_ids: string[];
  added_metadata_ids: string[];
  cover_before: string | null;
  sources: MergePlan['sources'];
}

export interface MergeResult {
  merged_into: string;
  trashed: string[];
  photos_moved: number;
  notes_moved: number;
  rev: number;
  replayed?: boolean;
}

async function loadItemData(projectId: string, ids: string[]): Promise<Map<string, MergeItemData>> {
  const photos = await sql()`SELECT subject_id, item_id, position, image_id FROM photos
    WHERE item_id = ANY(${ids}) ORDER BY item_id, position`;
  const notes = await sql()`SELECT id, subject_id FROM notes
    WHERE subject_id = ANY(${ids}) AND deleted_at IS NULL ORDER BY created_at`;
  const taggings = await sql()`SELECT tag_id, subject_id FROM taggings WHERE subject_id = ANY(${ids})`;
  const memberships = await sql()`SELECT list_id, item_id, position FROM list_items WHERE item_id = ANY(${ids})`;
  const meta = await sql()`SELECT subject_id, property_uri, value_id, language FROM metadata
    WHERE subject_id = ANY(${ids}) ORDER BY created_at`;
  const covers = await sql()`SELECT subject_id, cover_image_id FROM items WHERE subject_id = ANY(${ids})`;

  const data = new Map<string, MergeItemData>();
  for (const id of ids) {
    data.set(id, {
      id,
      photos: [],
      noteIds: [],
      tagIds: [],
      listIds: [],
      priorLists: [],
      metadata: [],
      coverImageId: null,
    });
  }
  for (const r of photos) {
    data.get(r['item_id'] as string)?.photos.push({
      subject_id: r['subject_id'] as string,
      position: Number(r['position']),
      image_id: r['image_id'] as string,
    });
  }
  for (const r of notes) data.get(r['subject_id'] as string)?.noteIds.push(r['id'] as string);
  for (const r of taggings) data.get(r['subject_id'] as string)?.tagIds.push(r['tag_id'] as string);
  for (const r of memberships) {
    const d = data.get(r['item_id'] as string);
    if (!d) continue;
    d.listIds.push(r['list_id'] as string);
    d.priorLists.push({ list_id: r['list_id'] as string, position: Number(r['position']) });
  }
  for (const r of meta) {
    data.get(r['subject_id'] as string)?.metadata.push({
      property_uri: r['property_uri'] as string,
      value_id: r['value_id'] as string,
      language: (r['language'] as string | null) ?? null,
    });
  }
  for (const r of covers) {
    const d = data.get(r['subject_id'] as string);
    if (d) d.coverImageId = (r['cover_image_id'] as string | null) ?? null;
  }
  return data;
}

export async function mergeItems(
  projectId: string,
  targetId: string,
  sourceIds: string[],
  clientOpId?: string,
): Promise<MergeResult> {
  const sources = [...new Set(sourceIds)].filter((x) => x !== targetId);
  if (!sources.length) throw new HttpError(400, 'validation', 'source_ids must name at least one item other than the target');

  // Idempotency / redo: an existing log row decides replay vs redo.
  let redo = false;
  if (clientOpId) {
    const prior = await sql()`SELECT payload, undone_at FROM command_log WHERE op_id = ${clientOpId} AND project_id = ${projectId} AND kind = 'items.merge' LIMIT 1`;
    if (prior.length && !prior[0]['undone_at']) {
      const payload = prior[0]['payload'] as { result?: MergeResult };
      const rev = await sql()`SELECT rev FROM projects WHERE id = ${projectId}`;
      return { ...(payload.result as MergeResult), rev: Number(rev[0]['rev']), replayed: true };
    }
    if (prior.length) redo = true;
  }

  const allIds = [targetId, ...sources];
  const found = await sql()`SELECT s.id FROM subjects s
    WHERE s.project_id = ${projectId} AND s.kind = 'item' AND s.id = ANY(${allIds})
      AND NOT EXISTS (SELECT 1 FROM trash t WHERE t.subject_id = s.id)`;
  const foundSet = new Set(found.map((r) => r['id'] as string));
  const missing = allIds.filter((x) => !foundSet.has(x));
  if (missing.length) {
    throw new HttpError(404, 'not_found', `items not found (or already trashed): ${missing.slice(0, 5).join(',')}`);
  }

  const data = await loadItemData(projectId, allIds);
  const target = data.get(targetId)!;
  const plan = planMerge(target, sources.map((id) => data.get(id)!));

  // Append positions for lists the target joins.
  const listPositions = new Map<string, number>();
  if (plan.addedListIds.length) {
    const rows = await sql()`SELECT list_id, COALESCE(MAX(position), -1) AS max_pos FROM list_items
      WHERE list_id = ANY(${plan.addedListIds}) GROUP BY list_id`;
    for (const r of rows) listPositions.set(r['list_id'] as string, Number(r['max_pos']) + 1);
    for (const listId of plan.addedListIds) if (!listPositions.has(listId)) listPositions.set(listId, 0);
  }

  const addedMetadataIds: string[] = [];
  const queries: TxQuery[] = [];
  for (const move of plan.photoMoves) {
    queries.push(qq(`UPDATE photos SET item_id = $2, position = $3 WHERE subject_id = $1`,
      [move.photo_subject_id, targetId, move.to_position]));
  }
  for (const move of plan.noteMoves) {
    queries.push(qq(`UPDATE notes SET subject_id = $2, updated_at = now() WHERE id = $1`, [move.note_id, targetId]));
  }
  for (const tagId of plan.addedTagIds) {
    queries.push(qq(`INSERT INTO taggings (tag_id, subject_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [tagId, targetId]));
  }
  for (const listId of plan.addedListIds) {
    queries.push(qq(`INSERT INTO list_items (list_id, item_id, position) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [listId, targetId, listPositions.get(listId) ?? 0]));
  }
  for (const fill of plan.metadataFills) {
    const metaId = randomUUID();
    addedMetadataIds.push(metaId);
    queries.push(qq(`INSERT INTO metadata (id, subject_id, property_uri, value_id, language) VALUES ($1,$2,$3,$4,$5)`,
      [metaId, targetId, fill.property_uri, fill.value_id, fill.language]));
  }
  if (plan.cover.after !== plan.cover.before) {
    queries.push(qq(`UPDATE items SET cover_image_id = $2 WHERE subject_id = $1`, [targetId, plan.cover.after]));
  }
  for (const src of plan.sources) {
    queries.push(qq(`INSERT INTO trash (subject_id, reason, prior_lists) VALUES ($1,'merge',$2::jsonb)
      ON CONFLICT (subject_id) DO UPDATE SET reason = EXCLUDED.reason, deleted_at = now()`,
      [src.id, JSON.stringify(src.prior_lists)]));
    queries.push(qq(`DELETE FROM list_items WHERE item_id = $1`, [src.id]));
  }
  queries.push(qq(`UPDATE subjects SET updated_at = now() WHERE id = ANY($1)`, [allIds]));
  queries.push(bumpRevQuery(projectId));

  const result: MergeResult = {
    merged_into: targetId,
    trashed: sources,
    photos_moved: plan.photoMoves.length,
    notes_moved: plan.noteMoves.length,
    rev: 0, // filled after the tx from the projects row
  };
  const inverse: MergeInverse = {
    target_id: targetId,
    source_ids: sources,
    photo_moves: plan.photoMoves,
    note_moves: plan.noteMoves,
    added_tag_ids: plan.addedTagIds,
    added_list_ids: plan.addedListIds,
    added_metadata_ids: addedMetadataIds,
    cover_before: plan.cover.before,
    sources: plan.sources,
  };
  if (clientOpId) {
    const payload = JSON.stringify({ target_id: targetId, source_ids: sources, inverse, result });
    queries.push(redo
      ? qq(`UPDATE command_log SET payload = $3::jsonb, undone_at = NULL WHERE project_id = $1 AND op_id = $2`, [projectId, clientOpId, payload])
      : qq(`INSERT INTO command_log (project_id, op_id, kind, payload) VALUES ($1,$2,'items.merge',$3::jsonb)
          ON CONFLICT (op_id) DO NOTHING`, [projectId, clientOpId, payload]));
  }
  await tx(() => queries);
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${projectId}`;
  return { ...result, rev: Number(rev[0]['rev']) };
}

export async function undoMerge(projectId: string, clientOpId: string): Promise<{ restored: string[]; rev: number }> {
  const rows = await sql()`SELECT payload, undone_at FROM command_log
    WHERE op_id = ${clientOpId} AND project_id = ${projectId} AND kind = 'items.merge' LIMIT 1`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'merge command not found');
  if (rows[0]['undone_at']) {
    const rev = await sql()`SELECT rev FROM projects WHERE id = ${projectId}`;
    return { restored: [], rev: Number(rev[0]['rev']) };
  }
  const payload = rows[0]['payload'] as { inverse?: MergeInverse };
  const inv = payload.inverse;
  if (!inv) throw new HttpError(422, 'unprocessable', 'merge command carries no inverse');

  const queries: TxQuery[] = [];
  for (const move of inv.photo_moves) {
    queries.push(qq(`UPDATE photos SET item_id = $2, position = $3 WHERE subject_id = $1`,
      [move.photo_subject_id, move.from_item_id, move.from_position]));
  }
  for (const move of inv.note_moves) {
    queries.push(qq(`UPDATE notes SET subject_id = $2, updated_at = now() WHERE id = $1`, [move.note_id, move.from_subject_id]));
  }
  for (const tagId of inv.added_tag_ids) {
    queries.push(qq(`DELETE FROM taggings WHERE tag_id = $1 AND subject_id = $2`, [tagId, inv.target_id]));
  }
  for (const listId of inv.added_list_ids) {
    queries.push(qq(`DELETE FROM list_items WHERE list_id = $1 AND item_id = $2`, [listId, inv.target_id]));
  }
  if (inv.added_metadata_ids.length) {
    queries.push(qq(`DELETE FROM metadata WHERE id = ANY($1)`, [inv.added_metadata_ids]));
  }
  queries.push(qq(`UPDATE items SET cover_image_id = $2 WHERE subject_id = $1`, [inv.target_id, inv.cover_before]));
  for (const src of inv.sources) {
    queries.push(qq(`DELETE FROM trash WHERE subject_id = $1`, [src.id]));
    for (const pl of src.prior_lists) {
      queries.push(qq(`INSERT INTO list_items (list_id, item_id, position) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [pl.list_id, src.id, pl.position]));
    }
  }
  queries.push(qq(`UPDATE subjects SET updated_at = now() WHERE id = ANY($1)`, [[inv.target_id, ...inv.source_ids]]));
  queries.push(qq(`UPDATE command_log SET undone_at = now() WHERE op_id = $1`, [clientOpId]));
  queries.push(bumpRevQuery(projectId));
  await tx(() => queries);
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${projectId}`;
  return { restored: inv.source_ids, rev: Number(rev[0]['rev']) };
}
