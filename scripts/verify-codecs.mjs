// SPDX-License-Identifier: MIT
// verify-codecs.mjs — fail the build if the pinned sharp cannot decode the
// formats v1 promises. HEIF absence FAILS the build (checklist #6a path is
// browser-side, but the gate keeps silent decoder changes loud).
// Wave B1 (rows 7 + 6b): PDF and JP2000 are NOT decoded by libvips in the
// pinned build (sharp.format.pdf.input === false, sharp.format.jp2.input
// === false — note the key is `jp2`; the old gate probed a nonexistent
// `jp2k` key). They are decoded by the vetted render layer
// (lib/import/render.ts): pdfjs-dist + @napi-rs/canvas for PDF,
// @cornerstonejs/codec-openjpeg (OpenJPEG WASM) for JP2000. This gate now
// asserts that layer is installed; REQUIRE_JP2K=1 additionally asserts the
// OpenJPEG WASM binary is present on disk.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const info = sharp.versions ?? {};
const format = sharp.format ?? {};

const failures = [];
const warnings = [];

// sharp.format lists compiled-in input/output support
const need = ['jpeg', 'png', 'webp', 'tiff', 'gif', 'svg'];
for (const f of need) {
  if (!format[f]?.input) failures.push(`sharp missing input support: ${f}`);
}
// HEIF: check via libvips capability probe — attempt a tiny decode is expensive;
// instead assert the heif loader is registered.
try {
  const loaders = sharp.libvipsVersion ? true : false;
  void loaders;
} catch { /* noop */ }

let heifOk = false;
try {
  // Probe: create a 1x1 heif is not feasible without an encoder sample; use format table.
  heifOk = Boolean(format.heif?.input);
} catch { heifOk = false; }
if (!heifOk) failures.push('HEIF decoder absent from pinned sharp build (v1 gate: HEIC arrives browser-decoded, but the gate must stay loud)');

// Wave B1 render layer (PDF + JP2000). Absence of any leg fails the build:
// rows 7/6b promise these formats end-to-end.
for (const pkg of ['pdfjs-dist', '@napi-rs/canvas', '@cornerstonejs/codec-openjpeg']) {
  try {
    require.resolve(pkg);
  } catch {
    failures.push(`Wave B1 render-layer package missing: ${pkg} (see INTEGRATION-DECISIONS.md entries 6-7)`);
  }
}
let jp2WasmOk = false;
try {
  jp2WasmOk = existsSync(require.resolve('@cornerstonejs/codec-openjpeg/decodewasm'));
} catch { jp2WasmOk = false; }
if (process.env.REQUIRE_JP2K === '1' && !jp2WasmOk) {
  failures.push('JP2000 decoder required (REQUIRE_JP2K=1) but the OpenJPEG WASM binary is absent');
} else if (!jp2WasmOk) {
  warnings.push('JP2000 WASM binary not resolvable — JP2 imports will fail at process time');
}
if (!format.jp2?.input) {
  warnings.push('libvips has no JP2000 loader (expected) — JP2000 decodes via @cornerstonejs/codec-openjpeg WASM (lib/import/render.ts)');
}
if (!format.pdf?.input) {
  warnings.push('libvips has no PDF loader (expected) — PDFs render via pdfjs-dist + @napi-rs/canvas (lib/import/render.ts)');
}

for (const w of warnings) console.warn(`verify-codecs: WARNING — ${w}`);
if (failures.length) {
  for (const f of failures) console.error(`verify-codecs: FAIL — ${f}`);
  process.exit(1);
}
console.log(`verify-codecs: OK (libvips ${info.vips ?? 'unknown'}, sharp ${info.sharp ?? 'unknown'})`);
