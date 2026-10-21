# QA REPORT — EZVault Full Parity Wave C (transcriptions + OCR)

**Gate:** QA Manager, adversarial verification against tree + runtime (builder summary not trusted).
**Baseline:** `main` @ `cb4bce9` (matches required baseline: "test(wave-c): ALTO/OCR/search coverage + CONTRACT Wave C section", on top of 8400155 / fd77e92 / 3323d19 / b125bc3).
**Date:** 2026-10-21. **Verdict: SIGN-OFF** (no blockers; two non-blocking observations, §10).

## 1. Gates — PASS
- `npm test`: **147/147 pass, 0 fail, 0 cancelled/skipped/todo** (43 suites, run live by QA). DB-gated tests print their skip line when `DATABASE_URL` is unset (standard pattern; see §6 caveat).
- `npx tsc --noEmit`: exit 0, clean.
- `npm run build`: exit 0, run by QA under the working-tree protocol — `.env.local` moved to `/tmp/ezvault-env.local` before the build (prebuild secret-scan), restored immediately after, verified back at **1097 bytes**. Build route table includes all five new transcription routes.
- `node scripts/check-licences.mjs`: **PASS** — no GPL/AGPL/SSPL; exactly the **4 pre-existing LGPL warnings** (`@img/sharp-libvips-linux-x64`, `@img/sharp-libvips-linuxmusl-x64`, `@img/sharp-wasm32`, `libheif-js`), unchanged from baseline.
- `node scripts/verify-codecs.mjs`: OK (libvips 8.18.7, sharp 0.35.5 present).

## 2. Row 13 — transcriptions + ALTO — PASS
- Routes all exist and are thin re-exports of `lib/api/transcriptions.ts`:
  - `GET|POST app/api/projects/[id]/photos/[photoId]/transcriptions/route.ts`
  - `GET|PATCH|DELETE app/api/projects/[id]/transcriptions/[transcriptionId]/route.ts` (PATCH partial fields; DELETE = soft delete `deleted_at = now()`, reads filter `deleted_at IS NULL`)
  - `POST …/photos/[photoId]/transcriptions/alto/route.ts` (ALTO import)
  - `GET …/transcriptions/[transcriptionId]/alto/route.ts` (302 presigned download, 404 when no key) and `GET …/transcriptions/[transcriptionId]/text/route.ts` (plain-text download from the row)
