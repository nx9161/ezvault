# INTEGRATION-DECISIONS.md

Vetted third-party integrations for EZVault. One entry per candidate, in
merge order. License gate runs between every entry (`node
scripts/check-licences.mjs`, fail-closed: any GPL/AGPL/SSPL — including "or
later" — Commons Clause, or Elastic License = revert + documented
rejection). No vendored code, ever — npm dependencies only (clean-room
boundary). Per-route budget rule: no route's First Load JS may grow more
than **40 KB gzip** in one integration without a written ADR. In this
environment the `next build` route table prints no size columns, so First
Load JS is measured from the build output: shared initial chunks
(`build-manifest.json` `rootMainFiles`) + the route's client chunks (its
`client-reference-manifest` chunk lists), raw bytes summed and gzipped.
Measurement scripts used: `/tmp/measure-first-load.cjs`,
`/tmp/measure-route-first-load.cjs`.

---

## 1. react-hotkeys-hook@5.3.3 — shortcut registry (Wave 1, FIRST)

**Status:** ACCEPTED · landed 2026-10-15 · commit `4db5d70`

**What it is:** React hook for binding keyboard shortcuts
(`useHotkeys`), by Johannes Klauss.

**Verification (re-pulled 2026-10-15):**

- **Stars:** 3,507 (github.com/johannesklauss/react-hotkeys-hook, via GitHub API)
- **Last activity:** repo pushed 2026-10-12; 5.3.3 published 2026-06-26 (npm registry)
- **License (exact, read from `node_modules/react-hotkeys-hook/LICENSE`):**
  `MIT License — Copyright (c) 2018 Johannes Klauss`
- **License gate:** `node scripts/check-licences.mjs` PASS — no GPL/AGPL/SSPL;
  only the four pre-existing LGPL warnings (sharp/libheif, unchanged from baseline)
- **OSV.dev:** `api.osv.dev/v1/query` for `react-hotkeys-hook@5.3.3` → **zero**
  vulnerabilities
- **postinstall scripts:** none (package.json `scripts` = build/test/lint only)
- **Telemetry/phone-home:** none — zero `fetch(`/`XMLHttpRequest`/`sendBeacon`
  calls in the shipped `dist/index.js`; zero runtime dependencies
- **Install:** `npm install --save-exact react-hotkeys-hook@5.3.3`

**Bundle delta (measured):** `/[projectId]/page` First Load JS
**203.54 → 206.06 KB gzip (+2.52 KB)** — within the architecture's budgeted
+3.3 KB and far under the 40 KB/route rule. No ADR needed.

