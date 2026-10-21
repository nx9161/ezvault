// SPDX-License-Identifier: MIT
/**
 * lib/items/merge-plan.ts — pure merge planning (parity row 32).
 *
 * The merge rule (also in CONTRACT.md, binding): N source items merge into
 * ONE surviving target item.
 *   - photos: union — sources' photos append after the target's, each
 *     source's internal order preserved, sources taken in request order.
 *     Selections ride along (they key off photos, never items).
 *   - notes: the sources' item-level notes move to the target (photo and
 *     selection notes stay on their own subjects, which move with photos).
 *   - tags / lists: union — the target gains every tag and list membership
 *     the sources had that it lacked.
 *   - metadata: the survivor's values WIN. A property the target lacks is
 *     filled with ALL values from the first source (in request order) that
 *     has it. Nothing on the target is ever overwritten or duplicated.
 *   - cover: the target keeps its cover; if it has none, the first moved
 *     photo's image becomes the cover.
 *   - sources are trashed with reason `merge` (their prior list memberships
 *     are recorded so trash-restore and merge-undo can re-file them).
 *
 * This module is pure data-in/data-out: the route loads rows, asks for the
 * plan, then turns the plan into ONE transaction + the undo inverse.
 */

export interface MergeMetaRow {
  property_uri: string;
  value_id: string;
  language: string | null;
}

export interface MergeItemData {
  id: string;
  /** ordered by position */
  photos: { subject_id: string; position: number; image_id: string }[];
  /** item-level note ids */
  noteIds: string[];
  tagIds: string[];
  listIds: string[];
  /** list memberships with positions (recorded into trash on merge) */
  priorLists: { list_id: string; position: number }[];
  metadata: MergeMetaRow[];
  coverImageId: string | null;
}

export interface MergePlan {
  photoMoves: {
    photo_subject_id: string;
    from_item_id: string;
    from_position: number;
    to_position: number;
  }[];
  noteMoves: { note_id: string; from_subject_id: string }[];
  /** tag ids the target gains */
  addedTagIds: string[];
  /** list ids the target joins */
  addedListIds: string[];
  /** metadata rows copied onto the target (new link rows, shared values) */
  metadataFills: (MergeMetaRow & { from_subject_id: string })[];
  cover: { before: string | null; after: string | null };
  sources: { id: string; prior_lists: { list_id: string; position: number }[] }[];
}

export function planMerge(target: MergeItemData, sources: readonly MergeItemData[]): MergePlan {
  const photoMoves: MergePlan['photoMoves'] = [];
  let nextPosition = target.photos.length
    ? Math.max(...target.photos.map((p) => p.position)) + 1
    : 0;
  for (const src of sources) {
    for (const photo of src.photos) {
      photoMoves.push({
        photo_subject_id: photo.subject_id,
        from_item_id: src.id,
        from_position: photo.position,
        to_position: nextPosition++,
      });
    }
  }

  const noteMoves: MergePlan['noteMoves'] = [];
  for (const src of sources) {
    for (const noteId of src.noteIds) {
      noteMoves.push({ note_id: noteId, from_subject_id: src.id });
    }
  }

  const targetTags = new Set(target.tagIds);
  const addedTagIds: string[] = [];
  for (const src of sources) {
    for (const tagId of src.tagIds) {
      if (!targetTags.has(tagId)) {
        targetTags.add(tagId);
        addedTagIds.push(tagId);
      }
    }
  }

  const targetLists = new Set(target.listIds);
  const addedListIds: string[] = [];
  for (const src of sources) {
    for (const listId of src.listIds) {
      if (!targetLists.has(listId)) {
        targetLists.add(listId);
        addedListIds.push(listId);
      }
    }
  }

  const targetProps = new Set(target.metadata.map((m) => m.property_uri));
  const filledProps = new Set<string>();
  const metadataFills: MergePlan['metadataFills'] = [];
  for (const src of sources) {
    const byProp = new Map<string, MergeMetaRow[]>();
    for (const row of src.metadata) {
      if (!byProp.has(row.property_uri)) byProp.set(row.property_uri, []);
      byProp.get(row.property_uri)!.push(row);
    }
    for (const [uri, rows] of byProp) {
      if (targetProps.has(uri) || filledProps.has(uri)) continue;
      filledProps.add(uri);
      for (const row of rows) metadataFills.push({ ...row, from_subject_id: src.id });
    }
  }

  const firstMovedPhoto = photoMoves.length
    ? sources
        .flatMap((s) => s.photos)
        .find((p) => p.subject_id === photoMoves[0].photo_subject_id)
    : undefined;
  const coverAfter = target.coverImageId ?? firstMovedPhoto?.image_id ?? null;

  return {
    photoMoves,
    noteMoves,
    addedTagIds,
    addedListIds,
    metadataFills,
    cover: { before: target.coverImageId, after: coverAfter },
    sources: sources.map((s) => ({ id: s.id, prior_lists: s.priorLists })),
  };
}
