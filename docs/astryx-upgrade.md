# Astryx upgrade — branch `astryx-upgrade`

Meta's Astryx design system (MIT, pinned **0.7.16**) layered into EZVault.
Owner order: replace with Astryx wherever it fits and is needed; keep
what Astryx does not do better. This branch is **not merged and not
deployed** — production stays on `main` until the owner play-tests.

## Installed

- `@astryxdesign/core` 0.7.16 (exact pin), `@astryxdesign/theme-neutral`
  0.7.16 (exact pin), `@stylexjs/stylex` ^0.19.2; dev: `@astryxdesign/cli`
  0.7.16 (exact pin). TypeScript stays on the repo's ^5.9 (TS 7 breaks
  Next builds — lab finding).
- `npx @astryxdesign/cli init` wrote the 174-component index into
  `AGENTS.md` / `GEMINI.md` at the repo root.

## Wiring

- `app/globals.css`: the three Astryx `@import`s (reset → astryx →
  theme-neutral theme) at the very top, in the documented order.
  Astryx's layered rules sit below EZVault's unlayered rules, so every
  existing surface keeps its current styling on day one.
- `app/layout.tsx`: `AstryxProviders` wraps the app inside the intl
  provider. It renders Astryx `Theme` + `LinkProvider` (Next Link).
- `components/astryx/AstryxProviders.tsx`: the Astryx colour mode is
  driven by EZVault's existing UI store (`theme` in `lib/store/ui`),
  the same store that sets `<html data-theme>` — one theme switch.

## Theme mapping — `lib/theme/ezvault-theme.ts`

`defineTheme({ extends: neutralTheme })` with EZVault's brand tokens
from globals.css as [light, dark] pairs:

- Accent #B3541E / #E08A3C, on-accent #FFFFFF / #1A1206, accent-muted
  (accent-soft) #F6E3D2 / #3A2A18, text-accent (accent-strong)
  #9C4A18 / #E08A3C, icon-accent.
- Backgrounds: body #FAF8F3 / #14120E, surface + card + popover
  #FFFFFF / #1E1B16, muted (surface-2) #F1ECE1 / #26221B.
- Text: primary (ink) #1E1B14 / #F2EDE3, secondary (ink-2)
  #5C5546 / #C4BBA9, disabled (ink-3) #6E6656 / #8F8674; icon primary /
  secondary follow ink / ink-2.
- Border #E2DACA / #3A342A, border-emphasized from ink-3.
- Status fills: success (ok) #2E7D4F / #4CAF7D, warning (warn)
  #B98A12 / #D9A62E, error (danger) #B3261E / #E06055, info
  #2B5E8B / #6FA8D8. Focus outline colour follows the accent.
- Radius: 4px base × 1 (EZVault's 4 / 8 / 12 scale).
- Fonts: body = EZVault's system UI stack; heading = Georgia serif
  (the notes/brand face); code = ui-monospace stack.

Not yet mapped: muted status fills and on-success / on-warning /
on-error / on-info pairs beyond the main fills, categorical and data
hues, shadow tokens, motion tempo, per-component style overrides,
and a production `astryx theme build` pass (the unbuilt theme injects
styles at hydration; build-for-production is the follow-up before any
merge). EZVault's own `--*` tokens in globals.css are untouched and
still drive all non-Astryx surfaces.

## Primitives — swapped

- **`components/ui/Dialog.tsx` → Astryx `Dialog` + `DialogHeader`.**
  Same exported API (`Dialog`, `ConfirmDialog`, same props), so all
  call sites are untouched. Native `<dialog>` semantics, focus trap,
  Esc and focus return now come from Astryx. Widths mirror the old
  CSS (560px / 860px wide). `ConfirmDialog` buttons are Astryx
  `Button`s. Behaviour change: initial focus follows native-dialog /
  Astryx rules (autofocus wins, else first focusable) instead of the
  old hand-rolled "first text field before close button" ordering.
- **`components/ui/Toasts.tsx` → Astryx `ToastViewport` + `useToast`.**
  The Zustand store remains the source of truth (pushToast is called
  from non-React code); a bridge component shows each store toast via
  Astryx once and dismisses it when the store entry goes away.
  Semantics kept: errors persist until dismissed, info auto-hides at
  6s, action button runs its action then dismisses, no focus theft.

## Primitives — kept, with reasons

- **`components/ui/Menu.tsx` — kept.** EZVault's menu is a free-floating
  menu anchored at raw x/y coordinates (right-click context menus in
  the sidebar, center panel, inspector, workspace) with arbitrary
  React children — including a colour-swatch popover that is not a
  menu at all. Astryx `DropdownMenu` / `ContextMenu` are
  trigger-element-anchored and item-data-driven; they cannot open at
  bare coordinates or host arbitrary children. Swapping would mean
  reworking the interaction model at 5+ call sites for no user-visible
  gain over the current WCAG-reviewed implementation.
- **`components/palette/CommandPalette.tsx` — kept (cmdk + fuse.js).**
  It has bespoke dual-mode semantics Astryx's `CommandPalette` (a
  Typeahead `SearchSource` shell) does not model: hotkey-registry
  dispatch through the undo/redo command bus, server FTS as the search
  authority, and a localStorage recent-items quick-jump. A swap would
  re-plumb search semantics, not just restyle.
