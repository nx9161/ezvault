// SPDX-License-Identifier: MIT
/**
 * test/merge-copy-wire.test.mjs — row 32 wiring invariants that pure tests
 * cannot reach (the route/lib modules are server-only). Source-level
 * contract checks, in the style of the other *-wire suites:
 *   - merge trashes sources with reason 'merge', stores its inverse in
 *     command_log, and the undo route applies that inverse;
 *   - the client op undoes with the DO op id (not a fresh one);
 *   - copy NEVER reuses a source storage key: originals + thumbs are
 *     copied via storage.copy() to keys.original/keys.thumb under the
 *     TARGET project, and the DB insert takes the NEW keys.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('merge wiring (row 32)', () => {
  const merge = read('lib/items/merge.ts');

  it('trashes sources with reason merge and records prior lists', () => {
    assert.match(merge, /INSERT INTO trash \(subject_id, reason, prior_lists\) VALUES \(\$1,'merge'/);
  });

  it('stores the inverse in command_log under kind items.merge', () => {
    assert.match(merge, /'items\.merge'/);
    assert.match(merge, /added_metadata_ids/);
    assert.match(merge, /photo_moves/);
  });

  it('undo deletes the trash rows and re-files sources to prior lists', () => {
    assert.match(merge, /DELETE FROM trash WHERE subject_id = \$1/);
    assert.match(merge, /INSERT INTO list_items \(list_id, item_id, position\)/);
    assert.match(merge, /undone_at = now\(\)/);
  });

  it('replay vs redo: an undone log row re-runs the merge', () => {
    assert.match(merge, /undone_at/);
    assert.match(merge, /replayed: true/);
  });

  it('client op undoes with the do op id', () => {
    const ops = read('lib/commands/ops.ts');
    const body = ops.slice(ops.indexOf('export function mergeItemsOp'));
    assert.match(body, /items\/merge/);
    assert.match(body, /clientOpId: doOpId/);
    assert.match(body, /merge`\/undo|\/undo`/);
    assert.ok(!body.includes('wave 2'), 'placeholder copy must be gone');
    assert.ok(!body.includes('ships in wave 2'), 'placeholder toast must be gone');
  });

  it('toolbar merge button is enabled (no wave-2 gate remains)', () => {
    const panel = read('components/center/CenterPanel.tsx');
    assert.ok(!panel.includes('mergeWave2'), 'wave-2 merge gate must be gone');
    assert.match(panel, /mergeItemsOp/);
  });
});

describe('copy-to-project wiring (row 32)', () => {
  const copy = read('lib/items/copy.ts');

  it('copies storage objects to FRESH keys under the target project', () => {
    assert.match(copy, /keys\.original\(targetProjectId, newPhotoId, ext\)/);
    assert.match(copy, /keys\.thumb\(targetProjectId, newPhotoId\)/);
    assert.match(copy, /storage\.copy\(oldKey, newKey/);
    assert.match(copy, /storage\.copy\(oldThumb, newThumbKey/);
  });

  it('inserts the NEW keys into the copied photo rows, never the source keys', () => {
    assert.match(copy, /photoKeys\.r2_key, photoKeys\.thumb_r2_key/);
    assert.ok(!/INSERT INTO photos[\s\S]{0,600}r\['r2_key'\]/.test(copy),
      'photo insert must not read the source row keys');
  });

  it('rolls back copied objects when a later step fails', () => {
    assert.match(copy, /storage\.deleteMany\(copiedKeys\)/);
  });

  it('bumps the TARGET project counters and rev', () => {
    assert.match(copy, /bumpCountersQuery\(targetProjectId/);
    assert.match(copy, /bumpRevQuery\(targetProjectId\)/);
  });
});

describe('B2 routes exist', () => {
  it('csv export/import, zip export, merge, merge-undo, copy routes are present', () => {
    for (const p of [
      'app/api/projects/[id]/export/csv/route.ts',
      'app/api/projects/[id]/export/zip/route.ts',
      'app/api/projects/[id]/import/csv/route.ts',
      'app/api/projects/[id]/items/merge/route.ts',
      'app/api/projects/[id]/items/merge/undo/route.ts',
      'app/api/projects/[id]/items/[itemId]/copy/route.ts',
    ]) {
      assert.ok(read(p).includes('handle('), p);
    }
  });

  it('print: Ctrl+P is registered and the print stylesheet has both layouts', () => {
    const registry = read('lib/shortcuts/registry.ts');
    assert.match(registry, /id: "print"/);
    assert.match(registry, /"mod\+p"/);
    const css = read('app/globals.css');
    assert.match(css, /data-print="inspector"/);
    assert.match(css, /data-print="items"/);
    assert.match(css, /@page/);
  });
});
