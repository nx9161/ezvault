// SPDX-License-Identifier: MIT
// EZVault's Astryx theme — the brand tokens from app/globals.css
// ("Reading Room" light / "Darkroom" dark) mapped onto Astryx semantic
// tokens, extending the neutral theme. Token pairs are [light, dark],
// taken 1:1 from the :root / [data-theme="dark"] blocks in globals.css:
//
//   --bg            #FAF8F3 / #14120E   --ink    #1E1B14 / #F2EDE3
//   --surface       #FFFFFF / #1E1B16   --ink-2  #5C5546 / #C4BBA9
//   --surface-2     #F1ECE1 / #26221B   --ink-3  #6E6656 / #8F8674
//   --border        #E2DACA / #3A342A
//   --accent        #B3541E / #E08A3C   --accent-ink #FFFFFF / #1A1206
//   --accent-soft   #F6E3D2 / #3A2A18   --accent-strong #9C4A18 / #E08A3C
//   --ok            #2E7D4F / #4CAF7D   --warn   #B98A12 / #D9A62E
//   --danger        #B3261E / #E06055   --info   #2B5E8B / #6FA8D8
//
// Mapped in this pass: accent + on-accent, body/surface/card/muted
// backgrounds, primary/secondary text, border, success/warning/error/
// info fills, focus ring colour, radius scale (EZVault 4/8/12px on
// Astryx's 4px base), and the three font roles (system UI stack,
// Georgia notes serif for headings, ui-monospace for code).
//
// NOT mapped yet (recorded in docs/astryx-upgrade.md): the muted
// status fills and on-* pairs for success/warning/error/info beyond
// the main fills, categorical/data hues, shadow tokens, motion
// tempo, and per-component style overrides. EZVault's own CSS custom
// properties in globals.css are unchanged and still drive every
// existing (non-Astryx) surface.

import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

export const ezvaultTheme = defineTheme({
  name: "ezvault",
  extends: neutralTheme,
  typography: {
    body: {
      family: "-apple-system",
      fallbacks: '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    },
    heading: {
      family: "Georgia",
      fallbacks: '"Times New Roman", serif',
    },
    code: {
      family: "ui-monospace",
      fallbacks: '"SF Mono", Menlo, Consolas, monospace',
    },
  },
  // EZVault radius scale is 4 / 8 / 12px — Astryx's 4px base at 1x.
  radius: { base: 4, multiplier: 1 },
  tokens: {
    "--color-accent": ["#B3541E", "#E08A3C"],
    "--color-on-accent": ["#FFFFFF", "#1A1206"],
    "--color-accent-muted": ["#F6E3D2", "#3A2A18"],
    "--color-text-accent": ["#9C4A18", "#E08A3C"],
    "--color-icon-accent": ["#B3541E", "#E08A3C"],
    "--color-background-body": ["#FAF8F3", "#14120E"],
    "--color-background-surface": ["#FFFFFF", "#1E1B16"],
    "--color-background-card": ["#FFFFFF", "#1E1B16"],
    "--color-background-popover": ["#FFFFFF", "#1E1B16"],
    "--color-background-muted": ["#F1ECE1", "#26221B"],
    "--color-text-primary": ["#1E1B14", "#F2EDE3"],
    "--color-text-secondary": ["#5C5546", "#C4BBA9"],
    "--color-text-disabled": ["#6E6656", "#8F8674"],
    "--color-icon-primary": ["#1E1B14", "#F2EDE3"],
    "--color-icon-secondary": ["#5C5546", "#C4BBA9"],
    "--color-border": ["#E2DACA", "#3A342A"],
    "--color-border-emphasized": ["#6E6656", "#8F8674"],
    "--color-success": ["#2E7D4F", "#4CAF7D"],
    "--color-warning": ["#B98A12", "#D9A62E"],
    "--color-error": ["#B3261E", "#E06055"],
    "--color-info": ["#2B5E8B", "#6FA8D8"],
    "--focus-outline-color": ["#B3541E", "#E08A3C"],
  },
});
