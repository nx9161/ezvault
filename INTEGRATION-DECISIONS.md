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