**Gap closed:** the hand-rolled `keydown` map in
`components/shortcuts/useGlobalShortcuts.ts` is replaced by a single source
of truth — `lib/shortcuts/registry.ts` (framework-free `{ id, keys, scope,
group, labelKey, hint, run }` entries) bound by
`components/shortcuts/useRegisteredHotkeys.tsx`. The `?` overlay renders
from the registry grouped under the existing `shortcuts.groups` headings
(General / Organizing / Photo viewer). Documents ONLY real bindings:
merge = Ctrl/Cmd+Shift+M (new real binding; `mergeItemsOp` honestly toasts
its wave-2 placeholder state when fired), palette = mod+k (bound to focus
search until the cmdk palette supersedes it in entry #2). Typing guard
preserved (single keys inert in inputs/contenteditable/TipTap).

---

## 2. cmdk@1.1.1 + fuse.js@7.5.0 — command palette (Wave 1, SECOND)

**Status:** ACCEPTED · landed 2026-10-15 · commit `d26c43e`

**What they are:** `cmdk` — unstyled React command-menu primitive (Paco
Coursey lineage; repo moved to dip/cmdk). `fuse.js` — client-side fuzzy
ranker (Kiro Risk / krisk).

**Verification (re-pulled 2026-10-15):**

- **Stars:** cmdk 11,741 (pacocoursey/cmdk at archive; lineage continues at
  dip/cmdk, 13,017 stars, pushed 2025-10-29) · fuse.js 20,502
  (github.com/krisk/Fuse, pushed 2026-08-09) — both via GitHub API
- **Versions:** cmdk 1.1.1 published 2025-03-14 · fuse.js 7.5.0 published
  2026-07-13 (npm registry)
- **Licenses (exact, read from the installed packages):**
  `MIT License — Copyright (c) 2022 Paco Coursey` (cmdk, `LICENSE.md`) ·
  `Apache License, Version 2.0, January 2004` (fuse.js, `LICENSE`)
- **License gate:** `node scripts/check-licences.mjs` PASS — no GPL/AGPL/SSPL;
  only the four pre-existing LGPL warnings (unchanged from baseline)
- **OSV.dev:** both packages @ pinned versions → **zero** vulnerabilities
- **postinstall scripts:** none (both packages)
- **Telemetry/phone-home:** none — zero `fetch(`/`XMLHttpRequest`/`sendBeacon`
  in cmdk's `dist/*.mjs` and fuse.js's `dist/*.js`; zero runtime deps for
  fuse.js; cmdk's deps are `@radix-ui/*` UI primitives only
- **Install:** `npm install --save-exact cmdk@1.1.1 fuse.js@7.5.0`

**Bundle delta (measured):** `/[projectId]/page` First Load JS
**206.06 → 206.31 KB gzip (+0.25 KB)** — cmdk+fuse (budgeted 23.9 KB) ship
in a lazy chunk loaded on first mod+k (`next/dynamic`, `ssr: false`), so
first paint is untouched. Far under the 40 KB/route rule. No ADR needed.

**Gap closed:** `components/palette/PaletteLauncher.tsx` (mounted next to
TopBar in the workspace shell; mounts the lazy chunk on first open and
keeps it) + `components/palette/CommandPalette.tsx` (cmdk `Command` with
`shouldFilter={false}`). Two modes: **Actions** — every registry entry with
a real run, ranked locally by fuse.js over the translated labels,
dispatched through the entry's `run` (undoable ops flow through
`lib/commands/bus`, preserving undo/redo); **Search** — server FTS
(`/api/projects/[id]/search`, scope=all, debounced 250ms) stays the search
authority, results resolved to parent items; fuse.js ranks ONLY the
client-side recent-item quick-jump list (`ezvault:recent-items:<id>:v1`,
localStorage, 8 max). mod+k now opens the palette (registry entry
`palette`, `shortcuts.palette` = "Command palette"); the `#ez-global-search`
input keeps working standalone as the fallback anchor. New `palette.*`
i18n keys (title/placeholder/actions/recent/searchResults/noResults).

---

## 3. driver.js@1.9.0 — onboarding tour (Wave 1, LAST)

**Status:** ACCEPTED · landed 2026-10-15 · commit `fb43dea`

**What it is:** framework-agnostic product-tour library (Kamran Ahmed) —
highlight + popover steps over DOM anchors.

**Verification (re-pulled 2026-10-15):**

- **Stars:** 26,909 (github.com/kamranahmedse/driver.js, pushed 2026-10-13) —
  via GitHub API
- **Version:** 1.9.0 published 2026-10-03 (npm registry)
- **License (exact, read from `node_modules/driver.js/license`):**
  `The MIT License — Copyright (c) Kamran Ahmed`
- **License gate:** `node scripts/check-licences.mjs` PASS — no GPL/AGPL/SSPL;
  only the four pre-existing LGPL warnings (unchanged from baseline)
- **OSV.dev:** `driver.js@1.9.0` → **zero** vulnerabilities
- **postinstall scripts:** none · **dependencies:** zero
- **Telemetry/phone-home:** none — zero `fetch(`/`XMLHttpRequest`/`sendBeacon`
  in the shipped `dist/driver.js.cjs`
- **Install:** `npm install --save-exact driver.js@1.9.0`

**Bundle delta (measured):** `/[projectId]/page` First Load JS
**206.31 → 207.06 KB gzip (+0.75 KB)** — the 7.3 KB driver.js loads
dynamically only when a tour starts (`await import("driver.js")`); the
0.9 KB `driver.css` is a static import in the tiny shell-mounted
`TourLauncher` (negligible, keeps the popover styled). Far under the 40
KB/route rule. No ADR needed.

