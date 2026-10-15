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