- ALTO parser is real, not faked (`lib/transcription/alto.ts`, repo's `sax` strict parser, no new dependency): local-name/case-normalized tag matching (namespaced v2/v3/v4 + namespace-less), `<Page WIDTH/HEIGHT>` extracted into `pageWidth/pageHeight`, `<String CONTENT/HPOS/VPOS/WIDTH/HEIGHT/WC>` extracted into word boxes `{text,x,y,w,h,confidence?}`, line assembly with `<HYP>` hyphenation glue (trailing hyphen dropped from assembled text, kept in the box). Fixture tests assert all of it concretely: page 1000×1400, ns-v4 namespace/version `4`, words `Hello (100,200,90×30, WC 0.98)` / `world (…0.91)`, text exactly `"Hello world\ntranscription"`; namespace-less variant parses; empty / non-ALTO / truncated XML throw `AltoParseError`.
- Original XML storage: ALTO handler mints the id first, stores the original bytes via `keys.transcription(projectId, id)` (`lib/storage/driver.ts`: `transcriptions/<project>/<id>.xml`) with `storage.putBytes`, `config = {source:'alto', alto:{namespace, version}}`.
- Failure path leaves nothing behind (read in source order): `parseAlto()` runs **before** any storage or DB call and a parse failure throws 400 — no row, no object. If the subsequent insert transaction fails, the catch calls `storage.delete(altoKey)` — no orphaned object.
- `TranscriptionPanel` exists and is mounted in the Inspector's viewer tab (`components/inspector/Inspector.tsx:257`, tab-gated at :243): manual editor, ALTO file import, ALTO/text download links, soft-delete with confirm, source/status/word-count provenance line.
- Viewer text layer is real (`components/inspector/PhotoViewer.tsx:459-503, 580-601` + `app/globals.css:696-698`): most recent transcription **with** word boxes renders as `.ez-text-layer` transparent selectable spans (`color: transparent`, `user-select: text`, visible `::selection` highlight). `wordScreenRect()` scales page → photo pixels, then **inverts the transcription's own angle/mirror** (rotate by `−angle` around the image centre; mirror flips cx) before applying the viewer's display transform via `photoToScreen` — i.e. angle/mirror are genuinely applied, matching the CONTRACT semantics, not ignored.

## 3. Row 14 — OCR adapter + engine — PASS
- Contract in `lib/ocr/adapter.ts`: `OcrEngine {id, version, languages, recognize(image,{lang,onProgress}) → {text, words}}`, in-memory registry (`registerOcrEngine`/`getOcrEngine`/`listOcrEngines`), words in image-pixel coordinates. `mapTesseractData` handles both output shapes (blocks hierarchy paragraph→line→word, and legacy flat `words[]`), converts bbox `{x0,y0,x1,y1}` → `{x,y,w,h}`, drops degenerate boxes, **normalizes confidence 0..100 → 0..1**, and throws on a null/payload-less result (no fake empty success). `transcriptionPayloadFromOcr` emits provenance-only config `{source:'ocr', engine, version, lang}`. Stub-engine tests cover registry, both mapping shapes, confidence normalization, and payload shape.
- INTEGRATION-DECISIONS #9 claims vs reality:
  - `tesseract.js` in `package.json`: **7.0.0 exact** (`"tesseract.js": "7.0.0"`); installed `tesseract.js` and `tesseract.js-core` package.json versions both 7.0.0. ✓
  - LICENSE files in `node_modules`: `tesseract.js/LICENSE.md` and `tesseract.js-core/LICENSE` both read by QA — **Apache License, Version 2.0**. ✓ Licence gate (§1) passes with tesseract in the tree.
  - Postinstall exception is exactly as documented: `node_modules/tesseract.js/package.json` `"postinstall": "opencollective-postinstall || true"` — the OpenCollective funding banner only, `|| true` so it cannot fail the install. ✓
- OCR failure creates NO transcription (read, not assumed): in `TranscriptionPanel.runOcr()` the POST to the transcriptions route happens **only after** `engine.recognize()` resolves; any throw lands in the catch, which shows an error toast and creates nothing. Engine-side, `tesseract-engine.ts` throws on empty recognized text, and `mapTesseractData` throws on no data.
- Language picker is honest: the panel offers 10 codes (`eng deu fra spa ita por nld chi_sim jpn hin`), but the engine's `languages` is `['eng']` and `recognize()` throws `language data for "<lang>" is not installed (bundled: eng)` **before** `createWorker` for any other code — the failure surfaces as the OCR-failed toast with that message. No silent CDN fetch (worker/core/lang paths are all `/ocr/…` same-origin), no silent fallback to eng. (Picker offering not-yet-installed codes is the documented design; the failure is explicit.)

## 4. OCR assets — PASS (one arithmetic overstatement, §10)
- Byte-identity recomputed by QA (sha256):
  - `public/ocr/worker.min.js` = `576b7df7…f182c6d` — identical to `node_modules/tesseract.js/dist/worker.min.js`. ✓
  - `public/ocr/tesseract-core-lstm.wasm` = `66b17df6…01457c3` — identical to `node_modules/tesseract.js-core/tesseract-core-lstm.wasm`. ✓
  - `public/ocr/tesseract-core-simd-lstm.wasm` = `34e8d50c…10bea` — identical to the `tesseract.js-core` source. ✓
  - `public/ocr/lang/eng.traineddata.gz`: gunzips to raw model sha256 `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2` — **exactly** the value recorded in INTEGRATION-DECISIONS #9 (raw model 4,113,088 B; gz 1,962,155 B). ✓
  - All 8 expected files present (worker, 3 core JS, 3 core WASM, eng lang); per-file sizes match #9 exactly (worker 111,307 B; WASM 2,855,361 / 2,857,601 / 2,862,266 B; eng.gz 1,962,155 B).
- Total on disk: **10,916,582 B ≈ 10.41 MiB** — ≈10.5 MiB as claimed (see §10 for the exact-figure discrepancy in #9).
- Not in First Load: the workspace route's client-reference manifest contains **zero** `tesseract` references, and none of the 11 canonical First-Load files (§8) is a tesseract chunk. The actual library chunk (`42--ssu5nl6oh.js`, containing `tesseract.js` 7.0.0 dist) and the adapter/engine chunk (`3lrhu1cj-89kf.js`) are loaded only through the dynamic `import()` edge (`e.A(...)` promise chunk load) from the panel's Run OCR handler; the panel itself statically imports neither `tesseract.js` nor the engine module (wire-tested). The word "tesseract" appearing inside the First-Load panel chunk is only the engine-id string / provenance labels in the panel's own code — no engine code or assets ride First Load.

## 5. Real OCR smoke — PASS (genuine, not stubbed/skipped)
- Re-run in isolation by QA: `npx tsx --test --test-name-pattern="real tesseract smoke" test/transcriptions.test.mjs` → **1 pass in ~1.04 s** (consistent with #9's ~1.2 s claim).
- The test is real end-to-end OCR: it renders `HELLO VAULT` (48px on a 400×120 `@napi-rs/canvas`), calls `createWorker('eng', 1, …)` with `corePath` and `langPath` pointing at the **self-hosted `public/ocr/` copies** (not package/CDN defaults), recognizes, maps through `mapTesseractData`, and asserts the text matches `/HELLO/` and `/VAULT/`, that ≥2 word boxes exist, and that every box has positive w/h. It is not skipped in this environment and uses no stub.

## 6. Row 19 remainder — migration 0010 — PASS
- `db/migrations/0010_transcriptions_search.sql`: `refresh_search_document()` now aggregates `string_agg(tr.text)` into the new `doc_transcriptions` tsvector for **both** owning scopes — the join `transcriptions → photos ON p.image_id = tr.image_id WHERE p.subject_id = p_subject OR p.item_id = p_subject` (photo subject and parent item), soft-deleted rows excluded (`tr.deleted_at IS NULL`), and `doctext` includes the transcription text. The `ON CONFLICT` update writes `doc_transcriptions`; a GIN index on the scope and the rebuilt 4-way expression GIN index `(doc_meta || doc_notes || doc_tags || doc_transcriptions)` are included; §5 backfills all subjects.
- Broken-0001 claim is **accurate**: in `0001_init.sql` the `transcriptions` table has columns `id, image_id, text, alto_r2_key, config, status, angle, mirror, deleted_at` — **no `subject_id`** — yet `trg_search_transcriptions` was created on it executing `trg_refresh_search_document()`, which reads `NEW.subject_id` / `OLD.subject_id`. It could never fire successfully.
- Replacement trigger maps via images correctly: 0010 `DROP TRIGGER IF EXISTS trg_search_transcriptions`, new `trg_refresh_search_from_transcription()` collects OLD+NEW `image_id`s, finds every photo using that image, and `PERFORM refresh_search_document(r.photo_id)` **and** `(r.item_id)` for each; created `AFTER INSERT OR UPDATE OR DELETE`.
- Idempotent + ordering: all DDL is `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` / `CREATE OR REPLACE FUNCTION` / `DROP TRIGGER|INDEX IF EXISTS` before creation; filename sequence intact (…0008, 0009, 0010; the pre-existing 0004 gap is unchanged from prior waves).
- Search route exposes the scope: `app/api/projects/[id]/search/route.ts` — `transcriptions: sd.doc_transcriptions`, scope parser accepts `transcriptions`, and `all` is the 4-way concatenation `(doc_meta || doc_notes || doc_tags || doc_transcriptions)`; `lib/types.ts` `SearchScope` includes `'transcriptions'`.
- Caveat (non-blocking, same as prior waves): the DB-gated functional test in `test/transcriptions.test.mjs` (which extracts the shipped functions verbatim and asserts a transcription-only term is findable under both scopes, and disappears on soft-delete) skips when no scratch `DATABASE_URL` is provided, as in QA's `npm test` run. The SQL invariants above were verified by direct reading against 0001/0006.

## 7. Schema choice — PASS
- Migration 0010 adds dedicated columns on `transcriptions`: `words JSONB NOT NULL DEFAULT '[]'`, `page_width INT`, `page_height INT` (plus `created_at`/`updated_at` for stable list order), exactly per CONTRACT.md's Wave C section.
- `config` stays provenance-only in every write path QA read: manual default `{source:'manual'}`, ALTO `{source:'alto', alto:{namespace, version}}`, OCR `{source:'ocr', engine, version, lang}`. Word boxes / page geometry are never written into `config` (validated create/PATCH fields are separate columns in `lib/api/transcriptions.ts`).

## 8. Bundle — PASS (builder's number reproduced exactly)
Canonical method (INTEGRATION-DECISIONS / QA-REPORT-PARITY-B §9): `build-manifest.json` `rootMainFiles` + the `/[projectId]` route's **non-async** client-reference-manifest chunks, per-file gzipped, summed — measured by QA on QA's own production build:
- **Workspace route (`/[projectId]`) First Load JS = 213.67 KB gzip** (11 files, 0 missing; raw 725.0 KB).
- Delta vs Wave B's canonical 211.93 KB: **+1.74 KB** — exactly as claimed, far under the +40 KB/route ADR rule. No ADR needed. (The naive all-entry-JS variant script gives 129.31 KB and is not the canonical method; not used.)

## 9. Docs fix (Wave B2 figure) — PASS
- `CONTRACT.md` Wave B2 section now carries the corrected statement: First Load JS at close of Wave B2 is **211.93 KB gzip** by the canonical method (citing QA-REPORT-PARITY-B §9), explicitly **superseding the 249.59 KB figure**, with the reason recorded (non-canonical method, included async/lazy chunks, overstates by ~37.7 KB). The Wave C section's `211.93 → 213.67 KB` delta is consistent with it.

## 10. Overstatements found
1. **INTEGRATION-DECISIONS #9 total asset size (minor, non-blocking):** #9 states the self-hosted OCR assets total **10,999,072 B**. The files on disk sum to **10,916,582 B** — a difference of **82,490 B (~0.8%)**. Every per-file size #9 lists is exact and every hash QA recomputed matches its source/recorded value, so this is an arithmetic slip in the total only; the "≈10.5 MiB" characterization still holds (actual ≈10.41 MiB). Recommend correcting the total in #9 in a later docs pass.
2. Everything else claimed (147 tests, tsc clean, build green, licence PASS with only pre-existing LGPL warnings, 213.67 KB bundle and +1.74 KB delta, raw eng-model sha256, postinstall description, ~1.2 s real OCR smoke) **reproduced exactly** by QA.

**Verdict: SIGN-OFF.** Wave C (rows 13/14 + 19 remainder) is gated through. No code was changed by QA; this report is the only QA-authored file.
