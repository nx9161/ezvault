// SPDX-License-Identifier: MIT
/**
 * test/fixtures/render-probe.mts — child-process probe for the unit suite.
 *
 * lib/import/render.ts is `server-only`, so the test runner cannot import
 * it in-process. test/pages-density.test.mjs spawns this probe with
 * `node --conditions=react-server --import tsx` and reads one JSON line:
 *   { pdfPages, pdfPage0: {width,height}, pdfPage1At300: {width,height},
 *     jp2: {width,height}, j2k: {width,height}, tiffPages }
 */
import { readFileSync } from 'node:fs';
import { countPdfPages, renderPdfPage, decodeJp2ToPng } from '../../lib/import/render';
import sharp from 'sharp';

const dir = new URL('.', import.meta.url).pathname;
const pdf = readFileSync(dir + 'two-page.pdf');
const out: Record<string, unknown> = {};
out.pdfPages = await countPdfPages(pdf);
const p0 = await renderPdfPage(pdf, 0, 150);
out.pdfPage0 = { width: p0.width, height: p0.height };
const p1 = await renderPdfPage(pdf, 1, 300);
out.pdfPage1At300 = { width: p1.width, height: p1.height };
out.jp2 = await decodeJp2ToPng(readFileSync(dir + 'sample.jp2')).then((r) => ({ width: r.width, height: r.height }));
out.j2k = await decodeJp2ToPng(readFileSync(dir + 'sample.j2k')).then((r) => ({ width: r.width, height: r.height }));
const tiffMeta = await sharp(readFileSync(dir + 'three-page.tiff')).metadata();
out.tiffPages = tiffMeta.pages ?? 1;
console.log(JSON.stringify(out));