**Gap closed:** `lib/tour/launcher.ts` (framework-free `startTour()` →
`ezvault:start-tour` window event) + `lib/tour/steps.ts` (8 steps from
`buildSteps`, copy under `tour.*` i18n keys, plain words) +
`components/tour/TourLauncher.tsx` (shell-mounted listener; steps whose
anchor is absent — mobile layouts, empty viewer, unopened dialogs — are
filtered out, never broken). Stable `data-tour` anchors: sidebar lists /
tags, item grid, viewer toolbar, palette button, global search, plus the
dialog/wizard step containers (`tpy-upload/analyze/map/run/report`,
`import-tabs/review`) for future steps. Entry points: new TopBar palette
button (⌘K chip, `data-tour="palette-button"`), "Take the tour" in the
project menu, "Take the tour" in Settings (new `settings.help` section),
a quiet link in the empty-library state, and a palette action (registry
entry `takeTour`, `shortcuts.takeTour`, palette-only — no key binding, hint
shows ⌘K per the overlay convention). Deliberate choice: **no auto-start**
— the tour runs only from explicit entry points; `ezvault:tour:v1` is set
in localStorage when a run completes.

---

## 4. yet-another-react-lightbox@3.32.2 — viewer swap (Wave 2, FIRST)

**Status:** ACCEPTED · landed 2026-10-15 · commit `65bd79c`

**What it is:** modern React lightbox component by Igor Danchenko
(igordanchenko/yet-another-react-lightbox).

**Verification (re-pulled 2026-10-15):**

- **Stars:** 1,325 (github.com/igordanchenko/yet-another-react-lightbox,
  repo pushed 2026-07-30) — via web search re-pull
- **Version:** 3.32.2 = npm `latest` (npm registry, 2026-10-15)
- **License (exact, read from `node_modules/yet-another-react-lightbox/LICENSE`):**
  `MIT License — Copyright (c) 2022 Igor Danchenko`
- **License gate:** `node scripts/check-licences.mjs` PASS — no GPL/AGPL/SSPL;
  only the four pre-existing LGPL warnings (sharp/libheif, unchanged from baseline)
- **OSV.dev:** `api.osv.dev/v1/query` for
  `yet-another-react-lightbox@3.32.2` → **zero** vulnerabilities (`{}`)
- **postinstall scripts:** none (`package.json` `scripts` is `null`)
- **Telemetry/phone-home:** none — zero `fetch(`/`XMLHttpRequest`/`sendBeacon`/
  analytics hits in `dist/`; zero runtime dependencies
- **Install:** `npm install --save-exact yet-another-react-lightbox@3.32.2`

**Bundle delta (measured):** `/[projectId]/page` First Load JS
**208.26 → 207.63 KB gzip (−0.63 KB)** — the deleted hand-rolled zoom code
outweighed the tiny `next/dynamic` wrapper. The lightbox (core + the six
plugins + the next/image slide render) ships in its own lazy chunk
(`1t4mhpt9x80ah.js`, **24.3 KB gzip** — under the architecture's 31.9 KB
estimate) plus its CSS (`05lfx66_vp4vj.css`, 1.4 KB gzip); both load only
when the viewer opens. Far under the 40 KB/route rule. No ADR needed.

**Gap closed:** the hand-rolled zoom/gesture code in
`components/inspector/PhotoViewer.tsx` (wheel-zoom, pinch-less `zoomAt`/`panBy`,
1:1 original-bitmap loading, navigator minimap, zoom range slider, arrow-key
pan) is **deleted**. Viewing is now `components/viewer/PhotoLightbox.tsx`
(`"use client"`): the **six PRD-mandated plugins ONLY** — Zoom
(pinch/keyboard/wheel), Thumbnails (item-photo strip), Fullscreen, Captions
(EXIF via the stored `exifr` payload + item title), Download (single photo),
Counter — no other plugins. Slides render via `next/image` `unoptimized`
(presigned R2 URLs cannot go through the Next optimizer) with `objectFit:
"contain"`. The edit surface (rotation/mirror/color edits, selection
drawing, revert) stays in PhotoViewer — the lightbox is viewing-only;
closing it on another slide syncs the active photo.

