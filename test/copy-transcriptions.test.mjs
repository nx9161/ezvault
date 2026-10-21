// SPDX-License-Identifier: MIT
/**
 * test/copy-transcriptions.test.mjs — row 32 fix (2026-10-21).
 *
 *   FIX 1 — copy carries transcriptions:
 *     - the pure planner (lib/items/copy-plan.ts) maps every source
 *       transcription row onto the NEW image id, verbatim fields, fresh
 *       row id, and a fresh ALTO key at keys.transcription(target, newId);
 *     - the object copy runs against a fake storage: ALTO objects land
 *       at the planned keys, and a mid-copy failure + rollback removes
 *       every copied object (transcription keys share the copy's
 *       rollback list with originals/thumbs);
 *     - wiring: lib/items/copy.ts loads non-deleted rows, plans, copies
 *       objects inside its rollback scope, and inserts the new rows.
 *     - DB-GATED (scratch only): a transcription inserted the way the
 *       copy inserts it becomes searchable for BOTH the target photo
 *       and target item scopes via the 0010 trigger — verified, not
 *       assumed.
 *   FIX 2 — bulk copy + app clipboard:
 *     - runBulkCopy: 2+ items copy, one failure is reported with its
 *       reason and does not stop the rest; duplicate ids copy once.
 *     - clipboard (lib/items/clipboard.ts): make/serialize/parse with
 *       validation, storage round-trip, paste planning, executePaste
 *       against a fake post (success mapping; transport failure fails
 *       every ref honestly).
 *     - wiring: bulk route exists + validates, Inspector uses the bulk
 *       path, selection bar + paste button + shortcut registry entries.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  planTranscriptionCopies,
  copyTranscriptionObjects,
  rollbackCopiedObjects,
  transcriptionInsertParams,
  runBulkCopy,
} from '../lib/items/copy-plan.ts';
import {
  makeClipboard,
  serializeClipboard,
  parseClipboard,
  readItemClipboard,
  writeItemClipboard,
  clearItemClipboard,
  planPaste,
  summarizeBulkCopyResponse,
  executePaste,
  CLIPBOARD_STORAGE_KEY,
} from '../lib/items/clipboard.ts';
import { keys } from '../lib/storage/driver.ts';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const SRC_PROJECT = '11111111-1111-4111-8111-111111111111';
const TGT_PROJECT = '22222222-2222-4222-8222-222222222222';
const ITEM_A = '33333333-3333-4333-8333-333333333333';
const ITEM_B = '44444444-4444-4444-8444-444444444444';
const ITEM_C = '55555555-5555-4555-8555-555555555555';

// ------------------------------------------------------------ FIX 1: plan

function srcRow(over = {}) {
  return {
    id: 'tr-1',
    image_id: 'img-old-1',
    text: 'Hello world',
    alto_r2_key: 'transcriptions/src-proj/tr-1.xml',
    config: { source: 'alto', alto: { namespace: 'ns-v4', version: '4' } },
    status: 'done',
    angle: 0,
    mirror: false,
    words: [{ text: 'Hello', x: 1, y: 2, w: 30, h: 10, confidence: 0.98 }],
    page_width: 1000,
    page_height: 1400,
    ...over,
  };
}

describe('planTranscriptionCopies (row 32 fix)', () => {
  const imageIdMap = new Map([['img-old-1', 'img-new-1'], ['img-old-2', 'img-new-2']]);
  let n = 0;
  const newId = () => `new-tr-${++n}`;

  it('maps rows onto the NEW image id with verbatim fields and a fresh ALTO key', () => {
    n = 0;
    const planned = planTranscriptionCopies([srcRow()], imageIdMap, TGT_PROJECT, newId);
    assert.equal(planned.length, 1);
    const p = planned[0];
    assert.equal(p.new_id, 'new-tr-1');
    assert.equal(p.new_image_id, 'img-new-1');
    assert.equal(p.text, 'Hello world');
    assert.deepEqual(p.words, [{ text: 'Hello', x: 1, y: 2, w: 30, h: 10, confidence: 0.98 }]);
    assert.deepEqual(p.config, { source: 'alto', alto: { namespace: 'ns-v4', version: '4' } });
    assert.equal(p.status, 'done');
    assert.equal(p.angle, 0);
    assert.equal(p.mirror, false);
    assert.equal(p.page_width, 1000);
    assert.equal(p.page_height, 1400);
    assert.equal(p.source_alto_key, 'transcriptions/src-proj/tr-1.xml');
    assert.equal(p.alto_r2_key, keys.transcription(TGT_PROJECT, 'new-tr-1'));
    assert.notEqual(p.alto_r2_key, p.source_alto_key, 'delete-independence: never the source key');
  });

  it('rows without a stored ALTO object plan no storage copy', () => {
    const planned = planTranscriptionCopies(
      [srcRow({ alto_r2_key: null, config: { source: 'manual' } })],
      imageIdMap, TGT_PROJECT, () => 'new-tr-x',
    );
    assert.equal(planned[0].source_alto_key, null);
    assert.equal(planned[0].alto_r2_key, null);
    assert.deepEqual(planned[0].config, { source: 'manual' });
  });

  it('skips rows whose image is not part of the copy', () => {
    const planned = planTranscriptionCopies(
      [srcRow({ image_id: 'img-not-copied' })],
      imageIdMap, TGT_PROJECT, () => 'new-tr-y',
    );
    assert.equal(planned.length, 0);
  });

  it('insert params carry new id + new image id + JSON-encoded config/words', () => {
    const planned = planTranscriptionCopies([srcRow()], imageIdMap, TGT_PROJECT, () => 'new-tr-9');
    const params = transcriptionInsertParams(planned[0]);
    assert.equal(params[0], 'new-tr-9');
    assert.equal(params[1], 'img-new-1');
    assert.equal(params[2], 'Hello world');
    assert.equal(params[3], keys.transcription(TGT_PROJECT, 'new-tr-9'));
    assert.deepEqual(JSON.parse(params[4]), { source: 'alto', alto: { namespace: 'ns-v4', version: '4' } });
    assert.deepEqual(JSON.parse(params[8]), [{ text: 'Hello', x: 1, y: 2, w: 30, h: 10, confidence: 0.98 }]);
    assert.equal(params[9], 1000);
    assert.equal(params[10], 1400);
  });
});

// ------------------------------------------------- FIX 1: storage + rollback

function fakeStorage({ failOnCopyCall = -1 } = {}) {
  const objects = new Map();
  let copyCalls = 0;
  return {
    objects,
    async copy(src, dest) {
      copyCalls += 1;
      if (copyCalls === failOnCopyCall) throw new Error('storage copy exploded');
      if (!objects.has(src)) throw new Error(`missing source ${src}`);
      objects.set(dest, objects.get(src));
    },
    async deleteMany(ks) {
      for (const k of ks) objects.delete(k);
    },
  };
}

describe('transcription object copy + rollback (fake storage)', () => {
  const imageIdMap = new Map([['img-old-1', 'img-new-1'], ['img-old-2', 'img-new-2']]);
  const rows = [
    srcRow(),
    srcRow({ id: 'tr-2', image_id: 'img-old-2', alto_r2_key: 'transcriptions/src-proj/tr-2.xml', text: 'second' }),
    srcRow({ id: 'tr-3', image_id: 'img-old-2', alto_r2_key: null, text: 'manual only' }),
  ];
  let n = 0;
  const planned = planTranscriptionCopies(rows, imageIdMap, TGT_PROJECT, () => `cp-${++n}`);

  it('copies every ALTO object to its fresh target key', async () => {
    const storage = fakeStorage();
    storage.objects.set('transcriptions/src-proj/tr-1.xml', '<alto>1</alto>');
    storage.objects.set('transcriptions/src-proj/tr-2.xml', '<alto>2</alto>');
    const copiedKeys = ['originals/tgt/photo-1.jpg']; // a photo original already copied
    await copyTranscriptionObjects(planned, storage, copiedKeys);
    assert.equal(storage.objects.get(keys.transcription(TGT_PROJECT, 'cp-1')), '<alto>1</alto>');
    assert.equal(storage.objects.get(keys.transcription(TGT_PROJECT, 'cp-2')), '<alto>2</alto>');
    assert.deepEqual(copiedKeys.slice(1), [
      keys.transcription(TGT_PROJECT, 'cp-1'),
      keys.transcription(TGT_PROJECT, 'cp-2'),
    ]);
  });

  it('a mid-copy failure rolls back originals AND transcription objects', async () => {
    const storage = fakeStorage({ failOnCopyCall: 2 });
    storage.objects.set('transcriptions/src-proj/tr-1.xml', '<alto>1</alto>');
    storage.objects.set('transcriptions/src-proj/tr-2.xml', '<alto>2</alto>');
    const copiedKeys = ['originals/tgt/photo-1.jpg'];
    storage.objects.set('originals/tgt/photo-1.jpg', 'JPEG');
    await assert.rejects(() => copyTranscriptionObjects(planned, storage, copiedKeys), /exploded/);
    // Exactly the copy.ts catch path: shared list, one rollback call.
    await rollbackCopiedObjects(storage, copiedKeys);
    assert.equal(storage.objects.has('originals/tgt/photo-1.jpg'), false);
    assert.equal(storage.objects.has(keys.transcription(TGT_PROJECT, 'cp-1')), false);
    // Sources are never touched by a rollback.
    assert.equal(storage.objects.get('transcriptions/src-proj/tr-1.xml'), '<alto>1</alto>');
  });
});

// ------------------------------------------------------------ FIX 1: wiring

describe('copy.ts transcription wiring (row 32 fix)', () => {
  const copy = read('lib/items/copy.ts');

  it('loads only non-deleted transcription rows for the source images', () => {
    assert.match(copy, /FROM transcriptions WHERE image_id = ANY\(\$\{sourceImageIds\}\) AND deleted_at IS NULL/);
  });

  it('plans via planTranscriptionCopies against the image id map', () => {
    assert.match(copy, /planTranscriptionCopies\(/);
    assert.match(copy, /imageIdMap/);
  });

  it('copies ALTO objects inside the shared rollback scope', () => {
    assert.match(copy, /copyTranscriptionObjects\(transcriptionPlan, storage, copiedKeys\)/);
    assert.match(copy, /rollbackCopiedObjects\(storage, copiedKeys\)/);
  });

  it('inserts new transcription rows pointing at the NEW image ids', () => {
    assert.match(copy, /INSERT INTO transcriptions \(id, image_id, text, alto_r2_key, config, status,/);
    assert.match(copy, /transcriptionInsertParams\(p\)/);
  });

  it('reports transcriptions_copied in the result', () => {
    assert.match(copy, /transcriptions_copied: transcriptionPlan\.length/);
  });

  it('header no longer claims transcriptions are skipped', () => {
    assert.ok(!copy.includes('not copied.\n */'), 'stale wave-B limit must be gone');
    assert.match(copy, /transcriptions: COPIED \(row 32 fix/);
  });
});

