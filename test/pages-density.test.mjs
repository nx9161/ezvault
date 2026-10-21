// SPDX-License-Identifier: MIT
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { detectFormat, magicMatchesMimetype, mimetypeForFormat } from '../lib/import/magic.ts';
import { isAllowedUploadMimetype, stagedExtension } from '../lib/import/validation.ts';
import {
  DEFAULT_RENDER_DENSITY, MIN_RENDER_DENSITY, MAX_RENDER_DENSITY,
  isValidDensity, clampDensity, resolveDensity,
} from '../lib/import/density.ts';
import { planPageSplit, splitPhotoCount, MAX_SPLIT_PAGES } from '../lib/import/pages.ts';
import { jp2SamplesTo8Bit } from '../lib/import/jp2-samples.ts';

const FIX = new URL('./fixtures/', import.meta.url).pathname;

describe('Wave B1 magic: PDF + JP2000 (rows 7/6b)', () => {
  it('detects PDF by %PDF- header', () => {
    assert.equal(detectFormat(Buffer.from('%PDF-1.7\n')), 'pdf');
    assert.equal(detectFormat(readFileSync(FIX + 'two-page.pdf')), 'pdf');
    assert.equal(magicMatchesMimetype('application/pdf', Buffer.from('%PDF-1.4')), true);
    assert.equal(magicMatchesMimetype('image/png', Buffer.from('%PDF-1.4')), false);
    assert.equal(mimetypeForFormat('pdf'), 'application/pdf');
  });
  it('detects JP2000 container signature box and raw codestream SOC', () => {
    const sigBox = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]);
    assert.equal(detectFormat(sigBox), 'jp2');
    assert.equal(detectFormat(readFileSync(FIX + 'sample.jp2')), 'jp2');
    assert.equal(detectFormat(Buffer.from([0xff, 0x4f, 0xff, 0x51, 0x00])), 'jp2');
    assert.equal(detectFormat(readFileSync(FIX + 'sample.j2k')), 'jp2');
    assert.equal(magicMatchesMimetype('image/jp2', sigBox), true);
    assert.equal(magicMatchesMimetype('image/jpeg', sigBox), false);
    assert.equal(mimetypeForFormat('jp2'), 'image/jp2');
  });
  it('allowlist + staged extensions accept pdf/jp2', () => {
    assert.equal(isAllowedUploadMimetype('application/pdf'), true);
    assert.equal(isAllowedUploadMimetype('image/jp2'), true);
    assert.equal(stagedExtension('application/pdf'), 'pdf');
    assert.equal(stagedExtension('image/jp2'), 'jp2');
  });
});

describe('render density plumbing (row 7)', () => {
  it('defaults and bounds', () => {
    assert.equal(DEFAULT_RENDER_DENSITY, 300);
    assert.equal(isValidDensity(300), true);
    assert.equal(isValidDensity(MIN_RENDER_DENSITY), true);
    assert.equal(isValidDensity(MAX_RENDER_DENSITY), true);
    assert.equal(isValidDensity(35), false);
    assert.equal(isValidDensity(1201), false);
    assert.equal(isValidDensity(150.5), false);
    assert.equal(isValidDensity('300'), false);
    assert.equal(isValidDensity(null), false);
  });
  it('clampDensity clamps numerics and falls back on junk', () => {
    assert.equal(clampDensity(150), 150);
    assert.equal(clampDensity(10), MIN_RENDER_DENSITY);
    assert.equal(clampDensity(99999), MAX_RENDER_DENSITY);
    assert.equal(clampDensity(Number.NaN), DEFAULT_RENDER_DENSITY);
    assert.equal(clampDensity('abc'), DEFAULT_RENDER_DENSITY);
  });
  it('resolveDensity: photo override > project default > global default', () => {
    assert.equal(resolveDensity(150, 200), 150);
    assert.equal(resolveDensity(null, 200), 200);
    assert.equal(resolveDensity(undefined, undefined), DEFAULT_RENDER_DENSITY);
    assert.equal(resolveDensity(99999, 200), 200); // invalid override ignored
    assert.equal(resolveDensity(null, null), DEFAULT_RENDER_DENSITY);
  });
});

