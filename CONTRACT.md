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
  selections_copied, notes_copied, transcriptions_copied, rev }` (201).
  Deep copy: new rows for
  subjects/items/images/photos/selections/metadata values+links/
  taggings/notes/transcriptions; originals + thumbnails copied via `storage.copy()` to
  FRESH keys under the target project (delete-independence is binding —
  no shared keys, ever); failed copies delete their copied objects.
  Template maps by URI, else name, else is copied into the target; tags
  map by name (created with source color when missing). Lists are NOT
  copied (copy lands unfiled). Target counters + rev bump in the copy transaction.
- Bulk copy + copy/paste (row 32 fix, 2026-10-21, commit `7881329`): POST
  `/api/projects/[id]/items/copy` `{ item_ids, target_project_id }` →
  `{ target_project_id, copied: […CopyResult + source_item_id],
  failed: [{ item_id, error }] }` (201). Each item copies independently;
  a failure is reported with its reason and never stops or rolls back
  the others. Transcriptions copy too: every non-deleted transcription
  row of a copied photo's image is re-inserted against the NEW image id
  (text/config/status/angle/mirror/words/page_width/page_height
  verbatim) and a stored ALTO object is copied to the new row's fresh
  key (`keys.transcription(target, newId)`), joining the same rollback
  list as the photo originals — so the 0010 search trigger makes the
  copy searchable in the target project on insert. App clipboard:
  "Copy to project…" (selection bar / Ctrl/⌘+Shift+C) stores item refs
  (source project id + item ids) in localStorage (`lib/items/
  clipboard.ts`; no server clipboard table); "Paste items" (center
  header button / Ctrl/⌘+Shift+V) in any project runs the bulk copy
  for all refs and toasts honest copied/failed counts. The Inspector's
  single-item "Copy to project…" menu uses the same bulk path.
- Bundle (corrected 2026-10-21, Wave C Task 0): the workspace route's
  First Load JS at the close of Wave B2 is **211.93 KB gzip**, measured by
  QA with the canonical method in INTEGRATION-DECISIONS.md
  (build-manifest `rootMainFiles` + the route's non-async
  client-reference-manifest chunks, per-file gzipped, summed;
  QA-REPORT-PARITY-B.md §9). This supersedes the 249.59 KB figure quoted
  during Wave B2, which was measured with a non-canonical method that
  included async/lazy chunks and overstates first load by ~37.7 KB.
- Print (rows 28 + 29): Ctrl/Cmd+P is registered (`print` in
  `lib/shortcuts/registry.ts`, labelled "Print current view (browser
  print)" in the `?` overlay). It sets `<body data-print>` — `inspector`
  when the inspector is open on an item (item document: photo + metadata
  + notes), else `items` (contact sheet: thumbnails + titles + key
  metadata) — and calls `window.print()`; the layouts live in the
  `@media print` block of `app/globals.css` (`@page` margins, chrome
  hidden). Honest limit: the grid is virtualized, so the contact sheet
  covers the items currently loaded in the view.

## Wave C — Transcriptions, OCR, transcription search (rows 13/14 + 19 remainder)

- Schema (migration `0010_transcriptions_search.sql`): word boxes live
  in dedicated columns — `transcriptions.words` (JSONB array of
  `{text,x,y,w,h,confidence?}` in page coordinates), `page_width` /
  `page_height` (the coordinate space: ALTO `<Page>` size, or photo
  pixels for OCR/manual) — NOT inside `config`, which is provenance
  only. The migration also adds `created_at`/`updated_at` (stable list
  order) and the `doc_transcriptions` search scope (below).
- Addressing: transcriptions hang off `images` (`image_id` FK); the API
  is photo-addressed and resolves photo subject → `photos.image_id`
  (project-scoped) server-side (`lib/api/transcriptions.ts`).
- Routes:
  - `GET|POST /api/projects/[id]/photos/[photoId]/transcriptions` —
    list (paginated, `{items,total}`) / create. Create body:
    `{text, config?, status?, angle?, mirror?, words?, page_width?,
    page_height?, clientOpId?}` → 201 + the row (+`rev`). Provenance:
    `config.source` defaults to `'manual'`; an explicit source (the OCR
    client sends `'ocr'`) is preserved. Create is idempotent via
    `clientOpId` (notes pattern). `page_width/height` default to the
    photo's pixel size.
  - `POST /api/projects/[id]/photos/[photoId]/transcriptions/alto`
    `{xml}` (B11 caps) — parses ALTO (`lib/transcription/alto.ts`, the
    repo's `sax` approach), stores the ORIGINAL XML in R2 at
    `keys.transcription(projectId, id)`, creates the row with
    `config = {source:'alto', alto:{namespace, version}}`; parse
    failure = 400 with NO row and NO stored object; insert failure
    deletes the stored object.
  - `GET|PATCH|DELETE /api/projects/[id]/transcriptions/[tid]` — PATCH
    accepts the create fields (partial); DELETE is a soft delete
    (`deleted_at`); reads exclude soft-deleted rows.
  - `GET /api/projects/[id]/transcriptions/[tid]/alto` — 302 to a
    presigned download of the stored ALTO XML (404 when none stored).
  - `GET /api/projects/[id]/transcriptions/[tid]/text` — plain-text
    download straight from the row.
- angle/mirror semantics (binding): they describe the WORD-BOX space
  relative to the stored image — `0`/`false` = boxes in stored-image
  coordinates (the normal ALTO/OCR case; the create default). A producer
  that recognized a rotated/flipped rendering records that orientation;
  the viewer inverts it before applying the photo's display transform.
  They are NOT a snapshot of the photo's edit params.
- Viewer text layer: the most recent transcription WITH word boxes
  renders as transparent selectable spans over the photo in
  `PhotoViewer` (`.ez-text-layer`), positioned page → photo pixels →
  transcription-space correction → the viewer's fit/rotate/mirror
  transform. Without boxes there is no overlay; the Transcription
  panel's text (Inspector, viewer tab) is the selectable surface.
- OCR (row 14): adapter contract in `lib/ocr/adapter.ts` (`OcrEngine`:
  `id`, `version`, `languages`, `recognize(image, {lang, onProgress})`
  → `{text, words[]}` in image pixel coordinates; confidences stored
  0..1). One real engine: Tesseract.js 7.0.0, client-side worker,
  self-hosted assets under `public/ocr/` (CSP decision +
  sizes in INTEGRATION-DECISIONS.md #9), dynamic-imported on first Run
  OCR only. OCR runs on the photo's thumbnail and scales word boxes
  into photo pixel space; the result lands as a normal transcription
  (`config = {source:'ocr', engine:'tesseract', version, lang}`),
  editable like any other. OCR failure throws and creates NOTHING.
  Bundled language data: `eng` only; other picker codes fail honestly.
- Search (row 19 closed): `refresh_search_document()` aggregates
  `transcriptions.text` into `doc_transcriptions` for BOTH owning
  scopes (the photo subject and its parent item), `doctext` included;
  the broken 0001 trigger (it referenced a nonexistent `subject_id`
  column on transcriptions) is replaced by an image-mapping trigger.
  Search route scope gains `transcriptions`; `scope=all` is the 4-way
  vector concatenation (expression GIN index rebuilt to match).
- Bundle: workspace First Load JS **211.93 → 213.67 KB gzip (+1.74 KB)**
  (canonical method, INTEGRATION-DECISIONS.md) — the transcription
  panel + text layer only; all OCR code/assets are on-demand. No ADR
  needed.
- Known limits: multi-page ALTO documents use the FIRST `<Page>`'s
  geometry (words from later pages are kept in reading order but share
  page 1's coordinate space). The former limit "copy-to-project does
  not copy transcriptions" is REMOVED by the row-32 fix (2026-10-21,
  commit `7881329` on branch `fix/row32-copy-complete`): copied photos carry their
  transcriptions (rows + ALTO objects) into the target project — see
  the Wave B copy section above.

## Wave D — Integrations + Developer API (rows 25/26/36)

- Schema (migration `0011_wave_d.sql`): `omeka_settings` (per project;
  `credential_cipher` is the ONLY credential column — AES-256-GCM
  ciphertext, `v1:<iv>:<tag>:<ct>` base64, key derived from MASTER_KEY
  via scrypt in `lib/crypto/master-key.ts`), `omeka_sync` (item →
  remote id/url, `media_map` photo→media, last status/error),
  `api_tokens` (name, `token_hash` SHA-256 UNIQUE, display `prefix`,
  `scopes` JSONB, created/last-used/expires/revoked); `import_jobs`
  kinds gain `'omeka'` + `'iiif'`.
- Omeka S push (row 25): client `lib/omeka/client.ts` (public Omeka S
  REST spec; key auth as `key_identity`/`key_credential` query params;
  property ids resolved via GET /api/properties). Mapping is by
  property URI: `dc/terms/*` and `dc/elements/1.1/*` → `dcterms:<local>`
  literal values; non-DC properties and terms missing on the target
  site are returned as `warnings`, never faked. Item notes append as
  extra `dcterms:description` values. Photos attach once via the `url`
  ingester from a 1-hour presigned GET (`media_map` tracks attachments).
  Sync state makes re-push a PUT update, never a duplicate: the
  `omeka_sync` row is persisted IMMEDIATELY after a successful
  create/update, before media attach, and a media-attach failure lands
  as `last_status='warning'` + `last_error` on that row (and in the
  push warnings) so a re-push retries the unattached photos on the
  update path. Client fetch hygiene: the base URL must be https (the
  key credential travels in the query string; `http://` is allowed
  ONLY for loopback hosts, e.g. a local dev instance, and is refused
  at settings-save otherwise); every request has a 30s
  AbortController timeout and responses are read through the
  fetch-guard's streaming byte cap (10 MiB). Routes:
  `GET|PUT /api/projects/[id]/omeka/settings` (view NEVER carries the
  credential; a credential save without MASTER_KEY fails
  `400 not_configured` and stores nothing), `POST .../omeka/push`
  `{item_id}` (Omeka errors surface as `omeka_error` with their
  status + body excerpt), `POST .../omeka/push-project` (job kind
  `omeka`; per-item results in `report` carry the same status +
  excerpt as message text). UI: Project settings Omeka section
  (save + push whole project), Inspector "Omeka" button (push item).
  NO live Omeka instance exists — unit tests mock fetch; live
  verification is owner-side against a real Omeka S site.
- IIIF import (row 26): `POST /api/projects/[id]/import/iiif`
  `{manifest_url, template_id?}` → `{job_id, list_id, manifest_label,
  version, imported, skipped, failed, results[]}` (201). Count
  semantics: `imported` counts canvases whose photo was created;
  a canvas whose photo dedupes against an existing photo counts as
  `skipped` (status `duplicate`), never as imported. A canvas whose
  harvest FAILS — and a duplicate canvas — has its pre-created
  item/note removed again, so failed/skipped canvases leave nothing
  behind. Parser
  `lib/iiif/manifest.ts` (Presentation v2 sequences/canvases + v3
  items; first painting image per canvas; Image API service ids
  normalized to `{service}/full/max/0/default.jpg`). Choice
  (documented): ONE ITEM PER CANVAS, grouped in a list named from the
  manifest label. All fetches go through `lib/fetch-guard.ts` (https
  only; private/loopback/link-local/CGNAT/reserved IP literals +
  local hostnames rejected; redirects re-validated per hop; byte
  caps enforced WHILE streaming — the read aborts past the cap).
  IPv6 literals are expanded before range checks, and embedded-IPv4
  forms are unwrapped and checked as IPv4. Scheme audit (fix B2-R,
  re-gate round 2 — every IPv6 transition/translation scheme that
  embeds an IPv4 in the low 32 bits): IPv4-mapped `::ffff:0:0/96`
  (dotted AND canonical hex tails — a dotted tail expands to the same
  groups, so the marker-group check fires either way);
  IPv4-translated `::ffff:0:0:0/96` (RFC 6052/7915 SIIT — the 0xffff
  marker sits one group earlier than mapped); deprecated
  IPv4-compatible `::/96` (dies via the same leading-zeros branch —
  embedded address range-checked; also covers `::1`); NAT64
  `64:ff9b::/96` + local `64:ff9b:1::/48` (BOTH the contiguous and the
  RFC 6052 u-octet-split /48 embeddings checked); 6to4 `2002::/16`
  (site IPv4 in groups 1–2); Teredo `2001::/32` (server IPv4 stored
  plain and checked; the client IPv4 in the interface identifier is
  XOR-obfuscated per RFC 4380 and is decoded before checking — an
  all-zero client field carries no client target); ISATAP (interface
  identifier `0000:5efe:<IPv4>` on ANY prefix). NOT unwrapped, by
  construction: NAT64 under operator-chosen prefixes and 6rd use
  prefixes indistinguishable from native global unicast, so no
  literal-level check can identify them (same class as the DNS limit
  below). `198.18.0.0/15` (benchmarking) and the documentation
  ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`,
  `2001:db8::/32`) are rejected; unparseable IPv6 literals are
  refused. NOTE: the brief named `lib/link-policy.ts` as the existing
  SSRF policy — that module is the note-LINK allowlist, not an SSRF
  control, so the fetch guard is a new module built to the brief's
  rule and is the single reuse point for user-URL fetches. Known
  limit: hostnames are not DNS-resolved, so DNS-rebinding names are
  out of scope for this layer. Images harvest through the standard
  pipeline server-side: magic-byte verify → staged object
  (`keys.upload`) → `createPhotoRows` → `processPhoto`. Metadata:
  manifest pairs map onto the template by URI/label/local-name;
  canvas label fills `title`, manifest description fills
  `description`; unmapped pairs are preserved verbatim in an item
  note (jsonld-accept convention). UI: ImportDialog "IIIF" tab (URL
  paste; synchronous result line + toasts).
- Developer API (row 36): tokens `lib/token-core.ts` (pure:
  `ezv_` + 32 random bytes; SHA-256 hash at rest; display prefix;
  a constant-time digest-compare helper, `verifyApiToken`, kept for
  token tooling and unit-tested) +
  `lib/token-auth.ts` (`enforceTokenScope(req, scope)`: no bearer =
  human path no-op; presented bearer must be a live token with the
  exact scope — revoked/expired 401, under-scoped 403, `last_used_at`
  stamped). Live verification is a DB hash lookup: the presented
  token is SHA-256 hashed and matched with
  `WHERE token_hash = hash(presented)` — safe for 256-bit random
  tokens (the stored hash is never disclosed and there is no
  practical timing oracle); the constant-time helper is NOT the
  live path. Scopes: `read`, `notes:write` (neither implies the other).
  Documented subset (DEVELOPER-API.md): GET projects / project /
  items / item / item photos / photo / photo notes / selection notes /
  note; POST photo + selection notes; PATCH note. Subset denial is
  GLOBAL, not opt-in (fix B1): `lib/token-guard.ts` holds the ONE
  method-aware allowlist and `proxy.ts` runs it BEFORE every /api
  handler — a presented `ezv_` bearer on any (method, path) outside
  the subset gets 403 immediately, including undocumented methods
  inside documented files (project PATCH/DELETE), exports, and
  `POST /api/admin/delete-everything`. Requests with no bearer, or
  with a non-token bearer (e.g. the cron secret), are completely
  unaffected; validity/scope checks on subset routes stay in the
  handlers. Note DELETE denies presented tokens (delete is outside
  the scopes); token management
  (`GET|POST /api/api-tokens`, `DELETE /api/api-tokens/[tokenId]`) is
  human-only and returns the plaintext secret exactly once (201).
  Platform note (binding, also in DEVELOPER-API.md): Vercel
  Authentication still fronts the public deployment — scripts also
  send the protection-bypass header or target a local/self-hosted
  run; Deployment Protection is never disabled.
- Bundle: workspace First Load JS **213.67 → 215.03 KB gzip (+1.36 KB)**
  (canonical method, INTEGRATION-DECISIONS.md — 11 files, 0 missing):
  the IIIF tab, Omeka settings/push + token settings UI, and the
  Inspector push button only; all Wave D logic is server-side. No ADR
  needed. Zero new dependencies this wave. QA-BLOCK fix round
  (B1/B2 + findings 3/4/5/6): all changes are server-side (proxy,
  fetch guard, Omeka/IIIF services) — First Load JS re-measured
  **215.03 KB gzip (11 files, 0 missing), delta +0.00 KB**.

## Wave E (part 1) — PWA / offline shell (Serwist)

- Binding spec: APPSEC-REVIEW-PWA.md (26 conditions, E-SEC-1…26).
  Integration record: INTEGRATION-DECISIONS.md #10 (incl. the
  Turbopack/configurator-mode build decision and the `defaultCache`
  rejection).
- Build: `npm run build` = `next build && serwist build
  serwist.config.mjs` → `public/sw.js` (gitignored build artifact).
  The SW source is `app/sw.ts`; its runtime route table is the pure
  module `lib/pwa/routing.ts` (unit-tested in
  `test/pwa-routing.test.mjs`): exclusions first (`/api/**`,
  cross-origin, `/_vercel/**`, `/sw.js`, non-GET/HEAD, Range — never
  intercepted), navigations network-first with verbatim pass-through
  and cached-shell fallback ONLY on fetch rejection, OCR assets lazy
  cache-first in `ezvault-ocr-tess<ver>-<build>`, shell documents
  (`/` + the representative `/pwa-project-shell` render of
  `/[projectId]`) cached at install in `ezvault-documents-<build>`
  behind the E-SEC-6 guard (auth-shaped response = failed install).
  Serwist precaches ONLY static build assets + public SVGs + PWA
  icons + the manifest (42 entries, 3.74 MB — cap 10 MiB).
- Client: `components/pwa/PwaProvider.tsx` (root layout) registers the
  SW in production only, renders the offline banner / update banner /
  session-expired overlay, and drives recovery (banner clears only
  after a successful /api response + full SWR revalidation).
  `lib/api/client.ts` is the mutation gate: while the offline or
  session-expired state is active, mutations throw
  `OfflineBlockedError` BEFORE any fetch — no queue, no replay
  (E-SEC-17/20). Auth-shaped API failures (redirect off-origin, HTML
  body, 401/403) raise the session-expired state and purge the
  document caches (E-SEC-9/10). `WorkspaceClient` treats the URL as
  the authority for the project id (the one cached project shell is
  generic). False empty states are banned offline (E-SEC-19):
  `OfflineUnavailable` replaces them in the center panel, search
  results, project home, and the palette's search section.
- Copy: `app.offlineNote` rewritten per E-SEC-22 — the library lives
  online and can't be loaded or changed offline; the shell opens and
  OCR still runs on photos already on screen. No copy anywhere claims
  the library is available offline. `proxy.ts` diff is exactly the
  E-SEC-7 `Cache-Control: no-cache` complement for `/sw.js`.
- Bundle: workspace First Load JS **215.03 → 217.14 KB gzip
  (+2.11 KB)** (canonical method, 10 files, 0 missing). The generated
  SW (39,199 B) is not route JS.

## Wave E (part 2) — Locales + plugin-equivalent extension surface (rows 35/36-adjacent)

- Locales (row 35 CLOSED): 11 message catalogs under `messages/` —
  `en` plus `de`, `es`, `fr`, `it`, `ja`, `nl`, `pt`, `pt-BR`, `uk`,
  `zh`. The list is Tropy's shipped set (public 1.13 announcements:
  English, French, German, Italian, Japanese, Chinese, Dutch,
  Ukrainian, Spanish, Portuguese + the Brazilian Portuguese locale) —
  NOTE it differs from early planning guesses: Ukrainian and pt-BR are
  in, Polish and Russian are not Tropy locales. All catalogs are
  ORIGINAL translations of EZVault's own `messages/en.json` (623 keys
  each, identical key sets, placeholder/ICU parity enforced by
  `test/locales.test.mjs`); no Tropy translation files were used
  (clean-room, AGPL). Resolution: `i18n/request.ts` reads the
  `ezv_locale` cookie through `resolveLocale()` (`lib/i18n/locales.ts`,
  validated against the supported set, default `en`); ADR-2.13 stands
  (localePrefix 'never', no route changes). Switcher: TopBar
  `LocaleSwitcher` lists native names, sets the cookie, refreshes.
  Messages are server-loaded for the ACTIVE locale only.
- Extensions (docs/PLUGINS.md): Tropy's plugin model (separately
  installed packages executing local code with full app access) is
  `replaced` — arbitrary third-party code execution cannot be mirrored
  safely in a hosted serverless app (AppSec + strict CSP). EZVault's
  equivalent is an in-repo typed registry (`lib/plugins/registry.ts`:
  id, version, kind ∈ export|import|integration|engine, i18n base,
  docs anchor) covering the nine real built-ins that occupy Tropy's
  plugin hook points: csv-export, archive-export, jsonld-export,
  csv-import, jsonld-import, iiif-import, alto-import, omeka-push,
  tesseract-ocr (engine). Enable/disable state is per project,
  persisted in `plugin_settings` (migration 0012; no row = enabled),
  served by `GET|PATCH /api/projects/[id]/plugins`, and ENFORCED by
  `requirePluginEnabled()` (`lib/plugins/server.ts`) at the top of
  every guarded route — disabled answers an honest
  `403 plugin_disabled` before any work. For the client-side OCR
  engine, enforcement sits at the persistence boundary (transcription
  creates with `config.source='ocr'` are refused while off). Settings
  UI: Project settings → Extensions (kind, version, localized
  description, toggle). `test/plugins.test.mjs` asserts registry
  integrity, per-locale name/description presence, state logic, and a
  real enforcement point per id.
