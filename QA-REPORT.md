# QA Report — War Room Phase 4, Project EZVault (v1)

**Seat:** QA Manager (10) · **Date:** 2026-10-14 · **Tree:** `main` @ `465d802` (clean, 8 commits)
**Verdict: BLOCK** — Round 1 of 3. Six binding findings below; builders fix, QA re-verifies.

## Build verification (all green)

| Check | Result |
|---|---|
| `npm run build` | GREEN — `prebuild` ran `secret-scan.sh` ✓, `verify-codecs.mjs` ✓ (HEIF-absent fails build), `check-licences.mjs` ✓ (no GPL/AGPL/SSPL). 60+ `/api/*` routes emitted, all `ƒ` (dynamic). |
| `npx tsc --noEmit` | CLEAN (exit 0, no diagnostics) |
| `npm test` | 27/27 pass (`tsx --test test/*.test.mjs`) — B1/B6/B13 sanitizers covered |
| QA adversarial suite (`/tmp`, not committed) | 9/9 pass — `javascript:`/tab-obfuscated/vbscript/data: links stripped (text kept), SVG `<script>`+`onload` stripped, gigapixel SVG + unparseable SVG rejected, remote JSON-LD contexts rejected, CSV `=cmd\|` cells `'`-prefixed, `isAllowedLinkUrl` ≡ `isAllowedHref` mirror across 18-URL corpus, `sentinelToMark` escapes-then-marks |
| Dev boot, no env vars | `/api/health` → 503 with clear `{"status":"degraded", detail: "DATABASE_URL is not set. Copy .env.example to .env.local…"}` — no stack leak. `/api/import/presign` → generic 500 `{"error":"internal error"}` — clean, no leak (recommend 503 `not_configured` for clarity; not blocking) |

## B1–B28 evidence map