// ------------------------------------------------------------ FIX 2: bulk

describe('runBulkCopy (row 32 fix)', () => {
  it('copies 2+ items and keeps going past a failure with its reason', async () => {
    const calls = [];
    const out = await runBulkCopy([ITEM_A, ITEM_B, ITEM_C], async (id) => {
      calls.push(id);
      if (id === ITEM_B) throw new Error('item not found');
      return { item_id: `new-${id.slice(0, 4)}` };
    });
    assert.deepEqual(calls, [ITEM_A, ITEM_B, ITEM_C], 'failure must not stop the rest');
    assert.equal(out.copied.length, 2);
    assert.deepEqual(out.copied.map((c) => c.source_item_id), [ITEM_A, ITEM_C]);
    assert.deepEqual(out.failed, [{ item_id: ITEM_B, error: 'item not found' }]);
  });

  it('dedupes repeated ids (one copy per item)', async () => {
    let count = 0;
    const out = await runBulkCopy([ITEM_A, ITEM_A], async () => ({ n: ++count }));
    assert.equal(count, 1);
    assert.equal(out.copied.length, 1);
  });

  it('stringifies non-Error failures honestly', async () => {
    const out = await runBulkCopy([ITEM_A], async () => {
      throw 'plain string failure'; // eslint-disable-line no-throw-literal
    });
    assert.deepEqual(out.failed, [{ item_id: ITEM_A, error: 'plain string failure' }]);
  });
});

