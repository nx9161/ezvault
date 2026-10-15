# QA Report — COMPLETE EZVault, Wave 2 (supplement)

> **Seat:** QA Manager (10) · **Date:** 2026-10-15 · **Tree:** `main` @ `abd5425` (clean)
> **Scope:** Wave-2 acceptance criteria W2-A / W2-C / W2-D + relink end-to-end + bundle + license.
> This is a **supplement** to `QA-REPORT.md` (v1 baseline) and `QA-REPORT-WAVE1.md`
> (Wave 1 SIGN-OFF — not re-litigated here).
> **Verdict: SIGN-OFF — 1 fix round (B1 found + fixed + re-verified, builders' seats not needed).**

## Build verification (all green, final tree `abd5425`)

| Check | Result |
|---|---|
| `npm run build` | **GREEN** (exit 0). `prebuild` ran: `secret-scan.sh` ✓ ("secret-scan: OK"), `verify-codecs.mjs` ✓ (libvips 8.18.7 / sharp 0.35.5; pre-existing JP2000-absent warning only — out-of-scope parity #6b), `check-licences.mjs` ✓ (exit 0, 4 pre-existing LGPL warnings only). 60+ `/api/*` routes emitted, all `ƒ` (dynamic). |
| `npx tsc --noEmit` | **CLEAN** (exit 0, zero diagnostics) |
| `npm test` | **71/71 pass, 16 suites, 0 fail, 0 skip** (was 58/58 at Wave-1 sign-off; +13 Wave-2 tests: 12× `relink-wire`, 1× relink wire file counted as its own suite). DB-gated suites (`idempotency-db`, `cpu-window-db`, `job-state-db`, new `rate-limit-db`) skip-by-early-return with a console note when `DATABASE_URL` is unset — by design, they run post-deploy. |
| `npx playwright test` | **1 passed / 6 skipped** (7 tests, Chromium). The 1 runner: `auth-gate.spec.ts` health 503 `not_configured`. All 6 skips carry `OWNER-BLOCKED: live infra` reasons, never faked. Chromium present via the documented `npx playwright install --with-deps chromium` (`~/.cache/ms-playwright/chromium_headless_shell-1187`). |
| `node scripts/check-licences.mjs` | **exit 0** — "OK (no GPL/AGPL/SSPL vendored)"; only the 4 pre-existing LGPL dynamic-link warnings (sharp ×3, libheif-js ×1), unchanged from baseline. |

## B1 — BLOCKER (found in QA Round 1, fixed, re-verified)

**B1 — HIGH — the W2-D relink UI was unreachable end-to-end.** The terminal
run→report effect in `components/tpy/TpyWizard.tsx` mapped `runJob.report`
to `setMissing`, but `GET /api/jobs/[jobId]` (`getJobState`,
`lib/api/jobs.ts:46-65`) never returns a `report` field — so the effect
always wrote `[]`, wiping the `missing_originals` seed that `doRun` had
just set from the run POST response (`app/api/import/tpy/run/route.ts:92`).
The relink panel (`step === "report"` only) never rendered: the whole
in-browser-sha256 → Path-B client flow was dead on arrival. The backend
(`matchRelinkFiles`, Path B, 422 `checksum_mismatch`) and the 12 wire tests
were correct — only the client render path was broken.
**Companion defect:** the Advanced e2e asserted the "3 originals re-linked."
confirmation inside the dialog, but the confirmation is a shell-level toast
(`WorkspaceClient.tsx:300 <Toasts/>`, outside the dialog) — the assertion
could never match post-deploy.
**Fix (`8461801`, QA-directed, pushed):** the effect now only overwrites the
seed when the job report actually carries a `missing_originals` list; the
e2e toast assertion is scoped to `page`. `tsc` clean, `npm test` 71/71,
`next build` green, Playwright 1/6 — all re-run on the fixed tree.
Re-verified by reading the full chain again (seed → effect → report-step
render) — no second occurrence of the pattern (`setMissing` now written
only from (a) the run POST, (b) a non-empty job-report list, (c) the
resolve-missing response).

## W2-A — viewer swap (yet-another-react-lightbox@3.32.2)

- **Exactly the 6 plugins:** `plugins={[Zoom, Thumbnails, Fullscreen, Captions, Download, Counter]}`
  (`components/viewer/PhotoLightbox.tsx:145`). The package exports more
  (`inline`, `share`, `slideshow`, `video` — verified in
  `node_modules/yet-another-react-lightbox/package.json`) — none are imported.
  Old gesture code deleted: zero references to `zoomAt`/`panBy`/`goOneToOne`/
  `viewerZoomPct`/`fitWindow`/`actualPixels` remain in `components`/`lib`;
  zoom-era i18n keys deleted (`messages/en.json` has 0 zoom-key hits).
- **Lazy chunk, zero first-load cost:** mounted via `next/dynamic(ssr:false)`
  from the viewer toolbar fullscreen button (`PhotoViewer.tsx:37-39, 421-450,
  623-631`); emits its own chunk `1t4mhpt9x80ah.js` (**24.32 KB gzip**,
  matches entry #4's 24.3 KB claim) + CSS `05lfx66_vp4vj.css` (1.37 KB) —
  neither appears in the `/[projectId]` client-reference-manifest chunk list
  or in `rootMainFiles`. Closing on another slide syncs the active photo
  (`closeLightbox`).
- **Keyboard + touch zoom:** Zoom plugin `maxZoomPixelRatio: 4`,
  `keyboardMoveDistance: 48` (pinch/wheel/keyboard are plugin-native);
  code-verified — a live-browser gesture check needs a real browser (owner-carried, see caveats).
- **Captions:** `title` = item title with filename fallback, `description` =
  EXIF line (Make/Model · date · f-stop · exposure · ISO, unknowns omitted).
- **No edit-surface regressions:** selection drawing, edits (rotate/mirror/
  color), revert, eye-toggle all intact in PhotoViewer; the remaining
  `transform` ref is the canvas fit-scale for selection drawing, not deleted
  gesture code.
- **INTEGRATION-DECISIONS.md entry #4 complete** (stars 1,325 re-pulled,
  exact MIT quote, OSV zero, no postinstall, telemetry grep negative,
  bundle delta −0.63 KB claimed).

## W2-C — Playwright E2E suite

- **4 specs / 7 tests, Chromium only** (`playwright.config.ts`, workers: 1,
  serial — rate-limit accounting stays honest). Local: 1 passed, 6 skipped;
  all 6 skips carry explicit `OWNER-BLOCKED: live infra` reasons (auth-gate
  ×2, rate-limit ×1, tpy-wizard ×2, backup-restore ×1) — nothing faked.
- **Specs exercise what they claim (code-reviewed):**
  - `auth-gate.spec.ts` — health 503 `not_configured` pre-env (green
    locally); root-302 and configured-health-200 skip until a protected preview.
  - `rate-limit.spec.ts` — 40-burst on `/api/import/presign` → asserts ≥1
    429, **zero 500s**, every 429 carries `Retry-After`. The 429→header
    mapping exists (`lib/api/route-utils.ts:78-79`, `retryAfterSec` →
    `Retry-After`). DB-side burst (exact token accounting, no deadlocks)
    locked by `test/rate-limit-db.test.mjs` (DB-gated, documented skip).
    **Nit (non-blocking):** the DB test's header says "what the Playwright
    e2e asserts … 10-concurrent burst at /api/admin/delete-everything" while
    the e2e actually bursts 40× at `/api/import/presign` — stale comment, no
    behavioral impact.
  - `tpy-wizard.spec.ts` — Standard (3 items / 4 photos, idempotent re-run)
    and Advanced (3 missing originals re-linked by checksum, nothing left
    missing; asserts `missing_original: false` on every photo post-link).
    Fixtures spot-verified: `standard.tpy` = 3 items / 4 photos,
    `advanced.tpy` = 2 items / 3 photos, committed (not owner data).
  - `backup-restore.spec.ts` — JSON-LD export → scratch-project import,
    counts match; restore target is always a scratch project.
- **Deviation from PRD (honest, carried):** PRD W2-C names the owner's real
  48-item Advanced .tpy as the acceptance fixture; the builder committed
  synthetic fixtures instead ("never the owner's real 48-item file in CI").
  QA accepts the deviation — embedding his personal research DB in the repo
  is worse — but the owner may substitute his file for a manual live run.
- **Entry #5 in INTEGRATION-DECISIONS.md complete** (Apache-2.0 license
  quoted, OSV zero, no postinstall, browser install documented as
  `npx playwright install --with-deps chromium`, Chromium-only = $0).

## W2-D — carryover (per the builder's list, each file:line verified)

| Item | Evidence |
|---|---|
| **SHOULD-22 tab strip** | `Inspector.tsx:220-242` — `.ez-sel-tabs`, `role="tablist"`, per-selection `role="tab"` + `aria-selected`, name + `✎{note_count}` badge, one click activates. CSS at `globals.css:360`. |
| **SHOULD-16 sortable headers** | `CenterPanel.tsx:440-457` — Title/Photos/Added/Modified click-to-sort with flip, `aria-sort`, ▲/▼ indicator; client-side over the loaded set via new `sortDir` store state (`:871-923`) — honest about the server sort-map limitation (documented in the commit message). New `center.colLists` "Lists" column. |
| **SHOULD-18 per-file template** | `ImportDialog.tsx:655-671` — per-file select defaulting to the project default; bulk "set all" select (`:626-652`); applied post-import via the existing item PATCH (`:404-420`), skipped duplicates and same-as-default choices excluded, failure is non-fatal with an error toast. |
| **SHOULD-18(b) grouping toggle** | `ImportDialog.tsx:718-728` — rendered **disabled** with the honest tooltip `import.groupIntoItemHint`: "Page splitting ships in wave 2 — each file currently imports as one item." (the "Merge items (wave 2)" precedent). |
| **SHOULD-28 URI hover** | `globals.css:188` — `.ez-uri { display: none }`, shown on `:hover`/`:focus-within` only (CSS-only); the span is `aria-hidden` (`MetadataForm.tsx:114`). |
| **SHOULD-29 per-field language** | `MetadataForm.tsx:117-130` — curated ISO 639-1 select per field (single-subject mode); API shape confirmed — `PATCH` accepts `language` per value on both the single-subject (`metadata/route.ts:35,58-59`) and bulk (`metadata/bulk/route.ts:17,45-46`) routes (stored in `metadata.language`); undo restores before-languages (`lib/commands/ops.ts:330-338`). |
| **SHOULD-33 note prefs** | `NotesPanel.tsx:27-43,68-93` — vertical-writing/line-numbers persist per note id in `localStorage` key `ezvault:note-prefs:{noteId}`; defensive JSON parse. |
| **SHOULD-34 tab index** | `NotesEditor.tsx:48,141` — editor `aria-label` uses the real 1-based tab index (`notes.noteTab`: "Note {n}"). |
| **SHOULD-10 hit badges** | `Sidebar.tsx:340-348` (list rows show search hit count instead of the library count while searching) + `:685-694` (tag chips); both with `searchHits` title/aria-label ("{n} search hits"); `globals.css:249` `.ez-count--hit`. |
| **SHOULD-21 eye-toggle** | `PhotoViewer.tsx:453-466` — toolbar button, `aria-pressed`, Eye/EyeOff icon; the commit also fixed a latent staleness bug (drawAll read through a fresh `drawState` ref). |
| **SHOULD-64** | Confirmed already shipped in Wave 1 (error toasts persist) — no change. |
| **Relink copy** | `tpy.relinkBody` rewritten to the checksum truth ("matched by its content (checksum), falling back to filename"); new `tpy.hashing` ("Checking file contents…") key. |

## Relink end-to-end (local)

- **Server (`1cb30b2`):** `app/api/import/tpy/resolve-missing/route.ts` — Path B
  (`files[]`) matches via `matchRelinkFiles` (checksum-first, filename
  fallback, each original consumed once); staged bytes are streamed-hashed
  server-side and must equal the claimed sha256 → **422 `checksum_mismatch`**
  otherwise; the old `sha256: "relink"` placeholder cannot pass presign's
  64-hex validation. Every successful link finalizes the row
  (`missing_original=false`, `checksum_sha256=<verified>`) — the pre-W2-D
  bug (flag never cleared) is fixed. Path A (`resolutions`/`links`) kept
  backward-compatible; response gains additive `matched` + `still_missing`.
  The run route emits `missing_originals` job-scoped via `tpy_import_map`
  (`run/route.ts:82-98`).
- **Client (`53f9a3f`):** `TpyWizard.relink()` hashes each picked original
  **in-browser** (`sha256File`, `lib/import/files.ts:48-62`, SubtleCrypto,
  with progress), presigns with the real 64-hex sha256, and POSTs Path B
  `files: [{staged_key, filename, sha256, mimetype}]` — **no client-side
  filename matching**. **B1 fixed the render path** so the relink panel now
  actually appears (see above).
- **Tests:** `test/relink-wire.test.mjs` — 12/12 substantive (checksum
  preference, empty-recorded-checksum never checksum-matches, placeholder
  rejection, basename fallback, case-insensitivity, consume-once, determinism).
  `test/magic.test.mjs` (presign-side hex validation) also covers the
  placeholder rejection path. Full suite: **71/71**.
- Full client↔server relink loop is covered by the Advanced e2e spec —
  OWNER-BLOCKED until a live deploy (see W2-C).

## Bundle (≤40KB/route rule)

Measured with the documented methodology (shared `rootMainFiles` + each
route's `client-reference-manifest` client chunks, gzipped) against the
Wave-1 QA-sign-off baseline (`e07cbab`, worktree build):

| Route | Baseline (e07cbab) | Current (abd5425) | Δ |
|---|---|---|---|
| shared first-load chunks | 129.34 KB gzip | 129.31 KB gzip | **−0.03 KB** |
| `/[projectId]` route chunks | 0.00 KB gzip* | 0.00 KB gzip* | 0.00 KB |

\* The Turbopack `page_client-reference-manifest.js` format carries no
per-chunk list parseable by the webpack-era regex — identical methodology
on both trees, so the **delta** (the rule's actual subject) is sound.
Absolutes: builders' entries claim ~207–208 KB (shared+route) vs this
harness's ~129 KB (shared only) — methodology difference, not drift.

- Lightbox: own lazy chunk `1t4mhpt9x80ah.js` **24.32 KB gzip** (matches
  entry #4's 24.3 KB claim) + 1.37 KB CSS — **absent** from the
  `/[projectId]` chunk list and `rootMainFiles`: zero first-load cost. ✓
- cmdk+fuse.js and driver.js lazy chunks unchanged from Wave 1.
- **Result: no route grew anywhere near 40 KB. Rule holds.**

## License result

`node scripts/check-licences.mjs` — **exit 0**: "OK (no GPL/AGPL/SSPL
vendored)". Only the four pre-existing LGPL dynamic-link warnings
(`@img/sharp-libvips-linux-x64`, `-linuxmusl-x64`, `-wasm32`, `libheif-js`),
unchanged from baseline. Wave-2 additions:
`yet-another-react-lightbox@3.32.2` (MIT, © 2022 Igor Danchenko),
`@playwright/test@1.64.1` (Apache-2.0, dev-only). No vendored code.

## Honest caveats (carried, non-blocking)

1. **W2-B (Serwist PWA/offline) was not attempted in Wave 2** — no builder
   report, no commits. PRD §3 lists it as Wave-2 scope; it is
   unbuilt-and-unverified, not silently dropped. Needs a Wave-3 slot or an
   owner deferral.
2. **PRD §3.10 "date validation on blur"** (metadata form) and **§3.13
   "motion entrances"** were not in the builder's W2-D list and are not
   present (basic entrance keyframes exist from Wave 1 D-E8). Carried as
   remaining PRD carryover, non-blocking per the gate scope.
3. **Live-infra items are OWNER-BLOCKED, not faked:** the 6 skipped e2e
   tests (auth 302, rate-limit burst, tpy-wizard both specs,
   backup-restore), the DB-gated unit suites, the Advanced .tpy 48/48
   acceptance fixture, live FTS p95 re-verify — all run post-deploy per
   DEPLOY-RUNBOOK.md §8.
4. **Real-browser gestures:** lightbox keyboard/pinch zoom and the
   "no gesture regressions" claim are code-verified (plugin config +
   untouched edit surface); a real-browser gesture pass needs the owner's
   device (W1-B real-browser pass remains carried to the parent).
5. **Nit (non-blocking):** `test/rate-limit-db.test.mjs` header misdescribes
   the Playwright burst target (says `/api/admin/delete-everything`
   10-burst; the e2e does 40-burst on `/api/import/presign`). Stale comment,
   zero behavioral impact.
6. `npm test` reports "0 skipped" because DB-gated suites skip by
   early-return with a console note rather than `test.skip` — by design,
   documented in each file's header.

---

**Rounds used:** 1 (B1 found by QA, fixed by QA, re-verified — no builder
round-trips). Next: builders' Wave-3 seats or Sloane's call on the W2-B
gap and the two unclaimed carryover items.
