# SPDX-License-Identifier: MIT

# EZVault extensions — the plugin-equivalent surface

Wave E part 2. This document maps Tropy's plugin model onto EZVault's
architecture and describes the extension surface that shipped.

## The Tropy model (facts)

Tropy is a desktop Electron app. Its plugins are **separately installed
npm-style packages** that the user drops into a plugins folder; each
declares hooks (`export`, `import`) in a manifest and runs **local
JavaScript with full application access** — the plugin receives a
context object with the app's logger, dialogs, and bundled libraries
and executes inside the app process. Several shipped parity features
are literally Tropy plugins: CSV export/import (row 23), the archive
export (24), the Omeka S plugin (25), IIIF import (26), and the OCR /
ALTO hook surface (14).

## Why EZVault cannot mirror that shape — the honest platform delta

EZVault is a **hosted, single-user web app on serverless functions**.
There is no local app process for a user-installed package to run in,
and executing arbitrary third-party code server-side would mean:

- remote code execution inside the deployment that holds the archive,
  the storage credentials, and the master key (AppSec: a plugin sandbox
  escape is a full-archive compromise, not a crashed desktop app);
- arbitrary code in the browser bundle would break the strict CSP
  (`script-src 'self'`, zero inline/third-party scripts — CONTRACT.md)
  that the PWA security review (APPSEC-REVIEW-PWA.md) is built on;
- no install/update/uninstall lifecycle exists on a hosted deployment
  the user does not operate.

So the plugin *model* is `replaced` — the same class of substitution
the parity checklist already uses for watch folders (#3), link-by-path
(#4), and the OS print dialog (#28): the capability and its hook points
are at parity; the delivery mechanism is the platform-appropriate one.

## The EZVault equivalent: an in-repo extension registry

`lib/plugins/registry.ts` is a typed registry of the built-in
capabilities that occupy Tropy's plugin hook points. Each entry is a
manifest:

```ts
interface PluginManifest {
  id: string;          // stable id, e.g. "csv-export"
  version: string;     // semver of the capability's contract
  kind: "export" | "import" | "integration" | "engine";
  i18nBase: string;    // plugins.<i18nBase>.{name,description} in messages/*
  docsAnchor: string;  // section anchor below
}
```

Registered today (all real, shipped capabilities — no placeholders):

| id | kind | Hook point | Enforcement point |
|---|---|---|---|
| `csv-export` | export | GET project CSV export | `app/api/projects/[id]/export/csv` |
| `archive-export` | export | GET archive ZIP export | `app/api/projects/[id]/export/zip` |
| `jsonld-export` | export | GET JSON-LD export | `app/api/projects/[id]/export/jsonld` |
| `csv-import` | import | POST CSV import | `app/api/projects/[id]/import/csv` |
| `jsonld-import` | import | POST JSON-LD import | `app/api/import/jsonld` |
| `iiif-import` | import | POST IIIF manifest import | `app/api/projects/[id]/import/iiif` |
| `alto-import` | import | POST ALTO XML import | `lib/api/transcriptions.ts` (alto route) |
| `omeka-push` | integration | POST Omeka push / push-project | both `app/api/projects/[id]/omeka/*` routes |
| `tesseract-ocr` | engine | OCR result creation | transcription create when `config.source === 'ocr'` (`lib/api/transcriptions.ts`) |

### Enable / disable state

State is **per project**, persisted server-side in `plugin_settings`
(migration `0012_plugin_settings.sql`) and served by
`GET|PATCH /api/projects/[id]/plugins`. A plugin with no stored row is
**enabled** — the table records only explicit choices, so a newly
registered built-in needs no backfill. Unknown ids in stored rows are
ignored on read.

### Enforcement

`lib/plugins/server.ts` `requirePluginEnabled(projectId, pluginId)`
runs in every guarded route **before any work**: a disabled plugin's
route answers `403` with code `plugin_disabled` and a message naming
the extension and where to re-enable it. Nothing is silently hidden or
faked. For `tesseract-ocr` (a client-side engine) the enforcement
point is the persistence boundary: OCR runs in the browser, but its
result is a transcription create with `config.source = 'ocr'`, and
that create is refused while the extension is off — a disabled engine
cannot write. **Project settings → Extensions** lists every plugin
with its kind, version, localized description, and a working toggle.

Developer API tokens (row 36) do not interact with extensions: token
scopes and the token guard's route subset are unchanged; a token
calling a guarded route still needs the human path or a documented
route, and a disabled plugin refuses token and human callers alike.

## Adding a future plugin (checklist)

1. Implement the capability as a normal route/lib module (no plugin
   code runs that is not in this repo and reviewed).
2. Add a manifest to `PLUGIN_REGISTRY` in `lib/plugins/registry.ts`
   (unique kebab-case id, semver, kind, i18n base, docs anchor).
3. Add `plugins.<i18nBase>.{name,description}` to **all 11** message
   files (`test/plugins.test.mjs` and `test/locales.test.mjs` enforce
   parity).
4. Guard the route(s) with `requirePluginEnabled(projectId, '<id>')`
   immediately after `requireProject(...)` (the registry test asserts
   every id has a real enforcement point).
5. Document the capability with a section below, anchored by the
   manifest's `docsAnchor`.

## Registered capabilities

### csv-export

Item metadata as CSV; header = template property URIs; B15
formula-injection sanitizer on every cell (row 23, Wave B2).

### archive-export

Streamed ZIP of originals + `metadata.json` (JSON-LD) + `manifest.json`
with per-photo checksums (row 24, Wave B2).

### jsonld-export

The shared JSON-LD builder (also used by the monthly backup); notes as
HTML or Markdown per project preference (row 20).

### csv-import

One new item per CSV data row under a chosen template; per-row error
report, export→import round-trip restores original text (row 23).

### jsonld-import

JSON-LD project documents accepted with the strict context loader
(remote contexts rejected, B10) and template-URI matching (row 21).

### iiif-import

IIIF Presentation v2/v3 manifest harvest through the SSRF fetch guard;
one item per canvas, grouped in a manifest-named list (row 26, Wave D).

### alto-import

ALTO XML parsed into a transcription with word boxes; the original XML
is stored and re-downloadable (row 13, Wave C).

### omeka-push

Omeka S item push (create-or-update via the sync table); media attached
once through presigned URLs (row 25, Wave D).

### tesseract-ocr

Client-side Tesseract.js engine behind the OCR adapter contract
(`lib/ocr/adapter.ts`); self-hosted assets, `eng` data bundled, results
land as ordinary transcriptions (row 14, Wave C).