| # | Gate | Status | Evidence / verification |
|---|---|---|---|
| B1 | Magic-byte verify at `/complete` (16 KB Range-GET, 422 + delete staged) | ✅ verified | `app/api/import/complete/route.ts:88-99` — Range-GET probe, `detectFromBytes`, 422 + `storage.delete(key)` on mismatch. Adversarial: PNG bytes with `.jpg` claim pass; script bytes 422. `lib/import/magic.ts` covers 9 formats (heic/heif split; comment is honest about the count). |
| B2 | Presigned-GET pins `attachment` + DB mimetype for originals; thumbs inline webp | ✅ verified | `app/api/projects/[id]/photos/[photoId]/file/route.ts:44-50` — disposition/contentType from DB row, filename quote-stripped. |
| B3 | 302 `Cache-Control: private, max-age=240`, never public | ✅ verified | Same file `:52-57`. |
| B4 | `MAX_PHOTO_BYTES` 200 MB at `/complete` via HeadObject → 413 | ✅ verified | `route.ts:78-82`; `lib/import/validation.ts:8`. |
| B5 | `sharp(limitInputPixels: 50M)` + pre-decode dimension check → 422 | ✅ verified | `lib/import/process-photo.ts:163-170`; same cap in `lib/export/bake.ts:47,91`. |
| B6 | Server-side SVG sanitize (strip script/handlers/style, reject unparseable) | ✅ verified | `lib/import/svg-sanitize.ts` (sax strict parse, DROP_TAGS, pixel-cap on declared dims); wired at `process-photo.ts:147-151`. Adversarial: 4/4 attacks neutralized. |
| B7 | Post-deploy unauthenticated-curl smoke test + protection settings + runbook | ❌ **BLOCK** | Not documented anywhere (README has no deploy section; grep for curl/smoke/B7/post-deploy returns nothing). Deploy-time by nature, but the runbook must exist before deploy. Fix: README "Deploy runbook" section — see blocker F5. |
| B8 | `assets.zip`: stream entries, reject absolute/`..`/symlinks, 2 GB + 20k caps → 413 | ✅ verified | `lib/import/zip-extract.ts:100-110` (path normalization), `:139-141` + `:222-235` (symlink scan), `:200-203` (caps); key-prefix + `..` check at `app/api/import/tpy/run/route.ts:48`. |
| B9 | `.tpy` ceiling 100 MB (+250 MB hard), RSS guard before sql.js | ✅ verified | `lib/import/tpy.ts:147-159` (HeadObject ceilings + `process.memoryUsage().rss` guard → 413). |
| B10 | JSON-LD `documentLoader` rejecting all remote contexts | ✅ verified | `lib/import/jsonld-context.ts:39-50` — only `https://tropy.org/v1/tropy#` served inline; `RemoteContextRejectedError` → 422. Adversarial: evil.example + schema.org rejected. |
| B11 | Depth-64 / 200k-key JSON caps → 413 on every import route | ✅ verified | `lib/api/route-utils.ts:126-187` (`parseCappedJson` + `scanDepth` + `countKeys`); used by every import route. One inconsistency (non-blocking): `app/api/projects/[id]/trash/empty/route.ts:18` uses raw `req.json()` — tiny `{confirm}` body, no import path; recommend `parseJson` for consistency. |
| B12 | Turtle/N3 50k triple cap, streaming parser | ✅ verified | `lib/import/vocab.ts:17,50`; `app/api/vocabularies/import/route.ts:9`. |
| B13 | Shared `lib/notes/sanitize.ts` wired into tpy-import / JSON-LD accept / editor / emit | ✅ verified | Canonical file `lib/notes/sanitize.ts`; frontend re-exports via `lib/link-policy.ts` (zero forks — verified no second copy). Wired: `lib/import/tpy.ts:658` (pre-storage, per-note try/catch), `lib/import/jsonld-accept.ts:332,343`, `components/inspector/NotesEditor.tsx:119` (`Link.configure(tiptapLinkOptions())`), `lib/export/jsonld.js:35` (plain-JS mirror for the backup script — differential-tested identical to TS policy across 18-URL corpus). Adversarial: 7/7. Note create/patch routes also sanitize (`lib/api/notes.ts:42`, `app/api/projects/[id]/notes/[noteId]/route.ts:39`) — beyond the gate, good. |
| B14 | `ts_headline` sentinel escaping, server-side | ⚠️ **server ✅ / client ❌ BLOCK** | Server: `lib/search/query.ts:37-43` — escape-all then sentinel→`<mark>` swap; route uses it (`app/api/projects/[id]/search/route.ts:92`). Verified adversarial: hostile text fully escaped, sentinels never leak. **Client violates the wire contract** — see blocker F3. |
| B15 | `lib/export/csv-sanitize.ts` `'`-prefix on `= + - @ \t \r` | ✅ verified | `lib/export/csv-sanitize.ts`; applied to the v1 `.tpy` report CSV (`app/api/import/tpy/report/[jobId]/route.ts`). Adversarial: 7 dangerous cells + header all prefixed. Wave-2 export CSV carries the design block in the file header. |
| B16 | Durable rate limiting (Neon `rate_buckets`, in-transaction) | ✅ implemented-unverified-live | `lib/ratelimit.ts:44-90` — atomic single-statement refill+consume under `FOR UPDATE`; wired into import/export routes (`import/complete`, `import/process`, `import/presign`, `import/jsonld`, `vocabularies/import`, `export/jsonld`, `storage/compress`). proxy.ts keeps the documented best-effort outer layer. Cannot execute without live Neon. |
| B17 | `libheif-js@1.23.5` + THIRD_PARTY_NOTICES entry | ✅ verified | `package.json: "libheif-js": "1.23.5"` (exact); `lib/import/heic.ts` browser decode; THIRD_PARTY_NOTICES.md entry present. |
| B18 | SHA-256 decision recorded + implemented | ✅ verified | Builders chose the stronger recorded option: **streaming full-file SHA-256 verification at `/complete`** (`route.ts:107-117`, `verifyStagedSha256` in `lib/import/process-photo.ts:52`) — 422 + delete staged on mismatch; 64-hex claim required. Satisfies the gate's "client sha256 advisory; server verifies size + magic bytes" alternative by exceeding it. |
| B19 | `server-only` in db module; no `process.env` in client files | ✅ verified | `lib/db/index.ts:2` has `import 'server-only'`; `secret-scan.sh:61-66` asserts no `process.env` in client-boundary files and passes. |
| B20 | `CRON_SECRET` constant-time compare | ✅ verified | `app/api/cron/nightly/route.ts:21-29` — SHA-256 digests + `timingSafeEqual` (route is `runtime='nodejs'`, so the stronger primitive is available and used); `lib/auth.ts` carries the portable loop version. Missing-secret → 500 config error; bad secret → 401. |
| B21 | `@tanstack/react-virtual` | ✅ verified | `package.json: "@tanstack/react-virtual": "^3.13.3"`. |
| B22 | THIRD_PARTY_NOTICES: libvips LGPL-2.1 + libheif LGPL-3.0, no static builds | ✅ verified | `THIRD_PARTY_NOTICES.md:8-9` — texts + source links + "never statically linked/built". sharp pinned exact (`"sharp": "0.35.5"`, no `^`). |
| B23 | Build-time license check in prebuild | ✅ verified | `package.json` prebuild runs `scripts/check-licences.mjs` (denies GPL/AGPL/SSPL, warns LGPL) — build passed with it. |
| B24 | `subjects.raw_import` named column; never read-rendered/emitted | ✅ verified | DDL `db/migrations/0001_init.sql:32`; writes at `lib/import/tpy.ts:589`, `lib/import/jsonld-accept.ts:370,457`; no read path selects it (grep: no `SELECT * FROM subjects`; shapes.ts selects explicit columns); emit excludes it (`lib/export/jsonld.js:220,262`). |
| B25 | Push protection + secret scanning on `nx9161/ezvault` | ✅ verified-live | GitHub API: `secret_scanning: enabled`, `secret_scanning_push_protection: enabled`. |
| B26 | Backup purge via crypto-shredding; "Delete everything"; 365-day disclosure | ⚠️ **partial — BLOCK (decision needed)** | Monthly workflow exists and is sound: `pg_dump --format=custom` + `pg_restore --list` + row-count verification + shared-module JSON-LD (`scripts/backup-jsonld.mjs`) → private bucket, 365-day lifecycle, secrets only via `${{ secrets.* }}`, local copies scrubbed. **NOT implemented:** per-backup data keys + master key in Vercel env (workflow header comments admit "comments, not keys"); no "delete everything destroys master key" path (project DELETE does live R2 deletes + DB cascade — `app/api/projects/[id]/route.ts:69-98` — which is correct as far as it goes); no 365-day retention disclosure in the app (About/privacy note). Fix: implement data-key encryption in the workflow + add disclosure, OR record a War Room ADR amendment accepting object-deletion purge + add the disclosure. Tech Law call — escalated via coordinator. |
| B27 | Disclaimer verbatim: README + app footer/About | ✅ verified | Long disclaimer `README.md:8-13`; short disclaimer in-app (`messages/en.json` `app.disclaimerShort`, wired via `app/layout.tsx:10`). |
| B28 | No Tropy assets/copy; SPDX headers; LICENSE + `"license": "MIT"` | ✅ verified | SPDX header on 100% of source files (ts/tsx/mjs/sh/sql/yml + `proxy.ts` — script-checked, zero missing); `LICENSE` (MIT, © 2026 Naman Parmar); `package.json` `"license": "MIT"`. Clean-room copy: UI strings original; "Tropy" appears only in nominative descriptive copy with disclaimer (GC-cleared pattern). |

