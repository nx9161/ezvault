# EZVault build contract — Phase 4 (War Room agreed)

Two builders work in parallel. The API surface in
`~/workspace/virtual-office/repo/memory/wings/projects/tropy-cloud/phase2-architecture.md`
§2 is the contract between them — neither changes a route's method, path, or
request/response shape without updating this file AND notifying the other
builder via the coordinator.

## Directory ownership (no overlaps)

**Lead Backend Dev owns:**
- `app/api/**` (every route handler; ALL `runtime='nodejs'`)
- `lib/db/**` (Neon HTTP driver wrapper; MUST `import 'server-only'`)
- `lib/storage/**` (S3-API StorageDriver: R2 now, B2 fallback later)
- `lib/import/**` (upload pipeline, .tpy wizard via sql.js, JSON-LD accept, vocab N3)
- `lib/export/**` (JSON-LD emit — shared module also used by the backup workflow; CSV report + csv-sanitize)
- `lib/notes/sanitize.ts` (THE shared sanitizer — backend writes it first; frontend consumes it; B13)
- `lib/search/**` (query building; snippet sentinel logic lives in the route)
- `lib/ratelimit.ts`, `lib/cpu-budget.ts`, `lib/auth.ts` (CRON_SECRET compare)
- `db/migrations/**` (numbered SQL; the DDL from architecture §3 + FTS triggers §4)
- `proxy.ts` — Next 16 renamed `middleware.ts` → `proxy.ts` (middleware.ts is
  deprecated; we ship ONLY proxy.ts). Same duties: CSRF origin check on
  mutating routes; strict CSP (zero inline scripts); security headers;
  best-effort in-memory token-bucket outer layer (durable rate limiting is
  `lib/ratelimit.ts`, B16).
- `scripts/**` (`secret-scan.sh`, `verify-codecs.mjs`, `check-licences.mjs`)
- `.env.example`, `.github/workflows/backup-monthly.yml`

**Lead Frontend Dev owns:**
- `app/**` EXCEPT `app/api/**` (pages, layouts; ONE client `<WorkspaceClient>`)
- `components/**`, `lib/store/**` (Zustand), `lib/commands/**` (undo),
  `lib/viewer/**` (Canvas-2D), `messages/**` (next-intl EN)
