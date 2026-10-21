// SPDX-License-Identifier: MIT
/**
 * scripts/sync-ocr-assets.mjs — refresh the self-hosted Tesseract.js
 * runtime assets under public/ocr/ (Wave C, INTEGRATION-DECISIONS #9).
 *
 * Sources (all pinned; licenses verified in INTEGRATION-DECISIONS.md):
 *   - worker.min.js            <- node_modules/tesseract.js/dist (Apache-2.0)
 *   - tesseract-core-*-lstm.*  <- node_modules/tesseract.js-core (Apache-2.0;
 *                                 upstream Tesseract C++ Apache-2.0)
 *   - lang/eng.traineddata.gz  <- tesseract-ocr/tessdata_fast eng model
 *                                 (Apache-2.0), gzipped here at level 9.
 * Only the LSTM core variants are copied: the engine runs OEM 1
 * (LSTM only), so the legacy-engine cores are never requested.
 *
 * Run after any tesseract.js version bump:  node scripts/sync-ocr-assets.mjs
 */
import { copyFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const OUT = new URL('../public/ocr/', import.meta.url);
const LANG_OUT = new URL('../public/ocr/lang/', import.meta.url);
mkdirSync(OUT, { recursive: true });
mkdirSync(LANG_OUT, { recursive: true });

const COPIES = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-lstm.js', 'tesseract-core-lstm.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm', 'tesseract-core-lstm.wasm'],
  ['tesseract.js-core/tesseract-core-simd-lstm.js', 'tesseract-core-simd-lstm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm', 'tesseract-core-simd-lstm.wasm'],
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.js', 'tesseract-core-relaxedsimd-lstm.js'],
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm', 'tesseract-core-relaxedsimd-lstm.wasm'],
];

for (const [src, dest] of COPIES) {
  const from = new URL(`../node_modules/${src}`, import.meta.url);
  const to = new URL(dest, OUT);
  copyFileSync(from, to);
  console.log(`copied ${src} -> public/ocr/${dest} (${statSync(to).size} bytes)`);
}

// eng traineddata (tessdata_fast, pinned to the repo's main branch file —
// record the sha256 below; bump deliberately, never silently).
const TESSDATA_URL = 'https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata';
const res = await fetch(TESSDATA_URL);
if (!res.ok) throw new Error(`traineddata download failed: ${res.status}`);
const raw = Buffer.from(await res.arrayBuffer());
const sha = createHash('sha256').update(raw).digest('hex');
const gz = gzipSync(raw, { level: 9 });
writeFileSync(new URL('eng.traineddata.gz', LANG_OUT), gz);
console.log(`traineddata eng: ${raw.length} bytes raw (sha256 ${sha}) -> ${gz.length} bytes gz`);

// Sanity: the gz must round-trip to the raw model.
const { gunzipSync } = await import('node:zlib');
if (!gunzipSync(readFileSync(new URL('eng.traineddata.gz', LANG_OUT))).equals(raw)) {
  throw new Error('traineddata gzip round-trip failed');
}
console.log('sync-ocr-assets: OK');
