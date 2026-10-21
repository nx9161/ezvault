// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/import/render.ts — server-side rasterizers for the formats the pinned
 * sharp/libvips build cannot decode (Wave B1, parity rows 7 + 6b).
 *
 * Verified at runtime (2026-10-21, sharp 0.35.5 / libvips 8.18.7):
 * `sharp.format.pdf.input === false` and `sharp.format.jp2.input === false`
 * — libvips was built without poppler/pdfium and without OpenJPEG. So:
 *
 *   - PDF → pdfjs-dist (Apache-2.0, Mozilla PDF.js) rendering onto
 *     @napi-rs/canvas (MIT) 2D canvases, one page per call, at the
 *     photo's render density (PPI). PNG bytes out; sharp takes it from
 *     there (pixel cap, thumbnail, EXIF-shaped metadata).
 *   - JP2000 → @cornerstonejs/codec-openjpeg (MIT wrapper around the
 *     BSD-2-Clause OpenJPEG WASM build) decoding to interleaved 8-bit
 *     pixels, re-encoded to PNG via sharp for the standard pipeline.
 *
 * Both are SERVER-only: this module imports 'server-only' and is only ever
 * reached from route handlers / the process pipeline, never client code.
 * Vetting records: INTEGRATION-DECISIONS.md entries 6 + 7.
 */

import { MAX_INPUT_PIXELS } from './validation';
import { clampDensity } from './density';

export interface RasterPage {
  /** PNG-encoded pixels of the rendered page. */
  png: Buffer;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// PDF (pdfjs-dist + @napi-rs/canvas)
// ---------------------------------------------------------------------------

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfDocument = Awaited<ReturnType<PdfjsModule['getDocument']>['promise']>;

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/** Load pdf.js once, with the @napi-rs/canvas DOM globals it requires. */
async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const canvasPkg = await import('@napi-rs/canvas');
      const g = globalThis as Record<string, unknown>;
      // PDF.js's canvas renderer touches these constructors in Node.
      g.DOMMatrix ??= canvasPkg.DOMMatrix;
      g.ImageData ??= canvasPkg.ImageData;
      g.Path2D ??= canvasPkg.Path2D;
      return import('pdfjs-dist/legacy/build/pdf.mjs');
    })();
  }
  return pdfjsPromise;
}

async function openPdf(bytes: Buffer): Promise<{ pdfjs: PdfjsModule; doc: PdfDocument; destroy: () => Promise<void> }> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    // No external fetches, ever: fonts/cmaps ship with the package.
    useSystemFonts: false,
  });
  const doc = await task.promise;
  return { pdfjs, doc, destroy: () => task.destroy() };
}

/** Page count of a PDF (≥1). Throws when the bytes are not a readable PDF. */
export async function countPdfPages(bytes: Buffer): Promise<number> {
  const { doc, destroy } = await openPdf(bytes);
  try {
    return doc.numPages;
  } finally {
    await destroy().catch(() => {});
  }
}

/**
 * Render one 0-based PDF page at `density` PPI to PNG.
 * Page sizes in PDF are points (1/72"); scale = density/72. The B5 pixel
 * cap is enforced on the raster size before allocating the canvas.
 */
export async function renderPdfPage(bytes: Buffer, page: number, density: number): Promise<RasterPage> {
  const dpi = clampDensity(density);
  const { doc, destroy } = await openPdf(bytes);
  try {
    if (page < 0 || page >= doc.numPages) {
      throw new Error(`pdf page ${page} out of range (0..${doc.numPages - 1})`);
    }
    const pdfPage = await doc.getPage(page + 1); // pdf.js pages are 1-based
    const viewport = pdfPage.getViewport({ scale: dpi / 72 });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    if (width * height > MAX_INPUT_PIXELS) {
      throw new Error(`rendered page exceeds the ${MAX_INPUT_PIXELS}px input cap at ${dpi} dpi`);
    }
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    // Documents are usually opaque; paint white so transparent page
    // backgrounds don't turn black in the WebP thumbnail.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    await pdfPage.render({ canvasContext: ctx as never, canvas: canvas as never, viewport }).promise;
    pdfPage.cleanup();
    const png = await canvas.encode('png');
    return { png: Buffer.from(png), width, height };
  } finally {
    await destroy().catch(() => {});
  }
}

