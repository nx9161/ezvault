// SPDX-License-Identifier: MIT
/**
 * test/merge-plan.test.mjs — row 32 merge semantics, at the pure planning
 * layer (lib/items/merge-plan.ts) the route executes verbatim:
 * union of photos/notes/tags/lists, survivor's metadata wins, empty
 * fields fill from the FIRST source that has them, sources recorded for
 * trash-with-reason-merge + undo.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planMerge } from '../lib/items/merge-plan.ts';

const TITLE = 'http://purl.org/dc/terms/title';
const DATE = 'http://purl.org/dc/terms/date';
const CREATOR = 'http://purl.org/dc/terms/creator';

function item(id, over = {}) {
  return {
    id,
    photos: [],
    noteIds: [],
    tagIds: [],
    listIds: [],
    priorLists: [],
    metadata: [],
    coverImageId: null,
    ...over,
  };
}
const meta = (uri, value_id, language = null) => ({ property_uri: uri, value_id, language });

describe('planMerge (row 32)', () => {
  const target = item('T', {
    photos: [{ subject_id: 'tp1', position: 0, image_id: 'timg1' }],
    noteIds: ['tn1'],
    tagIds: ['tag-a'],
    listIds: ['list-1'],
    priorLists: [{ list_id: 'list-1', position: 2 }],
    metadata: [meta(TITLE, 'v-title-target')],
    coverImageId: 'timg1',
  });
  const src1 = item('S1', {
    photos: [
      { subject_id: 's1p1', position: 0, image_id: 's1img1' },
      { subject_id: 's1p2', position: 5, image_id: 's1img2' },
    ],
    noteIds: ['s1n1'],
    tagIds: ['tag-a', 'tag-b'],
    listIds: ['list-1', 'list-2'],
    priorLists: [{ list_id: 'list-1', position: 0 }, { list_id: 'list-2', position: 1 }],
    metadata: [meta(TITLE, 'v-title-src1'), meta(DATE, 'v-date-src1')],
  });
  const src2 = item('S2', {
    photos: [{ subject_id: 's2p1', position: 0, image_id: 's2img1' }],
    noteIds: ['s2n1', 's2n2'],
    tagIds: ['tag-c'],
    listIds: ['list-3'],
    priorLists: [{ list_id: 'list-3', position: 0 }],
    metadata: [meta(DATE, 'v-date-src2'), meta(CREATOR, 'v-creator-src2')],
  });
  const plan = planMerge(target, [src1, src2]);

  it('unions photos: sources append after the target, order preserved', () => {
    assert.deepEqual(plan.photoMoves, [
      { photo_subject_id: 's1p1', from_item_id: 'S1', from_position: 0, to_position: 1 },
      { photo_subject_id: 's1p2', from_item_id: 'S1', from_position: 5, to_position: 2 },
      { photo_subject_id: 's2p1', from_item_id: 'S2', from_position: 0, to_position: 3 },
    ]);
  });

  it('moves all source item-notes to the target', () => {
    assert.deepEqual(plan.noteMoves, [
      { note_id: 's1n1', from_subject_id: 'S1' },
      { note_id: 's2n1', from_subject_id: 'S2' },
      { note_id: 's2n2', from_subject_id: 'S2' },
    ]);
  });

  it('unions tags and lists without duplicating the target’s own', () => {
    assert.deepEqual(plan.addedTagIds, ['tag-b', 'tag-c']);
    assert.deepEqual(plan.addedListIds, ['list-2', 'list-3']);
  });

  it('metadata: survivor wins; gaps fill from the first source that has them', () => {
    // TITLE: target has it -> no fill. DATE: target lacks it -> src1 (not
    // src2). CREATOR: only src2 has it -> src2.
    assert.deepEqual(plan.metadataFills, [
      { ...meta(DATE, 'v-date-src1'), from_subject_id: 'S1' },
      { ...meta(CREATOR, 'v-creator-src2'), from_subject_id: 'S2' },
    ]);
  });

  it('records each source with its prior lists (trash + undo payload)', () => {
    assert.deepEqual(plan.sources, [
      { id: 'S1', prior_lists: src1.priorLists },
      { id: 'S2', prior_lists: src2.priorLists },
    ]);
  });

  it('keeps the target cover when it has one', () => {
    assert.deepEqual(plan.cover, { before: 'timg1', after: 'timg1' });
  });

  it('falls back to the first moved photo’s image when the target has no cover', () => {
    const bare = item('B', {});
    const p = planMerge(bare, [src1]);
    assert.deepEqual(p.cover, { before: null, after: 's1img1' });
    assert.equal(p.photoMoves[0].to_position, 0);
  });
});