## Binding blockers (fix → QA re-verifies)

**F1 — CSP breaks the R2-backed app (functional, high severity).** `proxy.ts:81-90` sets `connect-src 'self'` and `img-src 'self' blob: data:`. The R2 driver mints presigned URLs on `https://<accountId>.r2.cloudflarestorage.com` (`lib/storage/r2.ts:42-60`). Three breakages in production: (a) upload XHR PUTs to the presigned URL (`lib/import/upload.ts:48`) are connect-src-blocked; (b) the viewer `fetch()`es `file?kind=` which 302-redirects to R2 (`components/inspector/PhotoViewer.tsx:48`) — redirect target violates connect-src; (c) `<img src>` of the same 302 (`PhotoViewer.tsx:44`) violates img-src at the redirect. Only the local-fs dev driver works. **Fix:** add the R2 host to `connect-src` and `img-src` in `proxy.ts` (derive from `R2_ACCOUNT_ID` or a `R2_PUBLIC_HOST` env; keep local-driver behavior unchanged). Keep `script-src` strict.

**F2 — Folder upload files land unfiled (v1 checklist #3 broken).** `POST /api/import/folder-session` builds the nested list tree and returns per-grant `list_id` (`app/api/import/folder-session/route.ts:106-118`), but `POST /api/import/complete` accepts no `list_id` and `createPhotoRows` (`lib/import/photos.ts:45`) takes none — the client sends only `relative_path` (`components/importer/ImportDialog.tsx:266`), which the server ignores. Result: empty nested lists + all items unfiled. Checklist #3 (replaced→v1, "nested dirs → nested lists") is half-delivered. **Fix:** accept per-file `list_id` in `/complete` (or resolve `relative_path` against the job checkpoint's `dir_lists`) and insert `list_items` rows in the same transaction as photo creation; send the mapping from the client (grants already carry `list_id`).

**F3 — B14 client violates the wire contract (snippet entities double-escaped).** CONTRACT.md binds: wire format is safe HTML with `<mark>`; frontend must render as-is. `lib/search-snippet.tsx` instead re-parses into React nodes (`splitMarks`) and pushes the payload as *text*, so server-escaped entities double-escape: wire `R&amp;D` renders as literal `R&amp;D`; `don&#39;t` renders as `don&#39;t`. Reproduced with `react-dom/server`: `renderSnippet` output ≠ as-is rendering for any snippet containing `& < > " '`. The hardening intent (no `dangerouslySetInnerHTML`) is good — the implementation is lossy. **Fix:** decode the five entities (`&amp; &lt; &gt; &quot; &#39;`) in text segments before pushing as React text nodes (keep the `<mark>`-only honor rule). Delete dead `lib/search.tsx` at the same time — it exports a same-named `renderSnippet`, hardcodes sentinel constants (`\u0000ezmark\u0000`) that disagree with `lib/types.ts` (`\u2060MARK\u2060`), and its header documents a wire format (server sends sentinels) that contradicts CONTRACT.md and the actual server.

**F4 — Retention: `flagged-only` and `prune` have no server implementation (ADR-2.8 binding).** The 95% dialog offers three owner-picked modes; `compress` works (`app/api/projects/[id]/storage/compress/route.ts` honors `keep_original`), but the other two radios render disabled with "pending backend support" (`components/meter/StorageDialog.tsx:104-118`). ADR-2.8 requires the owner-picked choice among all three, never automatic. **Fix:** implement the two missing modes server-side (prune = delete regenerable previews + null keys; flagged-only = compress scope per ADR) and enable the radios. If scope is cut, that's a War Room ADR amendment, not a silent drop.

**F5 — B7 deploy gate has no runbook (docs).** No deploy/smoke-test documentation exists. **Fix:** add a README "Deploy runbook" section: (1) unauthenticated `curl` expectations — `/api/health` must 503 with the not-configured message pre-env, and the app root must land on Vercel Authentication login post-deploy (pipeline fails otherwise); (2) Vercel project settings: Authentication = Standard Protection "All Deployments"; (3) all env vars from `.env.example` set, with the explicit warning that **deploying without R2 vars silently uses the ephemeral local driver** (`lib/storage/driver.ts:82-88`) — uploads would be lost on redeploy; (4) `maxDuration: 300` verified on the plan (ADR-2.24).

**F6 — B26 crypto-shredding + retention disclosure (decision needed).** See B26 row. Either implement per-backup data keys (master key in Vercel env; "delete everything" destroys it) + add the 365-day disclosure to About, or bring a downgrade ADR to the War Room (Tech Law) accepting object-deletion purge + disclosure. Not silently droppable.

## Gap adjudications (a–h)

- **a. Folder-upload filing → BLOCK (F2).** Checklist #3's replacement promise ("nested dirs → nested lists") is functionally broken when items aren't filed. Small fix, in the photo-creation transaction.
- **b. `'ask'` duplicate policy → WAIVE (accepted workaround).** Server has no `ask` branch by design (non-skip ⇒ keep_both); the client implements ask as a faithful two-phase: first pass `skip`, per-file "Skip / Import anyway" dialog (`dupeDecisions` keyed per file + apply-to-all), kept subset resubmitted as `keep_both` (`components/importer/ImportDialog.tsx:286-360`). A stateless API cannot do interactive per-file prompts; this *is* the ask implementation. Recommend documenting it as the intended protocol (it currently says "pending backend confirmation" in a comment — that comment is stale and should be updated).
- **c. Retention at 95% → BLOCK (F4).** ADR-2.8 is explicit: owner-picked among three, never automatic. UI is honest (disabled + "pending backend support") but the ADR is unmet.
- **d. Item titles/covers in grid → WAIVE with follow-up.** List endpoint returns counts (`photo_count`, etc. — commit 465d802) but no title/cover; cards fall back to `Item <shortid>` / "Untitled" (`lib/api/types.ts:118`). No v1 checklist row requires title enrichment; UX polish → v1.1: enrich the list endpoint (title from template title-field, cover = first photo thumb).
- **e. Merge items → NOT a v1 block (#32 is wave2), but the UI over-promises.** `mergeItemsOp` (`lib/commands/ops.ts:252-270`) shows a full working confirm dialog ("Photos, notes, tags and metadata move into…") then no-ops with an error toast. Per the wave-2 scope this must not look done: gate the merge button/shortcut behind a "wave 2" disabled state with tooltip instead of a functional-looking confirm dialog. Fix alongside F-round (UI-only).
- **f. B14 divergence → NOT acceptable as-is; BLOCK (F3).** XSS-safe (proven), but output is *not* identical for conforming payloads — entities double-escape. That's a wire-contract violation with visible user impact (any `& < > ' "` in notes). Fix preserves the hardening while restoring fidelity.
- **g. B7 → BLOCK (F5, docs-only).** Deploy-time by nature, but undocumented = silently dropped. One README section.
- **h. No-env behavior → PASS.** `/api/health` gives a clear not-configured 503; routes return generic clean 500s with no stack leaks; partial-R2 config throws a clear message; local driver is the documented dev default. Recommendation (non-blocking): 503 `not_configured` instead of generic 500 on missing `DATABASE_URL`.

## v1 checklist walk (24 rows)

| # | Feature | Verdict | Proof |
|---|---|---|---|
| 1 | Multi-file import (picker) | ✅ implemented | `app/api/import/presign/route.ts` batch presign; `ImportDialog.tsx` picker → sha256 → PUT → `/complete` → `/process` |
| 2 | OS drag-and-drop | ✅ implemented | `ImportDialog.tsx` drop handler ("Drop files anywhere"), same pipeline |
| 3 | Watch-folder → folder-upload replacement | ❌ **partial → F2** | Lists created (`folder-session`), items unfiled |
| 4 | Link-by-path → R2 URLs | ✅ implemented | `lib/storage/driver.ts` key layout; no path semantics anywhere |
| 5 | Thumbnails | ✅ implemented | `lib/import/process-photo.ts` → `renderThumb` (1600px WebP q80) in `lib/export/bake.ts:89` |
| 6/6a | Formats JPG/PNG/GIF/WEBP/SVG/TIFF + HEIC/AVIF | ✅ implemented | `lib/import/magic.ts` allowlist; HEIC→JPEG in-browser via libheif-js (`lib/import/heic.ts`, exifr EXIF) |
| 8 | Photo edit: rotate/mirror/pan/zoom/fit | ✅ implemented | `components/inspector/PhotoViewer.tsx` (canvas transforms, R rotate, 0/1 zoom) |
| 9 | Edit params: brightness/…/sharpen/invert | ✅ implemented | `POST …/photos/[photoId]/edits` + `…/revert`; CSS-filter preview + `previewNotice` string (preview≈bake except sharpen, disclosed) |
| 10 | Export with edits baked (PNG/JPG) | ✅ implemented | `lib/export/bake.ts:37` (`bakeImage`, fixed pipeline order per arch §6.4) + export routes |
| 11 | Selections (own template + notes) | ✅ implemented | Selections routes + own subjects; export region route |
| 12 | Notes (TipTap v3) | ✅ implemented | `components/inspector/NotesEditor.tsx` (ssr:false, StarterKit + underline/superscript/subscript/link, vertical-writing + line-numbers extensions, 1.5s autosave + keepalive flush, link policy via `tiptapLinkOptions`) |
| 15 | Templates: CRUD + .ttp import/export, DC vocabs | ✅ implemented | Templates routes; `.ttp` import validates JSON shape; vocabularies read-only + N3 import (B12) |
| 16 | Bulk metadata edit | ✅ implemented | `POST …/metadata/bulk` + bulk items ops; mixed-values UI strings |
| 17 | Lists (nested, cycle-protected) | ✅ implemented | Lists routes; `…/lists/[listId]/move` (DB cycle guard); UI cycle error string |
| 18 | Tags (colored, case-insensitive) | ✅ implemented | Tags routes (CITEXT); attach/detach |
| 19 | Full-text search | ✅ implemented* | `app/api/projects/[id]/search/route.ts` (websearch_to_tsquery, ts_rank_cd, badges); *snippet rendering blocked by F3 |
| 20 | JSON-LD export | ✅ implemented | Export route + shared `lib/export/jsonld.js` (Tropy envelope + selections extension) |
| 21 | JSON-LD import | ✅ implemented | `app/api/import/jsonld/route.ts` + `lib/import/jsonld-accept.ts` (template-URI matching, unknown keys → raw_import) |
| 22 | .tpy import (Standard + Advanced) | ✅ implemented-unverified-live | 5-step wizard UI (`components/tpy/TpyWizard.tsx`: upload/analyze/map/run/report) + routes (presign/upload-complete/analyze/run/resolve-missing/report); application_id hard-reject, user_version pin, 50-item txns, `tpy_import_map` idempotency, CSV report (B15). End-to-end run needs live Neon/R2 + a real .tpy. |
| 29 | Keyboard shortcuts | ✅ implemented | `components/shortcuts/useGlobalShortcuts.ts` (typing guards, ? overlay, undo/redo/trash/view) |
| 30 | Undo/redo | ✅ implemented | `lib/commands/bus.ts` (cap 100, redo cleared on push); ops incl. compound import undo (`POST /api/jobs/[jobId]/undo`) |
| 31 | Trash w/ reason codes + restore | ✅ implemented | Trash routes (reasons user/auto/merge), restore re-files lists, irreversible empty with audit |
| 33 | Duplicate detection | ✅ implemented | Dual-checksum dedupe at `/complete` (`createPhotoRows`); policy skip/keep_both/ask honored (ask = F2-adjacent client two-phase, waived per (b)) |
| 35 | Themes (light/dark); locales cut | ✅ implemented | Theme toggle + pre-paint bootstrap (`app/layout.tsx:15`); next-intl EN-only, every string via `useTranslations` (spot-checked `messages/en.json` — comprehensive) |

Wave2/3 rows: correctly **not** claimed — no `/export/csv`, `/export/zip`, Omeka, IIIF, OCR/ALTO routes or UI exist (only code comments marking wave2+). #32 merge: present-but-disabled-honestly-ish — see (e); must not look functional (UI fix in F-round).

## Residual risks (carried honestly)

1. **B16, .tpy end-to-end, presigned R2 flows, FTS ranking quality** are `implemented-unverified-live` — no Neon/R2 exist yet; first deploy must exercise: upload → process → search → export, a real .tpy import (Standard + Advanced re-link), and rate-limit behavior.
2. `verify-codecs.mjs` asserts a registered HEIF loader in the sharp prebuild; the HEVC *decode* path remains browser-side per ADR-2.16 (measured-impossible server-side) — the gate stays loud by design.
3. Presigned URLs are bearer <redacted> (5/15-min TTLs are the control); Vercel Authentication is the single-user gate — session compromise on the owner's machine is the crown-jewels vector (out of scope, per phase-3 residual).
4. `lib/export/jsonld.js` carries a plain-JS mirror of the link policy (backup-script constraint) — differential-tested identical today; any future policy change must update both (a test asserting equivalence should be committed).
5. Undo is session-scoped in-memory (binding per ADR-2.14); cross-tab uses the rev banner.

## Unverified until live infra + deploy (explicit)

- B7 post-deploy curl smoke test (documented in F5, executed at deploy).
- B16 rate-limit enforcement under concurrency; FTS `<500ms warm` target (phase2 §12e).
- `.tpy` wizard end-to-end (his 48-item Advanced file is the acceptance fixture).
- R2 presign PUT/GET round-trips, 302 `Cache-Control: private` at the edge, `attachment` disposition behavior.
- `maxDuration: 300` on the Vercel plan (ADR-2.24); Neon HTTP-driver interactive-transaction adaptation under load.
- Monthly backup workflow run (first scheduled run + restore-to-ephemeral-branch spot check).
- The F1 CSP fix must be re-verified against the real R2 host (upload + thumbnail + 1:1 original in a real browser).

---

**Next:** builders address F1–F6 (+ the (e) merge-button honesty fix and the stale "pending backend confirmation" comment in `ImportDialog.tsx:294`), push to `main`, and request QA round 2. No sign-off until all six are closed and re-verified.