- **Not Astryx territory (untouched, by design):** tiptap notes
  editor, photo viewer / lightbox, virtualized item grid
  (@tanstack/react-virtual), the `.ez-*` layout shell and its 721-line
  token CSS for existing surfaces.

## Surface converted as proof — Settings dialog

`components/settings/SettingsDialog.tsx`: every form control is now
Astryx — `TextInput` (project name, Omeka URL / identity / credential,
token name, one-time token secret read-only), `Selector` (default
template, duplicate policy, notes format), `NumberInput` (default
density, with the hint as its description), `CheckboxInput` (token
scopes, plugin enable toggles), and `Button` throughout (footer save /
cancel / delete, Omeka save / push, token create / revoke, tour,
delete-everything). All state, API calls and store behaviour are
unchanged; only the controls changed. The dialog shell itself is the
Astryx-backed `Dialog` above.

## Remaining before this could merge

1. Owner play-test of the Settings dialog and a dialog/toast-heavy
   flow, light + dark, desktop + mobile widths (no browser check was
   run on this branch).
2. ~~`astryx theme build` production pass for the EZVault theme.~~
   DONE in the QA fix pass below.
3. Map the remaining theme tokens listed above if the converted
   surfaces show mismatches.
4. Then, in later passes: items Table and the import wizard
   (FileInput + Stepper fit the .tpy flow) behind the same
   adapter pattern.

## QA fix pass (2026-11-19) — "fix everything"

Full QA (~/workspace/your_files/ezvault-qa-2026-11-18/REPORT.md) found
3 branch regressions + 7 pre-existing defects + 2 observations. All
fixed on this branch; regression tests in test/qa-regressions.test.mjs
(30 tests; suite 396/396); browser re-verification screenshots in the
QA folder's fix-verification/.

- D1: Esc now closes workspace dialogs — the global esc binding no
  longer preventDefaults (native <dialog> cancel survives) and defers
  to an open native dialog; closeTopmost() covers settings/retention/
  templates/about layers.
- D2: toast bridge no longer renders its own dismiss button (Astryx
  Toast's built-in close is the single control).
- D3: Settings plugin checkboxes are labelled with the plugin name
  (visually hidden; the visible Enabled/Disabled text is separate).
- D8: "?" opens the shortcuts overlay — bound as "shift+?, ?" with
  useKey (react-hotkeys-hook v5 matches e.code, not the character,
  unless useKey is set; both shift states bound for layout coverage).
- D10: .tpy wizard crash (hooks after an early return) fixed, AND the
  wizard's API contract aligned to the routes: presign sends
  tpy_size/with_assets_zip and reads the grants array; analyze sends
  project_id + staged_key and normalizes the camelCase report; the
  run response's conflicts array is counted, `expected` defaults to
  the report step's "?" fallback. (In the sandbox the flow then stops
  only at the R2 staging PUT — egress proxy — as with photo uploads.)
- D6: items list + project stats exclude trashed subjects (NOT EXISTS
  against the trash table).
- D7: Sidebar Trash click no longer resets the filter via
  setActiveListId(null) — the trash view opens; restore/purge verified.
- D9: TemplatesDialog .ttp import posts the parsed document (the
  route's contract), not a {ttp, filename} wrapper.
- D5: photoless items render an item-level metadata form in the
  inspector instead of the photos ErrorCard (new inspector.noPhotos*
  strings in all 11 locales; errors.retry likewise added for D4).
- O1: bulk metadata apply sends replace: true (no more duplicates).
- O2: single-item GET resolves title/cover like the list route.
- Theme build: `npm run theme:build` output committed under
  lib/theme/ (ezvault.css/.js + types); AstryxProviders consumes the
  built theme and globals.css imports the built stylesheet instead of
  theme-neutral's, so no styles are injected at hydration. Re-run
  `npm run theme:build` after editing lib/theme/ezvault-theme.ts
  (`npm run theme:check` verifies freshness).
