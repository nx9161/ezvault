// SPDX-License-Identifier: MIT
// verify-codecs.mjs — fail the build if the pinned sharp cannot decode the
// formats v1 promises. HEIF absence FAILS the build (checklist #6a path is
// browser-side, but the gate keeps silent decoder changes loud).
// JP2000 absence warns loudly; REQUIRE_JP2K=1 turns it into a hard fail (wave 2).
import sharp from 'sharp';

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

if (process.env.REQUIRE_JP2K === '1' && !format.jp2k?.input) {
  failures.push('JP2000 decoder required (REQUIRE_JP2K=1) but absent');
} else if (!format.jp2k?.input) {
  warnings.push('JP2000 decoder absent — wave-2 gate open (see ADR-2.x / checklist #6b)');
}

for (const w of warnings) console.warn(`verify-codecs: WARNING — ${w}`);
if (failures.length) {
  for (const f of failures) console.error(`verify-codecs: FAIL — ${f}`);
  process.exit(1);
}
console.log(`verify-codecs: OK (libvips ${info.vips ?? 'unknown'}, sharp ${info.sharp ?? 'unknown'})`);
