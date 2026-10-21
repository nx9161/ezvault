# QA REPORT — EZVault Full Parity Wave B (formats + data operations)

**Gate:** QA Manager, adversarial verification against tree + runtime.
**Baseline:** `main` @ `ba0af98` (matches required baseline).
**Date:** 2026-10-21. **Verdict: SIGN-OFF** (no blockers; observations below).

## 1. Full gates — PASS
- `npm test`: **126/126 pass, 0 fail** (33 suites, run live by QA).
- `npx tsc --noEmit`: exit 0, clean.
- `npm run build`: exit 0 (`.env.local` moved to `/tmp` per protocol, restored immediately after, verified back at 1097 bytes).
- `node scripts/check-licences.mjs`: PASS — only the 4 pre-existing LGPL warnings (sharp/libvips ×3, libheif-js).
- `node scripts/verify-codecs.mjs`: OK (libvips 8.18.7, sharp 0.35.5); also OK with `REQUIRE_JP2K=1` (OpenJPEG WASM present).

## 2. Row 7/34 (B1) PDF + page split — PASS
- `lib/import/magic.ts`: PDF (`%PDF-`) + JP2 (signature box + SOC) detection; `magicMatchesMimetype` maps `application/pdf`/`image/jp2|jpx|jpm`. `lib/types.ts` allowlist includes both.
- Render layer `lib/import/render.ts` exists (pdfjs-dist + @napi-rs/canvas, server-only); `lib/import/density.ts` `resolveDensity`: photo override → project default → 300; migration `0008_render_density.sql` adds `projects.default_density` (36–1200 CHECK, idempotent `IF NOT EXISTS`).
- Page-split planning (`lib/import/pages.ts` `planPageSplit`) unit-tested incl. grouped/split/clamp cases; render probe test (`test/pages-density.test.mjs` → `test/fixtures/render-probe.mts`) asserts pdfPages=2, 417×209 @150dpi, 834×417 @300dpi, JP2/J2K 200×100, TIFF 3 pages — all green in QA's run.
- Fixtures are real: `two-page.pdf` (PDF 1.4, 2 pp), `three-page.tiff`, `sample.jp2`/`sample.j2k` (verified via `file`).

## 3. B1 flag — JPEG path / job completion — PASS (1 observation)
- `components/importer/ImportDialog.tsx` `processAccepted()` drives `/api/import/process` once per accepted photo, sequentially awaited; split pages re-driven with the same staged key (server falls back to the finalized page-0 original). Plain images take the identical path (no format special-casing client-side).
- Idempotency: route checks `photos.r2_key` before processing and returns `deduped: true` without re-running the pipeline (no double counter charge on sequential retries). Completion flip is `UPDATE … WHERE status='running' AND done>=total AND failed=0` — atomic and self-guarding against double-flip. Split expansion bumps `total` in the same transaction that creates page rows, so the flip cannot fire early; a failed page leaves the job `running` with `failed>0`, recoverable via the pre-existing `/api/jobs/[jobId]/retry` route (not stranded, not falsely done).
- **Observation (non-blocking):** the dedup guard is check-then-act without a row lock; two *truly concurrent* retries of the same photo could both pass the guard. The shipped client orchestrates strictly sequentially, so this is theoretical. Recommend a follow-up hardening (conditional UPDATE on `r2_key IS NULL`) in a later wave.

## 4. Row 6b JP2 + INTEGRATION-DECISIONS #6/#7/#8 — PASS
- `lib/import/jp2-samples.ts`: pure conversion (8-bit passthrough, 9–16-bit scale-down, signed offset, >16-bit throws); `process-photo.ts` surfaces decode failures as honest **422 `undecodable`** (also for PDF). Unit tests cover all sample cases.
- Entries #6 (pdfjs-dist + @napi-rs/canvas), #7 (codec-openjpeg), #8 (fflate) each contain stars/activity, license, OSV result (zero), postinstall check (none). Spot-checked against `node_modules`: pdfjs-dist LICENSE = Apache-2.0 ✓, @napi-rs/canvas LICENSE = MIT ✓, codec-openjpeg `package.json` license = MIT (no LICENSE file, as the entry itself records) ✓, fflate LICENSE = MIT ✓.