// -------------------------------------------------------- FIX 2: clipboard

function fakeLocalStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

describe('item clipboard (row 32 fix)', () => {
  it('makeClipboard validates uuids and dedupes item ids', () => {
    const clip = makeClipboard(SRC_PROJECT, [ITEM_A, ITEM_B, ITEM_A, 'not-a-uuid'], 1234);
    assert.deepEqual(clip, { sourceProjectId: SRC_PROJECT, itemIds: [ITEM_A, ITEM_B], copiedAt: 1234 });
    assert.equal(makeClipboard('nope', [ITEM_A]), null);
    assert.equal(makeClipboard(SRC_PROJECT, []), null);
    assert.equal(makeClipboard(SRC_PROJECT, ['junk']), null);
  });

  it('serialize/parse round-trips; junk parses to null', () => {
    const clip = makeClipboard(SRC_PROJECT, [ITEM_A], 42);
    assert.deepEqual(parseClipboard(serializeClipboard(clip)), clip);
    assert.equal(parseClipboard(null), null);
    assert.equal(parseClipboard('{broken'), null);
    assert.equal(parseClipboard('{"sourceProjectId":1,"itemIds":"x"}'), null);
    assert.equal(parseClipboard('{"sourceProjectId":"' + SRC_PROJECT + '","itemIds":[]}'), null);
  });

  it('storage round-trip: write, read, clear', () => {
    const storage = fakeLocalStorage();
    const clip = makeClipboard(SRC_PROJECT, [ITEM_A, ITEM_B], 7);
    writeItemClipboard(clip, storage);
    assert.ok(storage.map.has(CLIPBOARD_STORAGE_KEY));
    assert.deepEqual(readItemClipboard(storage), clip);
    clearItemClipboard(storage);
    assert.equal(readItemClipboard(storage), null);
  });

  it('planPaste: cross-project, same-project duplicate, and empty cases', () => {
    const clip = makeClipboard(SRC_PROJECT, [ITEM_A, ITEM_B]);
    const cross = planPaste(clip, TGT_PROJECT);
    assert.deepEqual(cross, {
      sourceProjectId: SRC_PROJECT,
      targetProjectId: TGT_PROJECT,
      itemIds: [ITEM_A, ITEM_B],
      sameProject: false,
    });
    assert.equal(planPaste(clip, SRC_PROJECT).sameProject, true);
    assert.equal(planPaste(null, TGT_PROJECT), null);
    assert.equal(planPaste(clip, 'not-a-uuid'), null);
  });

  it('summarizeBulkCopyResponse maps copied ids and failure reasons', () => {
    const summary = summarizeBulkCopyResponse({
      target_project_id: TGT_PROJECT,
      copied: [{ source_item_id: ITEM_A, item_id: 'new-a' }],
      failed: [{ item_id: ITEM_B, error: 'item not found' }],
    });
    assert.deepEqual(summary, {
      copied: 1,
      copiedItemIds: ['new-a'],
      failed: [{ item_id: ITEM_B, reason: 'item not found' }],
    });
  });

  it('executePaste posts the bulk copy from the SOURCE project and summarizes', async () => {
    const clip = makeClipboard(SRC_PROJECT, [ITEM_A, ITEM_B]);
    const plan = planPaste(clip, TGT_PROJECT);
    const seen = [];
    const postFn = async (path, body) => {
      seen.push([path, body]);
      return {
        target_project_id: TGT_PROJECT,
        copied: [{ source_item_id: ITEM_A, item_id: 'new-a' }],
        failed: [{ item_id: ITEM_B, error: 'item not found' }],
      };
    };
    const summary = await executePaste(plan, postFn);
    assert.deepEqual(seen, [[
      `/api/projects/${SRC_PROJECT}/items/copy`,
      { item_ids: [ITEM_A, ITEM_B], target_project_id: TGT_PROJECT },
    ]]);
    assert.equal(summary.copied, 1);
    assert.deepEqual(summary.failed, [{ item_id: ITEM_B, reason: 'item not found' }]);
  });

  it('executePaste transport failure fails EVERY ref with the reason (no silent drops)', async () => {
    const plan = planPaste(makeClipboard(SRC_PROJECT, [ITEM_A, ITEM_B]), TGT_PROJECT);
    const summary = await executePaste(plan, async () => {
      throw new Error('network down');
    });
    assert.equal(summary.copied, 0);
    assert.deepEqual(summary.failed, [
      { item_id: ITEM_A, reason: 'network down' },
      { item_id: ITEM_B, reason: 'network down' },
    ]);
  });
});