**Placement note:** architecture §2.4 says "inside CenterPanel.tsx's viewer
path" — the live tree has no viewer path in CenterPanel; the viewer is the
Inspector's viewer tab, so the lightbox mounts there (opened from the viewer
toolbar's new fullscreen button). The six-plugin constraint, the
`next/dynamic(ssr:false)` boundary, and the lazy-chunk budget are unchanged.

**Shortcuts/i18n cleanup:** the viewer registry entries for the deleted
gestures (`fitWindow` 0, `actualPixels` 1, `pan` arrows) are removed from
`lib/shortcuts/registry.ts` (the `?` overlay renders from the registry, so it
stays consistent); `viewerZoomPct` is removed from the ui store (nothing read
it). Zoom-era i18n keys (`viewer.zoomIn/zoomOut/zoomLevel/fitWindow/fitWidth/
oneToOne/panHint`, `shortcuts.actualPixels/fitWindow/pan`) are deleted;
`viewer.openLightbox` added; `tour.viewerBody` rewritten.

**QA regression:** pinch/keyboard zoom now live in the lightbox (Zoom
plugin: `maxZoomPixelRatio: 4`, `keyboardMoveDistance: 48`); selection
drawing + edit sliders re-verified untouched on the edit surface (`tsc`
clean, `npm test` green, `next build` green).

---

## 5. @playwright/test@1.64.1 — E2E harness (Wave 2, dev-only)

**Status:** ACCEPTED · landed 2026-10-15 · commit `73f8f2e`

**What it is:** Microsoft's end-to-end test runner (Chromium/Firefox/WebKit).

**Verification (re-pulled 2026-10-15):**

- **License (exact, read from `node_modules/@playwright/test/LICENSE`):**
  `Apache License, Version 2.0, January 2004`
- **License gate:** `node scripts/check-licences.mjs` PASS — no GPL/AGPL/SSPL;
  only the four pre-existing LGPL warnings (unchanged from baseline)
- **OSV.dev:** `api.osv.dev/v1/query` for `@playwright/test@1.64.1` → **zero**
  vulnerabilities
- **postinstall scripts:** none (`package.json` `scripts` is `{}`) — browsers
  are NOT installed by postinstall; CI runs
  `npx playwright install --with-deps chromium` deliberately (documented in
  `e2e/README.md`)
- **Telemetry/phone-home:** none in the test runner path — no network calls
  at import; browser download happens only on explicit `playwright install`
- **Install:** `npm i -D --save-exact @playwright/test@1.64.1` (devDependency)

**Bundle delta:** **0 KB** — devDependency, never bundled. No ADR needed.

**Gap closed:** `e2e/` + `playwright.config.ts` (Chromium only — single
browser keeps CI at $0): `auth-gate.spec.ts` (root 302, `/api/health` 503
pre-env — the 503 assertion runs locally, green), `rate-limit.spec.ts`
(40-burst → 429s with `Retry-After`, zero 500s — hardening H2),
`tpy-wizard.spec.ts` (Standard fixture 3 items / 4 photos + idempotent
re-run; Advanced fixture 3 missing originals re-linked, nothing left
missing), `backup-restore.spec.ts` (JSON-LD export → scratch-project
import, counts match — H7 adjacency). Committed synthetic fixtures in
`e2e/fixtures/` (`standard.tpy`, `standard-assets.zip`, `advanced.tpy`,
`advanced-originals/`), built by `e2e/fixtures/build-fixtures.mjs`
(repo `sql.js` + `sharp`, dev-time only). Anything needing live Neon/R2/
Vercel `test.skip`s with reason `OWNER-BLOCKED: live infra` — NOT faked.
Protected-preview runs use the `x-vercel-protection-bypass` header pattern;
Deployment Protection is never disabled for tests.