## 5. Row 23 CSV — PASS
- Routes exist: `app/api/projects/[id]/export/csv/route.ts`, `…/import/csv/route.ts`.
- `test/csv-roundtrip.test.mjs` genuinely round-trips: build → parse → unsanitize restores original values incl. formula-injection cells (`'=SUM…` tick prefix) and `"; "`-joined multi-values.
- Migration `0009_csv_import_kind.sql`: drops/re-adds the kind CHECK with `csv` added, `IF EXISTS` guard — idempotent, correctly ordered after 0008.
- The `"; "` separator limit is documented in `CONTRACT.md` (Wave B2 section) and in the test itself.

## 6. Row 24 ZIP export — PASS
- Route streams: `createZipStream` (fflate streaming Zip) fed by `storageChunks` (4 MB ranged reads) — no full buffering of originals or the archive; only small text entries (metadata/manifest) are in memory. `test/zip-stream.test.mjs` round-trips stored+deflated entries byte-identical and asserts source errors propagate.
- Manifest (`ezvault-archive/1`) carries per-photo `sha256` + size and an honest `missing_originals` list (photos with `missing_original`/`r2_key` null are listed, never silently skipped).

## 7. Row 32 merge + copy — PASS
- Endpoints: `items/merge`, `items/merge/undo`, `items/[itemId]/copy` all exist.
- `lib/items/merge-plan.ts` is pure and covered by `test/merge-plan.test.mjs` (union semantics, survivor-wins, first-source fill). `test/merge-copy-wire.test.mjs` asserts: sources trash with reason `merge` (+ prior lists recorded), inverse stored in `command_log`, undo re-files/un-trashes, client op undoes with the DO op id.
- Copy (`lib/items/copy.ts`) copies originals + thumbs via `storage.copy()` to **fresh** `keys.original/keys.thumb` under the target project; inserts use the new keys; failed copies delete copied objects (delete-independence holds).
- Placeholder toast copy is **gone** from `lib/commands/ops.ts` (wire test asserts no "wave 2" strings); toolbar merge button enabled (no `mergeWave2` gate in CenterPanel).

## 8. Rows 28/29 print — PASS
- `app/globals.css` `@media print` goes well beyond chrome-hiding: contact-sheet layout (3-col grid, break-inside avoid, static positioning) and item-document layout (`body[data-print="inspector"]`: full-width inspector, borderless fields, image caps), plus `body[data-print="items"]` inspector suppression.
- Registry entry `print` (`mod+p`, `lib/shortcuts/registry.ts`) is honestly labelled as browser print of the current view and sets the `data-print` mode before `window.print()`.

## 9. Bundle — PASS (canonical number settled)
Measured once by QA on the production build using the method documented in INTEGRATION-DECISIONS.md (build-manifest `rootMainFiles` + the workspace route's non-async client-reference-manifest chunks, per-file gzipped, summed):
- **Workspace route (`/[projectId]`) First Load JS = 211.93 KB gzip.**
- Delta vs Wave 2 baseline 207.63 KB: **+4.30 KB** — far under the +40 KB/route ADR rule. No ADR required.
- B1's 210.58 KB was measured at the B1 commit with this same method (consistent). **B2's 249.59 KB is not reproducible under the documented method** — it evidently included async/lazy chunks; the builders overstated the bundle by ~37.7 KB. The wave is compliant either way, but B2's figure should be corrected in CONTRACT.md.

## 10. Production DB hygiene — PASS
Read-only counts via the repo's Neon driver against `.env.local`'s DATABASE_URL (connection string never printed): **total projects = 0; test-ish projects (name ILIKE test/fixture/e2e/smoke/job-state/rate-limit) = 0; csv import_jobs = 0.** No test residue in production — in fact the production DB currently holds no projects at all. (Note: DB-gated tests skip when `DATABASE_URL` is unset, as in QA's `npm test` run; B2's "ran live" claim left no trace, consistent with either self-cleaning tests or an empty DB.) Nothing deleted by QA.

## Overstatements found
1. B2 bundle figure (249.59 KB) — wrong method; canonical is 211.93 KB. Non-blocking; correct the doc.
2. Everything else claimed (126 tests, tsc, build, license gate, codec gate) reproduced exactly.
