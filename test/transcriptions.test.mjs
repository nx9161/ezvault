// SPDX-License-Identifier: MIT
/**
 * test/transcriptions.test.mjs — Wave C (rows 13/14/19).
 *
 *   - ALTO parse: hand-written fixture (ns-v4) -> text + word boxes +
 *     page geometry + hyphenation glue; namespace-less variant; junk
 *     input rejected honestly.
 *   - OCR adapter: tesseract output mapping (blocks + legacy shapes,
 *     confidence 0..100 -> 0..1), stub-engine registry, payload shape,
 *     and one REAL tesseract.js smoke run against the self-hosted
 *     public/ocr assets on a tiny rendered text image.
 *   - Wiring (source-level, *-wire style): CRUD routes resolve photo ->
 *     image, soft-delete via deleted_at, ALTO import stores to R2 at
 *     keys.transcription() with rollback, downloads exist, the panel
 *     dynamic-imports the engine (nothing OCR in First Load), CSP-safe
 *     worker settings.
 *   - Search (row 19): migration 0010 content invariants + a DB-GATED
 *     functional test (skips without DATABASE_URL, scratch DB only):
 *     a transcription-only term becomes findable for BOTH the photo
 *     and item scopes via the search route's vector expression.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAlto, AltoParseError } from '../lib/transcription/alto';
import {
  registerOcrEngine, getOcrEngine, listOcrEngines,
  mapTesseractData, transcriptionPayloadFromOcr,
} from '../lib/ocr/adapter';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ---------------------------------------------------------------- ALTO parse

const ALTO_V4 = `<?xml version="1.0" encoding="UTF-8"?>
<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Description><MeasurementUnit>pixel</MeasurementUnit></Description>
  <Layout>
    <Page ID="p1" WIDTH="1000" HEIGHT="1400">
      <PrintSpace HPOS="0" VPOS="0" WIDTH="1000" HEIGHT="1400">
        <TextBlock ID="b1" HPOS="80" VPOS="180" WIDTH="500" HEIGHT="200">
          <TextLine ID="l1" HPOS="100" VPOS="200" WIDTH="300" HEIGHT="30">
            <String ID="w1" CONTENT="Hello" HPOS="100" VPOS="200" WIDTH="90" HEIGHT="30" WC="0.98"/>
            <SP WIDTH="10"/>
            <String ID="w2" CONTENT="world" HPOS="200" VPOS="200" WIDTH="95" HEIGHT="30" WC="0.91"/>
          </TextLine>
          <TextLine ID="l2" HPOS="100" VPOS="250" WIDTH="200" HEIGHT="30">
            <String ID="w3" CONTENT="transcrip-" HPOS="100" VPOS="250" WIDTH="150" HEIGHT="30"/>
            <HYP CONTENT="-"/>
          </TextLine>
          <TextLine ID="l3" HPOS="100" VPOS="290" WIDTH="60" HEIGHT="30">
            <String ID="w4" CONTENT="tion" HPOS="100" VPOS="290" WIDTH="55" HEIGHT="30"/>
          </TextLine>
        </TextBlock>
      </PrintSpace>
    </Page>
  </Layout>
</alto>`;

describe('parseAlto', () => {
  it('extracts text, word boxes, page size, namespace and version', () => {
    const doc = parseAlto(ALTO_V4);
    assert.equal(doc.pageWidth, 1000);
    assert.equal(doc.pageHeight, 1400);
    assert.equal(doc.namespace, 'http://www.loc.gov/standards/alto/ns-v4#');
    assert.equal(doc.version, '4');
    assert.equal(doc.words.length, 4);
    assert.deepEqual(doc.words[0], { text: 'Hello', x: 100, y: 200, w: 90, h: 30, confidence: 0.98 });
    assert.deepEqual(doc.words[1], { text: 'world', x: 200, y: 200, w: 95, h: 30, confidence: 0.91 });
    assert.equal(doc.words[2].confidence, undefined);
  });

  it('joins lines with newlines and glues hyphenated words', () => {
    const doc = parseAlto(ALTO_V4);
    assert.equal(doc.text, 'Hello world\ntranscription');
  });

  it('parses namespace-less ALTO', () => {
    const doc = parseAlto(
      `<alto><Layout><Page WIDTH="200" HEIGHT="100"><PrintSpace>` +
      `<TextBlock><TextLine><String CONTENT="Solo" HPOS="1" VPOS="2" WIDTH="30" HEIGHT="10"/>` +
      `</TextLine></TextBlock></PrintSpace></Page></Layout></alto>`,
    );
    assert.equal(doc.text, 'Solo');
    assert.equal(doc.words.length, 1);
    assert.equal(doc.namespace, null);
    assert.equal(doc.version, null);
  });

  it('rejects junk honestly', () => {
    assert.throws(() => parseAlto(''), AltoParseError);
    assert.throws(() => parseAlto('<html><body>no</body></html>'), AltoParseError);
    assert.throws(() => parseAlto('<alto><Layout>'), AltoParseError);
  });
});

// ---------------------------------------------------------------- OCR adapter

describe('OCR adapter', () => {
  it('registry holds stub engines by id', () => {
    registerOcrEngine({
      id: 'stub', version: '0.0.1', languages: ['eng'],
      recognize: async () => ({ text: 'stub text', words: [] }),
    });
    assert.equal(getOcrEngine('stub')?.version, '0.0.1');
    assert.ok(listOcrEngines().some((e) => e.id === 'stub'));
    assert.equal(getOcrEngine('nope'), undefined);
  });

  it('maps the blocks hierarchy and normalizes confidence to 0..1', () => {
    const out = mapTesseractData({
      text: 'Hello world\n',
      blocks: [{
        paragraphs: [{
          lines: [{
            words: [
              { text: 'Hello', confidence: 98, bbox: { x0: 10, y0: 20, x1: 60, y1: 44 } },
              { text: 'world', confidence: 50, bbox: { x0: 66, y0: 20, x1: 120, y1: 44 } },
            ],
          }],
        }],
      }],
    });
    assert.equal(out.text, 'Hello world\n');
    assert.deepEqual(out.words, [
      { text: 'Hello', x: 10, y: 20, w: 50, h: 24, confidence: 0.98 },
      { text: 'world', x: 66, y: 20, w: 54, h: 24, confidence: 0.5 },
    ]);
  });

  it('maps the legacy flat words shape and drops degenerate boxes', () => {
    const out = mapTesseractData({
      text: 'one',
      words: [
        { text: 'one', confidence: 90, bbox: { x0: 0, y0: 0, x1: 30, y1: 12 } },
        { text: 'zero', confidence: 90, bbox: { x0: 5, y0: 5, x1: 5, y1: 9 } },
      ],
    });
    assert.equal(out.words.length, 1);
  });

  it('throws on a payload-less result (no fake empty success)', () => {
    assert.throws(() => mapTesseractData(null), /no data/);
    assert.throws(() => mapTesseractData(undefined), /no data/);
  });

  it('payload carries provenance config (engine/version/lang, source=ocr)', () => {
    const payload = transcriptionPayloadFromOcr(
      { text: 'abc', words: [{ text: 'abc', x: 1, y: 2, w: 3, h: 4 }] },
      { engine: 'tesseract', version: '7.0.0', lang: 'eng', pageWidth: 800, pageHeight: 600 },
    );
    assert.deepEqual(payload.config, { source: 'ocr', engine: 'tesseract', version: '7.0.0', lang: 'eng' });
    assert.equal(payload.status, 'done');
    assert.equal(payload.page_width, 800);
    assert.equal(payload.words.length, 1);
  });

  it('real tesseract smoke: rendered text image OCRs from self-hosted assets', { timeout: 120_000 }, async () => {
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(400, 120);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 400, 120);
    ctx.fillStyle = 'black'; ctx.font = '48px sans-serif';
    ctx.fillText('HELLO VAULT', 20, 70);
    const png = canvas.toBuffer('image/png');
    const { createWorker } = await import('tesseract.js');
    const { tmpdir } = await import('node:os');
    // Node-side worker entry comes from the package; the CORE + LANG
    // assets are the self-hosted public/ocr copies the browser uses.
    const worker = await createWorker('eng', 1, {
      corePath: new URL('../public/ocr/', import.meta.url).pathname,
      langPath: new URL('../public/ocr/lang/', import.meta.url).pathname,
      cachePath: tmpdir(),
      gzip: true,
    });
    try {
      const { data } = await worker.recognize(png, {}, { blocks: true });
      const mapped = mapTesseractData(data);
      assert.match(mapped.text, /HELLO/);
      assert.match(mapped.text, /VAULT/);
      assert.ok(mapped.words.length >= 2, 'word boxes present');
      assert.ok(mapped.words.every((w) => w.w > 0 && w.h > 0));
    } finally {
      await worker.terminate();
    }
  });
});

// ---------------------------------------------------------------- wiring

describe('transcription wiring (rows 13/14)', () => {
  const lib = read('lib/api/transcriptions.ts');

  it('routes exist for collection, single, ALTO import + both downloads', () => {
    for (const p of [
      'app/api/projects/[id]/photos/[photoId]/transcriptions/route.ts',
      'app/api/projects/[id]/photos/[photoId]/transcriptions/alto/route.ts',
      'app/api/projects/[id]/transcriptions/[transcriptionId]/route.ts',
      'app/api/projects/[id]/transcriptions/[transcriptionId]/alto/route.ts',
      'app/api/projects/[id]/transcriptions/[transcriptionId]/text/route.ts',
    ]) {
      assert.ok(read(p).includes('transcription'), p);
    }
  });

  it('resolves photo -> image via photos.image_id (project-scoped)', () => {
    assert.match(lib, /JOIN images i ON i\.id = p\.image_id/);
    assert.match(lib, /s\.project_id = \$\{projectId\} AND p\.subject_id = \$\{photoId\}/);
  });

  it('soft-deletes via deleted_at; reads exclude deleted rows', () => {
    assert.match(lib, /SET deleted_at = now\(\)/);
    assert.match(lib, /deleted_at IS NULL/);
  });

  it('ALTO import stores the original XML at keys.transcription and rolls back on failure', () => {
    assert.match(lib, /keys\.transcription\(id, newId\)/);
    assert.match(lib, /storage\.putBytes\(altoKey/);
    assert.match(lib, /storage\.delete\(altoKey\)/);
    assert.match(lib, /source: 'alto'/);
  });

  it('manual create defaults provenance source=manual and preserves explicit sources', () => {
    assert.match(lib, /source: 'manual'/);
    assert.match(lib, /v\.config\['source'\]/);
  });

  it('viewer renders a selectable text layer from word boxes', () => {
    const viewer = read('components/inspector/PhotoViewer.tsx');
    assert.match(viewer, /ez-text-layer/);
    assert.match(viewer, /wordScreenRect/);
    assert.match(viewer, /textTr\.angle/);
    assert.match(viewer, /textTr\.mirror/);
    const css = read('app/globals.css');
    assert.match(css, /\.ez-text-layer span::selection/);
  });

  it('OCR stays out of First Load: panel dynamic-imports the engine; worker is CSP-safe', () => {
    const panel = read('components/inspector/TranscriptionPanel.tsx');
    assert.match(panel, /import\("@\/lib\/ocr\/tesseract-engine"\)/);
    assert.ok(!panel.includes("from \"tesseract.js\""), 'panel must not statically import tesseract.js');
    assert.ok(!panel.includes("from '@/lib/ocr/tesseract-engine'"), 'engine must not be a static import');
    const engine = read('lib/ocr/tesseract-engine.ts');
    assert.match(engine, /workerBlobURL: false/);
    assert.match(engine, /workerPath: '\/ocr\/worker\.min\.js'/);
    assert.match(engine, /langPath: '\/ocr\/lang'/);
    assert.match(engine, /await import\('tesseract\.js'\)/);
  });
});

// ---------------------------------------------------------------- search (row 19)

describe('search aggregation (migration 0010)', () => {
  const mig = read('db/migrations/0010_transcriptions_search.sql');

  it('adds doc_transcriptions + word-box columns and backfills', () => {
    assert.match(mig, /ADD COLUMN IF NOT EXISTS doc_transcriptions/);
    assert.match(mig, /ADD COLUMN IF NOT EXISTS words/);
    assert.match(mig, /page_width/);
    assert.match(mig, /SELECT refresh_search_document\(s\.id\) FROM subjects s/);
  });

  it('refresh aggregates transcription text for photo AND item scopes', () => {
    assert.match(mig, /p\.subject_id = p_subject OR p\.item_id = p_subject/);
    assert.match(mig, /tr\.deleted_at IS NULL/);
    assert.match(mig, /doc_transcriptions = EXCLUDED\.doc_transcriptions/);
  });

  it('replaces the broken 0001 trigger with an image-mapping trigger', () => {
    assert.match(mig, /DROP TRIGGER IF EXISTS trg_search_transcriptions/);
    assert.match(mig, /trg_refresh_search_from_transcription/);
    assert.match(mig, /p\.image_id = ANY\(v_images\)/);
    assert.match(mig, /PERFORM refresh_search_document\(r\.photo_id\)/);
    assert.match(mig, /PERFORM refresh_search_document\(r\.item_id\)/);
  });

  it('the search route exposes the transcriptions scope and the 4-way all vector', () => {
    const route = read('app/api/projects/[id]/search/route.ts');
    assert.match(route, /transcriptions: `sd\.doc_transcriptions`/);
    assert.match(route, /doc_meta \|\| sd\.doc_notes \|\| sd\.doc_tags \|\| sd\.doc_transcriptions/);
  });
});

// DB-GATED functional test: scratch database only (see cpu-window-db).
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.log('(transcriptions-db: skipped — set DATABASE_URL to a SCRATCH database to run)');
} else {
  describe('search aggregation (DB, scratch only)', () => {
    it('a transcription-only term is findable via photo + item scopes', { timeout: 60_000 }, async () => {
      const { neon } = await import('@neondatabase/serverless');
      const db = neon(DATABASE_URL);
      const q = (text, params) => db.query(text, params);
      const mig = read('db/migrations/0010_transcriptions_search.sql');
      // Extract the two function definitions from the migration itself so
      // the test exercises the shipped SQL verbatim.
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

      const P = '11111111-1111-4111-8111-111111111111';
      const ITEM = '22222222-2222-4222-8222-222222222222';
      const PHOTO = '33333333-3333-4333-8333-333333333333';
      const IMG = '44444444-4444-4444-8444-444444444444';
      await q(`DELETE FROM projects WHERE id = $1`, [P]);
      await q(`INSERT INTO projects (id) VALUES ($1)`, [P]);
      await q(`INSERT INTO subjects (id, project_id, kind) VALUES ($1,$2,'item'),($3,$2,'photo')`, [ITEM, P, PHOTO]);
      await q(`INSERT INTO images (id) VALUES ($1)`, [IMG]);
      await q(`INSERT INTO photos (subject_id, item_id, image_id) VALUES ($1,$2,$3)`, [PHOTO, ITEM, IMG]);
      // The trigger (not a manual refresh) must aggregate this insert.
      await q(`INSERT INTO transcriptions (image_id, text) VALUES ($1, 'zztransonlyterm quixotic')`, [IMG]);

      const vec = `(doc_meta || doc_notes || doc_tags || doc_transcriptions)`;
      const hits = await q(
        `SELECT subject_id FROM search_documents
         WHERE ${vec} @@ (websearch_to_tsquery('english', 'zztransonlyterm') || websearch_to_tsquery('simple', 'zztransonlyterm'))
         ORDER BY subject_id`, []);
      const ids = hits.map((r) => r.subject_id).sort();
      assert.deepEqual(ids, [ITEM, PHOTO].sort(), 'both photo and item scopes find the transcription term');

      const scoped = await q(
        `SELECT subject_id FROM search_documents
         WHERE doc_transcriptions @@ websearch_to_tsquery('english', 'quixotic') ORDER BY subject_id`, []);
      assert.equal(scoped.length, 2);

      // Soft-delete removes the term again (trigger refresh on UPDATE).
      await q(`UPDATE transcriptions SET deleted_at = now() WHERE image_id = $1`, [IMG]);
      const gone = await q(
        `SELECT subject_id FROM search_documents
         WHERE doc_transcriptions @@ websearch_to_tsquery('english', 'zztransonlyterm')`, []);
      assert.equal(gone.length, 0);

      await q(`DELETE FROM projects WHERE id = $1`, [P]);
      await q(`DELETE FROM subjects WHERE project_id = $1`, [P]);
      await q(`DELETE FROM photos WHERE subject_id = $1`, [PHOTO]);
      await q(`DELETE FROM transcriptions WHERE image_id = $1`, [IMG]);
      await q(`DELETE FROM search_documents WHERE project_id = $1`, [P]);
    });
  });
}