describe('page-split planning (row 34)', () => {
  it('single-page files produce exactly one photo on page 0', () => {
    assert.deepEqual(planPageSplit(1, true), [{ page: 0, position: 0, newItem: true }]);
    assert.deepEqual(planPageSplit(1, false), [{ page: 0, position: 0, newItem: true }]);
    assert.equal(splitPhotoCount(1), 1);
    assert.equal(splitPhotoCount(0), 1);
  });
  it('grouped: all pages under one item, positions follow pages', () => {
    assert.deepEqual(planPageSplit(3, true), [
      { page: 0, position: 0, newItem: true },
      { page: 1, position: 1, newItem: false },
      { page: 2, position: 2, newItem: false },
    ]);
  });
  it('split: one item per page, each photo at position 0', () => {
    assert.deepEqual(planPageSplit(3, false), [
      { page: 0, position: 0, newItem: true },
      { page: 1, position: 0, newItem: true },
      { page: 2, position: 0, newItem: true },
    ]);
  });
  it('page counts clamp to MAX_SPLIT_PAGES', () => {
    assert.equal(splitPhotoCount(99999), MAX_SPLIT_PAGES);
    assert.equal(planPageSplit(99999, true).length, MAX_SPLIT_PAGES);
  });
  it('the TIFF fixture really has 3 pages (sharp metadata)', async () => {
    const meta = await sharp(readFileSync(FIX + 'three-page.tiff')).metadata();
    assert.equal(meta.pages, 3);
    assert.equal(splitPhotoCount(meta.pages ?? 1), 3);
  });
});

describe('JP2000 sample conversion (row 6b)', () => {
  it('8-bit unsigned passes through untouched', () => {
    const raw = new Uint8Array([0, 127, 255]);
    assert.equal(jp2SamplesTo8Bit(raw, 8, false), raw);
  });
  it('16-bit unsigned scales down by 8', () => {
    const raw = new Uint8Array([0x00, 0xff, 0x00, 0x80, 0x00, 0x00]); // LE words 0xff00, 0x8000, 0
    assert.deepEqual(Array.from(jp2SamplesTo8Bit(raw, 16, false)), [255, 128, 0]);
  });
  it('12-bit unsigned scales down by 4', () => {
    const raw = new Uint8Array([0xf0, 0xff, 0x00, 0x08]); // LE words 0xfff0, 0x0800
    assert.deepEqual(Array.from(jp2SamplesTo8Bit(raw, 12, false)), [255, 128]);
  });
  it('signed 16-bit offsets to unsigned', () => {
    // Int16 LE: -32768 -> 0, 0 -> 128, 32767 -> 255
    const raw = new Uint8Array([0x00, 0x80, 0x00, 0x00, 0xff, 0x7f]);
    assert.deepEqual(Array.from(jp2SamplesTo8Bit(raw, 16, true)), [0, 128, 255]);
  });
  it('rejects absurd bit depths', () => {
    assert.throws(() => jp2SamplesTo8Bit(new Uint8Array(4), 24, false), /bit depth/);
    assert.throws(() => jp2SamplesTo8Bit(new Uint8Array(4), 0, false), /bit depth/);
  });
});

describe('render layer probe (server-only module, child process)', () => {
  it('PDF page count + density-scaled renders, JP2/J2K decode, TIFF pages', () => {
    const stdout = execFileSync(
      process.execPath,
      ['--conditions=react-server', '--import', 'tsx', FIX + 'render-probe.mts'],
      { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', timeout: 120_000 },
    );
    const out = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(out.pdfPages, 2);
    // Fixture pages are 200x100 pt: 150 dpi -> 417x209, 300 dpi -> 834x417.
    assert.deepEqual(out.pdfPage0, { width: 417, height: 209 });
    assert.deepEqual(out.pdfPage1At300, { width: 834, height: 417 });
    assert.deepEqual(out.jp2, { width: 200, height: 100 });
    assert.deepEqual(out.j2k, { width: 200, height: 100 });
    assert.equal(out.tiffPages, 3);
  });
});
