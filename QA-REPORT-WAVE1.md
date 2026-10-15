# QA Report — COMPLETE EZVault, Wave 1 (supplement)

> **Seat:** QA Manager (10) · **Date:** 2026-10-15 · **Tree:** `main` @ `56c445b` (clean)
> **Scope:** Wave-1 acceptance criteria W1-H / W1-D / W1-I / W1-F / W1-C + bundle + W1-B(static).
> This is a **supplement** to `QA-REPORT.md` (v1 baseline — not re-litigated here).
> **Verdict: BLOCK** — Round 1 of 3. Two findings below (1 medium, 1 low); builders fix, QA re-verifies.

## Build verification (all green)

| Check | Result |
|---|---|
| `npm run build` | **GREEN** (exit 0). `prebuild` gates ran: `secret-scan.sh` ✓, `verify-codecs.mjs` ✓, `check-licences.mjs` ✓ (4 pre-existing LGPL warnings only, unchanged from baseline). 60+ `/api/*` routes emitted, all `ƒ` (dynamic). |
| `npx tsc --noEmit` | **CLEAN** (exit 0, no diagnostics) |
| `npm test` | **58/58 pass, 12 suites** (was 38/38 at v1; +20 Wave-1 tests). New: `idempotency-wire` (6), `idempotency-db` (DB-gated, skips), `cpu-window-db` (DB-gated, skips), `job-state-db` (DB-gated, skips), `delete-everything-wire` (11). |

## W1-H — hardening (A1–A6)

- **Migrations:** `0006_search_scoped.sql` (A1) and `0007_cpu_window_active.sql` (A5) exist, in filename order. Note: the sequence skips `0004` (pre-existing audit-phase numbering; glob-based apply `db/migrations/*.sql` is unaffected).
- **A1 (search_documents read path):** landed (`0ff098f`). Per-scope `doc_meta/doc_notes/doc_tags` tsvector columns + `doctext`, trigger-maintained, route rewritten. **p95 claim methodology (spot-checked):** migration header documents the harness — PGlite (Postgres 17 WASM), seeded 2,500 subjects × 6 metadata rows + notes + tags, 200 warm queries of the shipped route SQL → warm p95 = **139ms** scope=all (metadata 71ms, notes 75ms, tags 7ms); same harness on the OLD per-request SQL = 3,294ms (~24×). Target < 500ms met with ~3.6× headroom. The "WASM-slower-than-Neon ⇒ conservative bound" reasoning is directionally plausible but not airtight (WASM skips network RTT; the measurement is route-SQL-only, not end-to-end HTTP). The claim is honestly bounded — the header itself says "formal live re-verify post-deploy (Dossier H3)". **Assessment: methodology reasonable, claim holds as a harness measurement, not a production SLA.** Live re-verify stays OWNER-BLOCKED.
- **A2 (N+1s):** landed (`364c6ea`) — `getPhotoJsonBatch()` (one `ANY()` query), grouped selections query, items-grid subqueries batched. Commit message documents the three changes.
- **A3 (.tpy batching):** landed (`f5f1501`) — `readJsonlSubjects(jobId)` memoizes parsed jsonl per job (size+mtime-validated, bounded to 4 jobs, evicted on done).
- **A4 (clientOpId idempotency):** landed (`0fa4ce2`). `claimOp()` at `lib/db/index.ts:158-172` (`INSERT … ON CONFLICT (op_id) DO NOTHING`); DDL arbiter valid — `command_log.op_id UUID NOT NULL UNIQUE` (`0001_init.sql:273`). Bus sends per-command op_id as `clientOpId` (`lib/commands/ops.ts:60-76`); server routes read it (`lib/api/idempotency.ts`, 10+ routes). Wire tests 6/6 pass; DB-backed dedupe test exists and **skips** (no DATABASE_URL in sandbox — by design, runs post-deploy).
- **A5 (cpu window uniqueness):** landed (`37f45fe` + migration 0007). Partial unique index `cpu_budget_windows_active_uniq … WHERE active`; `currentWindow()` (`lib/cpu-budget.ts:39-53`) deactivates expired then `ON CONFLICT (active) WHERE active DO UPDATE`. Concurrency test exists, DB-gated (skips).
- **A6 (polish sweep):** landed (`f80f9d9`, `d85119c`). `import_jobs.error` surfaced verbatim in `ImportDialog.tsx:430-433` and `TpyWizard.tsx:559-564`; `lib/api/jobs.ts:34,62` shapes it as `error: string | null`.

