# QA-REPORT-PARITY-E.md — Wave E (PWA/offline + locales + plugin surface) + row-32 fix

**Gate date:** 2026-10-21 · **Tree gated:** `main @ aabf966` (merged) · **Verdict: SIGN-OFF**

Wave E landed in two parts plus a re-audit fix. Part 1 (PWA) had landed
*without* QA; this report is its gate, part 2's gate, and the closeout
of the parity checklist's last PARTIAL row (32).

## Part 1 — PWA / offline (rows 37) — gated against APPSEC-REVIEW-PWA.md

Method: full build with `.env.local` parked (prebuild gates green),
effective route table dumped from the built `public/sw.js` and diffed
against the review's §A taxonomy, condition-by-condition verdicts.

- **Route-table diff: CLEAN.** Zero runtime caching routes;
  `defaultCache` absent; no NetworkFirst/StaleWhileRevalidate strings;
  `/api` appears only in the bypass predicate; exclusion list evaluates
  first; navigations network-first with shell fallback only on fetch
  rejection; OCR runtime cache versioned (`ezvault-ocr-tess7.0.0-<build>`),
  12 MiB cap present in the artifact.
- **Verdicts: 21/26 PASS in-tree** (E-SEC-1…6, 9…11, 13…17, 19…25),
  5 marked POST-DEPLOY (7, 8, 12, 18, 26 — live-only by construction).
- **One deviation found and fixed during the gate** — commit `75aa371`:
  Serwist's stock `PrecacheStrategy` copies redirected responses into
  the precache, so an install behind the SSO gate would have cached
  login HTML under build-chunk URLs instead of failing (E-SEC-10b).
  A `cacheWillUpdate` guard now refuses non-200 / redirected / opaque
  precache responses → install fails cleanly. Regression test added;
  guard verified present and first in the rebuilt artifact.
- **Budgets:** precache 3.570 MiB (cap 10 MiB); OCR payload 10.41 MiB
  (cap 12 MiB); `navigator.storage.persist()` nowhere in the tree.

## Part 2 — Locales + switcher (row 35) and plugin surface

- **Locales:** Tropy's actual 11 (verified from Tropy's public 1.13
  announcements): en, de, es, fr, it, ja, nl, pt, pt-BR, **uk**, zh —
  10 new catalogs, original translations of EZVault's own copy
  (no Tropy translation files used; AGPL clean-room holds). Cookie
  resolution (`ezv_locale`, validated, ADR-2.13 `localePrefix 'never'`
  unchanged) + TopBar switcher with native names. After the merges,
  all 11 catalogs hold identical **633-key** sets (row-32 keys
  translated ×10; stale `mergeWave2` strings deleted everywhere).
  Zero non-English catalog strings in any client chunk.
- **Plugin-equivalent surface:** `lib/plugins/` registry — 9 built-in
  manifests (csv/archive/jsonld export; csv/jsonld/iiif/alto import;
  omeka-push; tesseract-ocr), per-project enable/disable persisted in
  `plugin_settings` (migration `0012`, applied to production and
  verified), enforced by `requirePluginEnabled()` at 10 route points
  (disabled → 403 `plugin_disabled` before any work, the OCR engine
  gated at transcription write). Settings → Extensions UI with working
  toggles. `docs/PLUGINS.md` documents the model mapping and the honest
  delta: arbitrary third-party code execution is not mirrored in a
  hosted serverless app (same `replaced` class as rows 3/4/28).

## Row 32 fix (re-audit downgrade, closed)

Cross-project copy now carries transcriptions (rows + ALTO objects +
rollback), a bulk copy route exists, and an app-level clipboard gives
real copy/paste between projects with honest result counts
(commits `7881329`, `5e053bd`). Row 32 re-verdict: **DONE**.

## Merged-tree gates (@ aabf966)

- `npm test`: **344/344 pass, 74 suites, 0 skipped**
- `npx tsc --noEmit`: clean
- `npm run build` (`.env.local` parked): exit 0 — secret-scan OK,
  verify-codecs OK, licence check OK (only the 4 standing LGPL
  dynamic-link warnings; zero new dependencies in the wave)
- First Load JS (canonical client-reference-manifest method; `/`
  reproduces the part-1 figure 164.34 KB exactly): `/` **164.35 KB**,
  `/[projectId]` **219.08 KB** = **+1.94 KB** over Wave E part 1 —
  far inside the 40 KB/route rule, no ADR required
- Serwist precache on the merged build: 43 URLs, 3.75 MB

## Production deploy + live verification

- Migration `0012_plugin_settings.sql` applied to production Neon
  **before** deploy; table verified present.
- Deployment `dpl_ynNyjNEzQDKyy6LkC6VGhaTPboMX` (git source
  `nx9161/ezvault @ main aabf966`, target production) — **READY**.
  Production: https://ezvault-nx9161s-projects.vercel.app
- **B7 gate PASS:** unauthenticated `/`, `/api/health`, `/sw.js` all
  302 to Vercel SSO; body is the protection notice, zero app HTML.
- **Authenticated `/api/health`: 200, all checks ok** — neon ok,
  storage ok (r2), queue ok, codecs ok incl. `pdf-render
  (pdf.js+canvas):ok` and `jp2-decode (openjpeg wasm):ok` (the Wave B
  render layer proven live in the serverless environment).
- **Runtime errors: none** (1 h window post-deploy).
- **E-SEC-7 PASS live:** `/sw.js` 200 authenticated, real revisioned
  SW, `Cache-Control: no-cache`.
- CSP served live with the R2 host, identical to the in-tree proxy set.
- Remaining POST-DEPLOY items (E-SEC-8 signed-out flow with SW
  installed, E-SEC-12 offline header replay, E-SEC-18 byte-identical
  downloads under SW control, E-SEC-26 probes under SW control) are
  browser-session tests; their in-tree evidence is complete (route
  table, unit tests, proxy diff limited to the E-SEC-7 header) and
  E-SEC-26's guard was live-proven in Wave D round 3. They are queued
  as owner-browser spot checks, not silently assumed.
