// SPDX-License-Identifier: MIT
/**
 * scripts/generate-pwa-icons.mjs — render the PWA install icons from an
 * original SVG glyph: the app's VaultMark geometry (a 2×2 grid of
 * squares, top-left filled with the accent) on the design-token
 * background. No borrowed artwork.
 *
 * Run once (outputs are committed):  node scripts/generate-pwa-icons.mjs
 */
import { mkdirSync } from "node:fs";
import sharp from "sharp";

const OUT = new URL("../public/icons/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const BG = "#FAF8F3";
const INK = "#1E1B14";
const ACCENT = "#B3541E";

/** VaultMark glyph centered in a `size` canvas with `pad` breathing room. */
function glyphSvg(size, pad) {
  const inner = size - pad * 2;
  const cell = inner / 2 - inner * 0.045;
  const gap = inner * 0.09;
  const x0 = pad;
  const y0 = pad;
  const x1 = pad + cell + gap;
  const y1 = pad + cell + gap;
  const sw = Math.max(2, size * 0.018);
  const square = (x, y, filled) =>
    `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" ${
      filled
        ? `fill="${ACCENT}"`
        : `fill="none" stroke="${INK}" stroke-width="${sw}"`
    }/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${BG}"/>
  ${square(x0, y0, true)}
  ${square(x1, y0, false)}
  ${square(x0, y1, false)}
  ${square(x1, y1, false)}
</svg>`;
}

async function render(name, size, padRatio) {
  const svg = glyphSvg(size, Math.round(size * padRatio));
  const to = new URL(name, OUT);
  await sharp(Buffer.from(svg)).png().toFile(to.pathname);
  console.log(`generate-pwa-icons: wrote public/icons/${name} (${size}×${size})`);
}

await render("icon-192.png", 192, 0.16);
await render("icon-512.png", 512, 0.16);
// Maskable: extra safe-zone padding + full-bleed background.
await render("icon-maskable-512.png", 512, 0.24);
await render("apple-touch-icon.png", 180, 0.16);