## W1-D — design elevations (M1–M12, all 12 verified against spec)

| Item | Evidence |
|---|---|
| **D-M1** icons | `components/ui/icons.tsx` — 25 icons + `VaultMark` (24×24, 1.8px, round, `currentColor`, `aria-hidden`). Zero junk glyphs remain in `components/*.tsx` (checked 🗑🏷🔍🔗⟲⟳▢◐◑◈✎▦▤☰⋯▸▾ individually — none). |
| **D-M2** contrast | `--ink-3: #6E6656` ✓, `--accent-strong: #9C4A18` ✓ (+ dark `var(--accent)`), `--wash` ✓. All 7 spec'd selectors use `accent-strong`; do-not-change sites kept (`editor-toolbar [data-active]` stays `--accent`; tab `border-bottom-color` stays `--accent`; hover→`--wash`). Spec honesty amendment done (`phase1-design.md:221` — 5.00:1/6.95:1, "passes AA, not ≥7:1"). |
| **D-M3** treeview | `role="treeitem"` on `<li>` (`Sidebar.tsx:280`), `aria-selected`, `aria-level`, roving tabindex (`focusId` + registry), Arrow Up/Down/Right/Left handling (:250-266), chevron purely visual. |
| **D-M4** tag dots | `tagColorMap` from `useTags` (`CenterPanel.tsx:253-257`); dots render `tagColorMap.get(name) ?? "var(--ink-3)"` (:180). Conflict F1 re-verified: `Tag.color: string` (`lib/types.ts:401-406`); `useTags` returns `{items,total} \| Tag[]` handled by `tagListOf`. |
| **D-M5** headlines | `SearchHitTitle` (`CenterPanel.tsx:634-691`) — "Photo in {title}" / "Selection in {title}" via new keys; scope badges localized (`kindLabelKey`); no raw `subject_kind`. |
| **D-M6** wizard | Kind chooser with `role="radiogroup"` (`TpyWizard.tsx:318-319`); `mode: projectKind ?? (assetsFile ? "standard" : "advanced")` (:211). Conflict F2 re-verified: `/api/import/tpy/run` accepts `mode` (:25,44) — payload contract matches. |
| **D-M7** mixed | `inputPlaceholder` + `describedBy` + rendered `<p id={hintId} className="ez-hint">{t("mixedHint")}` (`MetadataForm.tsx:267-280`). |
| **D-M8** popovers | `ColorSwatchPopover` (`components/ui/ColorSwatch.tsx` — `role="dialog"`, radiogroup, Esc/click-outside); link popover in `NotesEditor.tsx` (`linkOpen`, `LinkIcon`, `notes.linkApply`). **Zero `window.prompt(` calls remain** in components/app/lib. |
| **D-M9** wordmark | `VaultMark` in TopBar (`TopBar.tsx:110-111`); `.ez-brand` Georgia 700 17px (`globals.css:199`); non-clickable div. |
| **D-M10** drawers | `useMediaQuery("(min-width: 1280px)")` gates inline widths (`Sidebar.tsx:806-816`, `Inspector.tsx:274-287`); drawers `min(86vw,340px)` / `min(94vw,560px)` (`globals.css:544-546`); `.ez-splitter{display:none}` ≤1279px (:549). |
| **D-M11a** token | `var(--line)` gone; `var(--border)` at StorageDialog (flagged line). |
| **D-M11b** JSON-LD | `setJobId` + `setRunning(true)` with **no** `setOpen(false)` (`ImportDialog.tsx:479-486`); Dialog `onClose={() => setOpen(false)}` always enabled (:501); job-progress state shown while running; known-limitation comment present. Conflict F3 re-verified: job-status contract (`"done"\|"failed"\|"cancelled"`) unchanged. |
| **D-M12** focus | `triggerRef` captures `document.activeElement` on mount, restores on cleanup (`Menu.tsx:24-27,65`). |
| **D-MICRO** | All 8 rewrites byte-exact in `messages/en.json` (verified via node): `viewer.previewNotice`, `inspector.bulkHint`, `tpy.assetsLabel`, `tpy.relinkBody`, `meter.optFlagged`/`optFlaggedHint`, `dialogs.exportStarted`, `topbar.viewGroupLabel`. The 5 do-not-touch keys untouched. Duplicate `import.duplicate*` keys deduplicated. `app.disclaimerShort` verbatim present, `disclaimerLong` absent (conflict F4). JSON parses. |
| **D-E4** empty states | `EmptyArt.tsx` (contact-sheet motif, lifted frame, `aria-hidden`); rendered in library/list (`CenterPanel.tsx:932,953`), trash (`TrashView.tsx:77`), inspector; CTAs unchanged. |
| **D-E6** photos | Inset mats on thumbs (`globals.css:297,326`); viewer well `#0d0b08` + 14px radius (:345); `themeAccent()` cache reads `--accent` per draw (`PhotoViewer.tsx:46-62`). |
| **D-E7** spacing | 4px-scale normalization committed (`a673159`); spot-checked token sites. |
| **D-E8** motion | `ez-dialog-in`/`ez-menu-in`/`ez-toast-in` keyframes + `prefers-reduced-motion` global neutralize (`globals.css:52-81`). |
| **D-INT** palette/tour/hotkeys | `cmdk`+`fuse.js` palette (`PaletteLauncher` `next/dynamic(ssr:false)`; `shouldFilter={false}`); `driver.js` tour (8 steps, `data-tour` anchors on all spec'd containers incl. `tpy-upload/analyze/map/run/report`, `import-tabs/review`, `viewer-toolbar`, `item-grid`, `sidebar-lists/tags`); `HOTKEY_REGISTRY` feeds `useRegisteredHotkeys` + the `?` overlay grouped by `shortcuts.groups`; S-3 Shift+Arrow `selectRange` wired with `anchorRef`. |

## W1-I — integrations

- `INTEGRATION-DECISIONS.md`: **3/3 entries complete** — stars re-pulled, exact license quotes (`MIT — © 2018 Johannes Klauss`; `MIT — © 2022 Paco Coursey`; `Apache-2.0` fuse.js; `MIT — © Kamran Ahmed`), bundle deltas measured, OSV zero, no postinstall, telemetry grep negative, install commands recorded.
- `node scripts/check-licences.mjs` on the final tree: **PASS** (exit 0; only the 4 pre-existing LGPL dynamic-link warnings).
- `package.json`: new deps pinned exact — `"cmdk": "1.1.1"`, `"driver.js": "1.9.0"`, `"fuse.js": "7.5.0"`, `"react-hotkeys-hook": "5.3.3"` (no carets). Older deps keep their v1 carets (out of Wave-1 scope).
- **No new vendored code.** Note: `lib/import/vendor/sql-wasm.wasm` is pre-existing v1 (sql.js binary from `5cd9f90`), not Wave-1.

## W1-F — features

| # | Evidence |
|---|---|
| **F-A** drag-reorder | Server: `?list=` responses include `li.position AS position`; default `sort=list_position` → `li.position ASC` (`items/route.ts:18,32,73`). Client: `displayItems` sorts by `item.position` when all numeric, `manualOrder` holds the drag session, reorder runs through the undoable command bus (`CenterPanel.tsx:814-850`). **Nit (non-blocking):** the comment at :814-816 ("the items endpoint does not yet return them") is stale post-`efe5df0` — update it. |
| **F-B** EmptyArt | See D-E4 above. |
| **F-C** meter | `MeterBanners` (`WorkspaceClient.tsx:89-103`): warn banner from **80%**, 95% variant, "runRetention" button opens the dialog one click away. Dialog never auto-opens (`retentionOpen` only set by button clicks). |
| **F-D** run honesty | `cancelRun` → `POST /api/jobs/[jobId]/cancel` (`TpyWizard.tsx:183-188`); determinate staging-upload progress wired (:83,127). |
| **F-E** errors | Error toasts persist until ✕; only info auto-dismisses (`Toasts.tsx:16`). |
| **F-F** delete-everything | Endpoint: body MUST be exactly `{confirm:"DELETE"}` — any deviation → 400 (`app/api/admin/delete-everything/route.ts:46-49`). Dialog: button armed only when `typed === "DELETE"` (`DeleteEverythingDialog.tsx:32,40`). Tests: `delete-everything-wire` 11/11. |
| **F-G** enrichment | `resolveItemTitles` + `resolveItemCovers` (`lib/api/item-enrichment.ts`) — batched `= ANY(...)` queries (3 passes for titles, no per-item N+1); wired into the items route (:5). |
| **F-H** 503 | `/api/health` returns **503 + `not_configured`** when `DATABASE_URL` is missing (`route.ts:46-53`); 200 otherwise. |
| **F-I** duplicates | Rejected entries carry `existing_subject_id` + `title` (one batched title lookup for all duplicate rejections; `complete/route.ts:84-90,194-220`). Duplicate-ask rows show file size (`6911973`). |

## W1-C — deploy prep

- `ENV-INVENTORY.md`: **8 names, zero values** (DATABASE_URL, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_DATA, R2_BUCKET_BACKUPS, CRON_SECRET, MASTER_KEY) — purpose, required/optional, where-set. No value leakage on scan.
- `vercel.json`: **single daily cron** `0 8 * * *` → `/api/cron/nightly`; build command `npm run build` (prebuild gates run).
- `DEPLOY-RUNBOOK.md`: one-sitting, ordered (Neon → R2 buckets → migrations in filename order → Vercel project + Deployment Protection All Deployments + 8 env vars → B7 smoke curls → cron wiring → backup-access procedure).
- **B7 smoke checklist:** owner-runnable curls — root must 302 (not 200 app HTML), `/api/health` 503 pre-env / 200 post-env, no stack/secret leakage (`DEPLOY-RUNBOOK.md:52-68`).
- **Backup-access procedure:** protection-bypass header + `CRON_SECRET` path documented (`DEPLOY-RUNBOOK.md:90-107`); restore procedure in `docs/RUNBOOK.md`.
- Live-infra items: carried in this report's "Unverifiable" section and PRD §5 — **not silently dropped** — but see blocker B2 for the runbook gap.

## Bundle (≤40KB/route rule)

Structural spot-check on the Turbopack production build (the webpack-era `/tmp/measure-*.cjs` scripts are ephemeral; the rule's substance was re-verified directly):
- `cmdk`+`fuse.js` ship in a **separate lazy chunk** (`.next/static/chunks/1huz6azk_x5zr.js`, 26.6 KB gzip) — **not** in `rootMainFiles` (first load). `PaletteLauncher` uses `next/dynamic(ssr:false)`. The claimed +0.25 KB first-load delta is consistent (launcher wrapper only).
- `driver.js` ships in its own lazy chunk (7.6 KB gzip) via `await import("driver.js")` (`TourLauncher.tsx:25`).
- `react-hotkeys-hook` is in the main bundle; shared first-load chunks total ~132 KB gzip + page chunks (within the ~207 KB totals claimed).
**Result: no route grows anywhere near 40 KB from any integration. Rule holds.**

## 5 evidence spot-checks (builder claims → verification)

1. `0ff098f` "A1: search_documents per-scope tsvector read path" → migration `0006` header documents harness + p95=139ms; `refresh_search_document()` trigger + 4 GIN indexes present in the file. **Holds.**
2. `b11e2a5` "F-C: banner-only 95% nudge" → `MeterBanners` at `WorkspaceClient.tsx:89-103`; no auto-open path exists. **Holds.**
3. `0b15ea6` "F-F: endpoint with typed-confirm contract" → exact-shape 400s at `route.ts:46,49`; dialog `armed = typed === "DELETE"` at `DeleteEverythingDialog.tsx:32`. **Holds.**
4. `fb43dea` "driver.js tour with data-tour anchors" → anchors verified on all 11 spec'd containers; `TourLauncher` dynamic-imports driver.js. **Holds.**
5. `37f45fe` "A5: cpu_budget_windows concurrency uniqueness guard" → partial unique index in migration `0007`; `ON CONFLICT (active) WHERE active DO UPDATE` in `lib/cpu-budget.ts:53`. **Holds.**

## W1-B browser pass

- **Static half (done):** ARIA roles/attributes present (treeview, radiogroup, dialog, grid, toolbar, tablist, status/alert banners, `aria-valuenow` progressbar); responsive rules (drawer widths, splitter hidden ≤1279px, inline widths gated ≥1280px); theme tokens (`--accent-strong`, `--wash`) defined in both `:root` and `[data-theme="dark"]`.
- **Real-browser half: CARRIED TO PARENT** — the 5-screen × 2-theme × 3-viewport screenshot pass (empty library, 200-item grid both densities, viewer with 3+ selections, import review queue with 50 files, storage dialog at 96%) requires a live browser, which subagents do not have. **Explicitly out of QA scope, not silently passed.**

## Binding blockers (fix → QA re-verifies)

**B1 — MEDIUM — DEPLOY-RUNBOOK.md makes a false idempotency claim about migrations 0006/0007.** `DEPLOY-RUNBOOK.md:31-33` says "(Re-running is safe — migrations 0006/0007 use `IF NOT EXISTS` / idempotent DDL patterns.)" Neither `db/migrations/0006_search_scoped.sql` nor `0007_cpu_window_active.sql` contains any `IF NOT EXISTS` guard: 0006's `ALTER TABLE … ADD COLUMN` ×4, `CREATE INDEX` ×4, and `ALTER TABLE … DROP COLUMN doc` all hard-fail on re-run ("column already exists" / "relation already exists"); 0007's `ADD COLUMN active` and `CREATE UNIQUE INDEX` likewise. If the owner re-runs the migration loop after a partial apply (exactly the scenario the sentence addresses), he gets confusing mid-loop failures. **Fix (pick one):** add `IF NOT EXISTS` guards throughout both migrations (and guard the 0006 `DROP COLUMN` + make the 0006 backfill `SELECT refresh_search_document` skip-safe), OR delete the false sentence and state "migrations apply once; re-running is not supported — use a fresh database". Owner-facing deploy doc must be true before he runs it.

**B2 — LOW — live-infra verifications not restated as OWNER-BLOCKED in the deploy docs.** PRD §5 and this report carry the Dossier H-series items (H1 CSP vs real R2, H2 rate-limit concurrency, H4 presigned round-trips, H5 302/cache-control at edge, H8 `maxDuration:300`, H9 Neon transactions under load) as owner-blocked/post-deploy — nothing is silently dropped. But `DEPLOY-RUNBOOK.md` ends at the B7 smoke test with no "post-deploy verifications" section, so the owner has no in-doc pointer to what's still outstanding after his taps. **Fix:** add a short §8 "Post-deploy verifications (Wave 2 W2-E, owner-blocked)" to `DEPLOY-RUNBOOK.md` listing the H-series items with their W2-E home. Docs-only.

## Unverifiable until live infra + deploy (explicit, carried)

- DB-gated tests (`idempotency-db`, `cpu-window-db`, `job-state-db`) — skip without `DATABASE_URL`; run against scratch Neon post-deploy.
- A1 FTS warm p95<500ms live re-verify (Dossier H3) — harness number reviewed, not a production SLA.
- R2 presign PUT/GET round-trips; CSP vs real R2 host (upload + thumbnail + 1:1 original in a real browser); rate-limit under concurrency; 302 `Cache-Control: private` at edge; `attachment` disposition.
- `.tpy` wizard end-to-end (his 48-item Advanced file is the acceptance fixture).
- Monthly backup workflow first run + restore-to-scratch spot check; `maxDuration: 300` honored on the plan.
- W1-B real-browser screenshot pass (carried to parent).

---

**Next:** builders address B1 + B2 (+ optional: refresh the stale F-A comment at `components/center/CenterPanel.tsx:814-816`), push to `main`, request QA Round 2. No sign-off until both are closed and re-verified.