/**
 * Prepare an original's bytes for sharp-based consumers (export bake):
 * PDF → the photo's page rendered at `density`; JP2000 → decoded PNG;
 * anything else passes through untouched (SVG density is a sharp option
 * at the bake call site, not a pre-rasterization).
 */
export async function rasterizeOriginalForBake(
  bytes: Buffer,
  mimetype: string,
  page: number,
  density: number,
): Promise<Buffer> {
  if (mimetype === 'application/pdf') {
    return (await renderPdfPage(bytes, page, density)).png;
  }
  if (mimetype === 'image/jp2') {
    return (await decodeJp2ToPng(bytes)).png;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// JPEG 2000 (@cornerstonejs/codec-openjpeg — OpenJPEG WASM)
// ---------------------------------------------------------------------------

interface Jp2FrameInfo {
  width: number;
  height: number;
  bitsPerSample: number;
  componentCount: number;
  isSigned: boolean;
}

interface Jp2Decoder {
  getEncodedBuffer(size: number): Uint8Array;
  readHeader(): void;
  decode(): void;
  getFrameInfo(): Jp2FrameInfo;
  getDecodedBuffer(): Uint8Array;
}

type OpenJpegModule = { J2KDecoder: new () => Jp2Decoder };

let jp2ModulePromise: Promise<OpenJpegModule> | null = null;

/** Load the OpenJPEG WASM decoder once (decode-only build). */
async function loadJp2(): Promise<OpenJpegModule> {
  if (!jp2ModulePromise) {
    jp2ModulePromise = (async () => {
      const { createRequire } = await import('node:module');
      const { join } = await import('node:path');
      const require = createRequire(import.meta.url);
      // The decode-only Emscripten factory (JS is a normal external
      // require). The .wasm path is built from the filesystem layout —
      // deliberately NOT require.resolve('.../decodewasm'): that subpath
      // resolves to the raw .wasm asset, which the bundler tries (and
      // fails) to place as a module. locateFile hands the path to
      // Emscripten at runtime instead.
      const factory = require('@cornerstonejs/codec-openjpeg/decodewasmjs') as (
        opts: Record<string, unknown>,
      ) => Promise<OpenJpegModule>;
      const wasmPath = join(
        process.cwd(), 'node_modules', '@cornerstonejs', 'codec-openjpeg', 'dist', 'openjpegwasm_decode.wasm',
      );
      return factory({ locateFile: () => wasmPath });
    })();
  }
  return jp2ModulePromise;
}

/**
 * Convert the decoder's raw sample buffer to interleaved 8-bit samples.
 * Implementation lives in the pure module lib/import/jp2-samples.ts
 * (unit-tested in test/pages-density.test.mjs); re-exported here.
 */
import { jp2SamplesTo8Bit } from './jp2-samples';
export { jp2SamplesTo8Bit };

/**
 * Decode a JP2000 file (.jp2 container or raw .j2k codestream) to a PNG
 * via sharp's raw-pixel encoder. Supports 1/3/4 components at 8–16 bits;
 * anything more exotic throws (the caller surfaces an honest 422).
 */
export async function decodeJp2ToPng(bytes: Buffer): Promise<RasterPage> {
  const mod = await loadJp2();
  const decoder = new mod.J2KDecoder();
  decoder.getEncodedBuffer(bytes.length).set(bytes);
  decoder.readHeader();
  decoder.decode();
  const info = decoder.getFrameInfo();
  if (!info.width || !info.height) throw new Error('JP2000 header decoded to zero dimensions');
  if (![1, 3, 4].includes(info.componentCount)) {
    throw new Error(`unsupported JP2000 component count: ${info.componentCount}`);
  }
  if (info.width * info.height > MAX_INPUT_PIXELS) {
    throw new Error(`JP2000 image exceeds the ${MAX_INPUT_PIXELS}px input cap`);
  }
  const samples = jp2SamplesTo8Bit(decoder.getDecodedBuffer(), info.bitsPerSample, info.isSigned);
  const expected = info.width * info.height * info.componentCount;
  if (samples.length < expected) {
    throw new Error(`JP2000 decode truncated: ${samples.length} < ${expected} samples`);
  }
  const { default: sharp } = await import('sharp');
  const png = await sharp(Buffer.from(samples.subarray(0, expected)), {
    raw: { width: info.width, height: info.height, channels: info.componentCount as 1 | 3 | 4 },
  })
    .png()
    .toBuffer();
  return { png, width: info.width, height: info.height };
}