- `app/globals.css` (design tokens from phase1-design §3 — already seeded; extend, don't restyle)
- `public/**` (static assets; original artwork only)

## Shared handoff order

1. Backend writes `lib/notes/sanitize.ts` + `lib/types.ts` FIRST and pushes.
2. Frontend consumes them; never forks its own copy.

## Search snippet contract (B14 — binding)

- `GET /api/projects/[id]/search` returns snippets whose highlight markup is
  produced server-side: `ts_headline` is called with unique sentinel
  StartSel/StopSel tokens (see `lib/search/query.ts` `headlineOptions()`),
  the whole headline is HTML-escaped, then sentinels are swapped for
  `<mark>`/`</mark>` (see `sentinelToMark()`).
- The wire format is **safe HTML containing `<mark>` elements** — the
  frontend must render `snippet` as HTML as-is and MUST NOT re-split or
  re-escape it. No client-side sentinel handling; the sentinels never appear
  in the wire payload.

## Import /complete — per-file filing (F2 — binding)

- `POST /api/import/complete` accepts per-file `listId` (snake_case alias
  `list_id` also accepted) — the `list_id` carried on each grant returned by
  `POST /api/import/folder-session`.
- When a file has no explicit `listId` but the job is a folder job and the
  file carries `relativePath` (`relative_path` alias accepted), the server
  resolves the parent directory against the job checkpoint's `dir_lists`
  (server-minted by folder-session) as a fallback.
- Every `listId` is project-scoped before use: a `list_id` outside the
  project rejects that file with `422:list_not_found` — never silently
  misfiled.
- Filing inserts `list_items` rows in the SAME transaction as the photo
  commit (`createPhotoRows`, `lib/import/photos.ts`); positions append at
  the end of the target list.
- `relativePath` is stored as `photos.relative_path` (migration
  `db/migrations/0003_relative_path.sql`) — **audit only**: never
  read-rendered, never emitted in any export payload.
- Type: `ImportCompleteFile` in `lib/types.ts`.

## Storage retention modes (F4 — binding, ADR-2.8)

`POST /api/projects/[id]/storage/compress` — the owner picks one mode per
run; nothing is ever automatic.

Request:
```json
{
  "mode": "compress",
  "photoIds": ["<photo-subject-id>", "..."],
  "clientOpId": "<uuid>"
}
```
- `mode` — `'compress'` (default when omitted — the pre-F4 `POST {}`
  shape) | `'flagged-only'` | `'prune'`.
- `photoIds` — REQUIRED for `flagged-only` (the owner-picked set from the
  95% dialog; 400 when empty); optional filter for `compress`; ignored by
  `prune`. Legacy alias `photo_subject_ids` is accepted — prefer `photoIds`.
- Modes:
  - `compress` — all eligible originals (`keep_original=false`, present,
    non-WebP) → WebP q80 via write→verify→swap→delete; up to 50 per call.
  - `flagged-only` — compress ONLY `photoIds[]` (same 50/call cap).
  - `prune` — permanently delete photos already in trash: directly-trashed
    photo subjects plus photos under trashed items (their items stay
    trashed, photoless). R2 original+thumb objects are deleted first; then
    in-transaction: `deleted_photos` audit rows, `storage_counters`
    decrements, subject row deletes (trash rows cascade). Irreversible — no
    undo.
- Every mode is CPU-guarded (503 when the budget window is spent, B16) and
  CPU-charged; `parseCappedJson` depth/key caps apply to the body (B11).

Response (`compress` / `flagged-only`):
```json
{
  "mode": "compress",
  "results": [
    { "photo_subject_id": "<uuid>", "status": "compressed", "bytes_saved": 12345 },
    { "photo_subject_id": "<uuid>", "status": "skipped:no_savings" },
    { "photo_subject_id": "<uuid>", "status": "failed:empty_original" }
  ],
  "processed": 3
}
```
Response (`prune`):
```json
{
  "mode": "prune",
  "irreversible": true,
  "deleted_photos": 12,
  "r2_deleted": 24,
  "bytes_reclaimed": 98765432
}
```
Types: `StorageCompressRequest`, `StorageCompressResponse`,
`StoragePruneResponse` in `lib/types.ts`; prune implementation
`pruneTrashPhotos()` in `lib/api/shapes.ts`.

## Wave B1 — PDF/JP2000 import, render density, page splitting (rows 7/34/6b)

- Upload allowlist gains `application/pdf` + `image/jp2` (`UPLOAD_MIMETYPES`,
  magic bytes in `lib/import/magic.ts`: `%PDF-`, JP2 signature box, J2K SOC).
- PDF/JP2000 decode server-side via `lib/import/render.ts` (pdfjs-dist +
  @napi-rs/canvas; OpenJPEG WASM) — the pinned libvips decodes neither.
- Density (PPI): `projects.default_density` (migration 0008, PATCH
  `/api/projects/[id]` accepts `default_density` 36..1200) → per-file
  `density` on POST `/api/import/complete` files[] → `photos.density`
  (PATCH `/api/projects/[id]/photos/[photoId]` accepts `density`, null
  clears). Resolution order: photo → project → 300 (`lib/import/density.ts`).
- Page splitting: multi-page PDF/TIFF imports create one photo row per
  page (`photos.page`, 0-based). POST `/api/import/complete` files[] accept
  `groupIntoItem` (pages share one item; absent = one item per page),
  stashed as job checkpoint `group_pages`. POST `/api/import/process`
  response gains `split_photo_ids` (rows the client must process next,
  same staged key); an upload job flips to `done` when done ≥ total.

## Binding rules (from the War Room — non-negotiable)

- Clean-room: ZERO Tropy code, icons, copy, or artwork. All UI copy is original.
- SPDX headers on every source file: `// SPDX-License-Identifier: MIT`
- No secrets in code, ever. `.env.example` placeholders only.
- `npm run build` green + `tsc` clean at every push.
- Conventional commits; push to `main` as features land (owner's standing order).
- This Next.js version has breaking changes — read `node_modules/next/dist/docs/`
  before writing any code (per the scaffold's agent rules).

## Wave B2 — CSV / archive export, merge, copy, print (rows 23/24/32/28 + 29 remainder)

- CSV export: GET `/api/projects/[id]/export/csv` (`?itemId=` |
  `?itemIds=a,b,c` | neither = whole project). One row per item; header =
  `id,template` + the union of the items' template property URIs
  (template field order, then non-template properties sorted); multi-value
  cells join with `"; "`; every cell passes the B15 sanitizer
  (`lib/export/csv-export.ts`). Trashed items are excluded from all B2
  exports.
- CSV import: POST `/api/projects/[id]/import/csv` `{ csv, template_id }`
  → `{ job_id, imported, failed, errors: [{row, message}], item_ids, rev }`
  (201). Headers are property URIs; `id`/`template` columns are ignored;
  each data row becomes a NEW item under the chosen template (datatype
  from the template field when known). Ingest unsanitizes the B15 tick
  prefix so export→import round-trips restore original text. Runs the
  import-job pattern (kind `csv`, migration 0009); bad rows are reported
  and skipped, never half-imported (per-row transaction). Caps: 5000
  rows, 200 columns, 4.5 MB body. Known limit: a single value containing
  the two-character sequence `"; "` splits into two values on import
  (separator ambiguity, same class as the reference CSV plugin).
- Archive ZIP export: GET `/api/projects/[id]/export/zip` (same scope
  params). Streamed response, never staged: `metadata.json` (the JSON-LD
  document for the scope; notes included), `manifest.json`
  (`ezvault-archive/1`: per-photo sha256/size + honest `missing_originals`
  list), and one folder per item (`<title>--<id8>/`) holding each photo's
  ORIGINAL bytes (stored, ranged-read in 4 MB chunks; `lib/export/
  zip-stream.ts`, fflate — INTEGRATION-DECISIONS.md #8). NOT the
  encrypted monthly backup.
- JSON-LD builder: `buildProjectJsonLd` gains an additive `opts.itemIds`
  selection filter (backup callers unaffected).
- Merge: POST `/api/projects/[id]/items/merge` `{ target_id, source_ids,
  clientOpId? }` → `{ merged_into, trashed, photos_moved, notes_moved,
  rev }`. ONE transaction, planned by `lib/items/merge-plan.ts`. Rule
  (binding): survivor's metadata values win; a property the survivor
  lacks fills with ALL values from the first source (request order) that
  has it; photos append after the survivor's (source order preserved);
  item-notes move; tags + list memberships union; cover kept, else first
  moved photo's image. Sources trash with reason `merge` (prior lists
  recorded). Undo: POST `/api/projects/[id]/items/merge/undo`
  `{ clientOpId }` applies the inverse stored in the merge's command_log
  payload (photos/notes back, added tags/lists/metadata-links removed,
  cover restored, sources un-trashed and re-filed). Same op id +
  undone row = redo (merge re-runs, inverse refreshed); same op id +
  live row = replay (no-op). mod+shift+m and the toolbar button both run
  `mergeItemsOp`; the toolbar asks first (confirm dialog).
- Copy to project: POST `/api/projects/[id]/items/[itemId]/copy`
  `{ target_project_id }` → `{ item_id, target_project_id, photos_copied,
  selections_copied, notes_copied, rev }` (201). Deep copy: new rows for
  subjects/items/images/photos/selections/metadata values+links/
  taggings/notes; originals + thumbnails copied via `storage.copy()` to
  FRESH keys under the target project (delete-independence is binding —
  no shared keys, ever); failed copies delete their copied objects.
  Template maps by URI, else name, else is copied into the target; tags
  map by name (created with source color when missing). Lists are NOT
  copied (copy lands unfiled); transcriptions are not copied (wave-C
  table, no v1 data). Target counters + rev bump in the copy transaction.
- Print (rows 28 + 29): Ctrl/Cmd+P is registered (`print` in
  `lib/shortcuts/registry.ts`, labelled "Print current view (browser
  print)" in the `?` overlay). It sets `<body data-print>` — `inspector`
  when the inspector is open on an item (item document: photo + metadata
  + notes), else `items` (contact sheet: thumbnails + titles + key
  metadata) — and calls `window.print()`; the layouts live in the
  `@media print` block of `app/globals.css` (`@page` margins, chrome
  hidden). Honest limit: the grid is virtualized, so the contact sheet
  covers the items currently loaded in the view.