// ---------------------------------------------------------- FIX 2: wiring

describe('bulk copy + clipboard wiring (row 32 fix)', () => {
  it('bulk route exists, validates, and calls copyItemsToProject', () => {
    const route = read('app/api/projects/[id]/items/copy/route.ts');
    assert.match(route, /handle\(/);
    assert.match(route, /copyItemsToProject\(id, body\.item_ids as string\[\], body\.target_project_id\)/);
    assert.match(route, /item_ids must be a non-empty array of item UUIDs/);
  });

  it('copyItemsToProject validates the target and aggregates via runBulkCopy', () => {
    const copy = read('lib/items/copy.ts');
    assert.match(copy, /export async function copyItemsToProject/);
    assert.match(copy, /runBulkCopy\(itemIds/);
  });

  it('single-item route still works (unchanged surface)', () => {
    const route = read('app/api/projects/[id]/items/[itemId]/copy/route.ts');
    assert.match(route, /copyItemToProject\(id, itemId, body\.target_project_id\)/);
  });

  it('Inspector copy menu runs through the bulk path', () => {
    const inspector = read('components/inspector/Inspector.tsx');
    assert.match(inspector, /`\/api\/projects\/\$\{projectId\}\/items\/copy`/);
    assert.match(inspector, /item_ids: \[itemId\]/);
    assert.match(inspector, /copyBulkPartial/);
  });

  it('selection bar stores refs; center head pastes with honest counts', () => {
    const panel = read('components/center/CenterPanel.tsx');
    assert.match(panel, /makeClipboard\(projectId, selectedIds\)/);
    assert.match(panel, /writeItemClipboard\(clip\)/);
    assert.match(panel, /copyToProject/);
    assert.match(panel, /function PasteItemsButton/);
    assert.match(panel, /executePaste\(plan, post\)/);
    assert.match(panel, /pastePartial/);
    assert.match(panel, /<PasteItemsButton projectId=\{projectId\} ctx=\{ctx\} \/>/);
  });

  it('copy/paste keys are registered in the registry (single source of truth)', () => {
    const registry = read('lib/shortcuts/registry.ts');
    assert.match(registry, /id: "copySelection"/);
    assert.match(registry, /"mod\+shift\+c"/);
    assert.match(registry, /id: "pasteItems"/);
    assert.match(registry, /"mod\+shift\+v"/);
    assert.match(registry, /executePaste\(plan, post\)/);
  });

  it('en.json carries the new UI strings', () => {
    const en = JSON.parse(read('messages/en.json'));
    for (const k of ['copyToProject', 'copyStored', 'pasteItems', 'pasteDone', 'pastePartial', 'pasteFailed', 'pasteEmpty']) {
      assert.equal(typeof en.center[k], 'string', `center.${k}`);
    }
    assert.equal(typeof en.inspector.copyBulkDone, 'string');
    assert.equal(typeof en.inspector.copyBulkPartial, 'string');
    assert.equal(typeof en.shortcuts.copySelection, 'string');
    assert.equal(typeof en.shortcuts.pasteItems, 'string');
  });
});

// ------------------------------------------- FIX 1: searchability (DB-gated)
// Scratch database only, like test/transcriptions.test.mjs: the copy's
// transcription INSERT (same column list copy.ts issues) must make the
// copied term findable for the TARGET photo + item scopes via the 0010
// trigger — the trigger fires on insert, verified here, not assumed.
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.log('(copy-transcriptions-db: skipped — set DATABASE_URL to a SCRATCH database to run)');
} else {
  describe('copied transcriptions are searchable in the target project (DB, scratch only)', () => {
    it('copy-shaped insert aggregates for target photo + item scopes', { timeout: 60_000 }, async () => {
      const { neon } = await import('@neondatabase/serverless');
      const db = neon(DATABASE_URL);
      const q = (text, params) => db.query(text, params);
      const mig = read('db/migrations/0010_transcriptions_search.sql');
      const fnStart = mig.indexOf('CREATE OR REPLACE FUNCTION refresh_search_document');
      const fnEnd = mig.indexOf('$$ LANGUAGE plpgsql;', fnStart) + '$$ LANGUAGE plpgsql;'.length;
      const refreshFn = mig.slice(fnStart, fnEnd);
      const trgStart = mig.indexOf('CREATE OR REPLACE FUNCTION trg_refresh_search_from_transcription');
      const trgEnd = mig.indexOf('$$ LANGUAGE plpgsql;', trgStart) + '$$ LANGUAGE plpgsql;'.length;
      const triggerFn = mig.slice(trgStart, trgEnd);

      await q(`CREATE TABLE IF NOT EXISTS projects (id UUID PRIMARY KEY, rev BIGINT DEFAULT 0)`);
      await q(`CREATE TABLE IF NOT EXISTS subjects (id UUID PRIMARY KEY, project_id UUID, kind TEXT)`);
      await q(`CREATE TABLE IF NOT EXISTS images (id UUID PRIMARY KEY)`);
      await q(`CREATE TABLE IF NOT EXISTS photos (subject_id UUID PRIMARY KEY, item_id UUID, image_id UUID)`);
      await q(`CREATE TABLE IF NOT EXISTS metadata (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), subject_id UUID, value_id UUID)`);
      await q(`CREATE TABLE IF NOT EXISTS metadata_values (value_id UUID PRIMARY KEY, datatype TEXT, text TEXT)`);
      await q(`CREATE TABLE IF NOT EXISTS notes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), subject_id UUID, text TEXT, deleted_at TIMESTAMPTZ)`);
      await q(`CREATE TABLE IF NOT EXISTS tags (id UUID PRIMARY KEY, name CITEXT)`);
      await q(`CREATE TABLE IF NOT EXISTS taggings (tag_id UUID, subject_id UUID)`);
      await q(`CREATE TABLE IF NOT EXISTS transcriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), image_id UUID, text TEXT DEFAULT '',
        alto_r2_key TEXT, config JSONB DEFAULT '{}', status TEXT DEFAULT 'done',
        angle NUMERIC DEFAULT 0, mirror BOOLEAN DEFAULT false, deleted_at TIMESTAMPTZ,
        words JSONB DEFAULT '[]', page_width INT, page_height INT)`);
      await q(`CREATE TABLE IF NOT EXISTS search_documents (
        subject_id UUID PRIMARY KEY, project_id UUID, subject_kind TEXT,
        doc_meta TSVECTOR DEFAULT ''::tsvector, doc_notes TSVECTOR DEFAULT ''::tsvector,
        doc_tags TSVECTOR DEFAULT ''::tsvector,
        doc_transcriptions TSVECTOR DEFAULT ''::tsvector,
        doctext TEXT DEFAULT '', updated_at TIMESTAMPTZ DEFAULT now())`);
      await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
      await q(refreshFn);
      await q(triggerFn);
      await q(`DROP TRIGGER IF EXISTS trg_search_transcriptions ON transcriptions`);
      await q(`CREATE TRIGGER trg_search_transcriptions AFTER INSERT OR UPDATE OR DELETE ON transcriptions
               FOR EACH ROW EXECUTE FUNCTION trg_refresh_search_from_transcription()`);

      const SRC_P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const TGT_P = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const S_ITEM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const S_PHOTO = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const S_IMG = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      const T_ITEM = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      const T_PHOTO = '99999999-9999-4999-8999-999999999999';
      const T_IMG = '88888888-8888-4888-8888-888888888888';
      const S_TR = '77777777-7777-4777-8777-777777777777';
      const T_TR = '66666666-6666-4666-8666-666666666666';

      for (const p of [SRC_P, TGT_P]) await q(`DELETE FROM projects WHERE id = $1`, [p]);
      await q(`INSERT INTO projects (id) VALUES ($1),($2)`, [SRC_P, TGT_P]);
      await q(`INSERT INTO subjects (id, project_id, kind) VALUES ($1,$2,'item'),($3,$2,'photo')`, [S_ITEM, SRC_P, S_PHOTO]);
      await q(`INSERT INTO subjects (id, project_id, kind) VALUES ($1,$2,'item'),($3,$2,'photo')`, [T_ITEM, TGT_P, T_PHOTO]);
      await q(`INSERT INTO images (id) VALUES ($1),($2)`, [S_IMG, T_IMG]);
      await q(`INSERT INTO photos (subject_id, item_id, image_id) VALUES ($1,$2,$3)`, [S_PHOTO, S_ITEM, S_IMG]);
      await q(`INSERT INTO photos (subject_id, item_id, image_id) VALUES ($1,$2,$3)`, [T_PHOTO, T_ITEM, T_IMG]);
      await q(
        `INSERT INTO transcriptions (id, image_id, text, alto_r2_key, config, status, angle, mirror, words, page_width, page_height)
         VALUES ($1,$2,'zzcopiedterm manuscript','$3,'{}'::jsonb,'done',0,false,'[]'::jsonb,1000,1400)`,
        [S_TR, S_IMG, `transcriptions/${SRC_P}/${S_TR}.xml`],
      );

      // The copy's insert, verbatim column list (lib/items/copy.ts):
      // new row id, NEW image id, fresh ALTO key under the target project.
      await q(
        `INSERT INTO transcriptions (id, image_id, text, alto_r2_key, config, status,
            angle, mirror, words, page_width, page_height)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11)`,
        [T_TR, T_IMG, 'zzcopiedterm manuscript', keys.transcription(TGT_P, T_TR),
          '{"source":"alto"}', 'done', 0, false,
          '[{"text":"zzcopiedterm","x":1,"y":2,"w":30,"h":10}]', 1000, 1400],
      );

      const row = await q(`SELECT text, words, alto_r2_key FROM transcriptions WHERE id = $1`, [T_TR]);
      assert.equal(row[0].text, 'zzcopiedterm manuscript');
      assert.deepEqual(row[0].words, [{ text: 'zzcopiedterm', x: 1, y: 2, w: 30, h: 10 }]);
      assert.equal(row[0].alto_r2_key, `transcriptions/${TGT_P}/${T_TR}.xml`);

      const hits = await q(
        `SELECT subject_id FROM search_documents
         WHERE doc_transcriptions @@ websearch_to_tsquery('english', 'zzcopiedterm')
         ORDER BY subject_id`, []);
      const ids = hits.map((r) => r.subject_id).sort();
      assert.deepEqual(ids, [S_ITEM, S_PHOTO, T_ITEM, T_PHOTO].sort(),
        'source AND copied target scopes all find the term after the copy insert');

      for (const p of [SRC_P, TGT_P]) {
        await q(`DELETE FROM projects WHERE id = $1`, [p]);
        await q(`DELETE FROM subjects WHERE project_id = $1`, [p]);
        await q(`DELETE FROM search_documents WHERE project_id = $1`, [p]);
      }
      await q(`DELETE FROM photos WHERE subject_id IN ($1,$2)`, [S_PHOTO, T_PHOTO]);
      await q(`DELETE FROM transcriptions WHERE id IN ($1,$2)`, [S_TR, T_TR]);
    });
  });
}
