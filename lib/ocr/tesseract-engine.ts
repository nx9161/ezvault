// SPDX-License-Identifier: MIT
/**
 * lib/ocr/tesseract-engine.ts — the one real OCR engine (Wave C, row 14):
 * Tesseract.js 7.0.0 running CLIENT-side in a Web Worker.
 *
 * Why client-side: server CPU stays at zero ($0 forever) and the photo
 * never leaves the device for OCR. This module is ONLY reached through a
 * dynamic import() from the transcription panel's Run OCR handler, so
 * neither tesseract.js nor its worker/core/traineddata assets are in any
 * route's First Load JS.
 *
 * Asset strategy (INTEGRATION-DECISIONS.md #9): SELF-HOSTED under
 * public/ocr/ — the app CSP is script-src 'self' / connect-src 'self'
 * (+R2), so a pinned CDN would be blocked outright. The files there are
 * byte-copies of the pinned npm packages' dist artifacts (worker +
 * LSTM cores) plus the tessdata_fast eng model, refreshed by
 * scripts/sync-ocr-assets.mjs — never hand-edited.
 * workerBlobURL MUST stay false: a blob: worker would need worker-src
 * blob:, which the CSP does not grant.
 */

import { registerOcrEngine, mapTesseractData, type OcrEngine, type OcrResult } from './adapter';

export const TESSERACT_VERSION = '7.0.0';
/** Languages with self-hosted traineddata in public/ocr/lang/. */
export const TESSERACT_LANGUAGES = ['eng'];

const tesseractEngine: OcrEngine = {
  id: 'tesseract',
  version: TESSERACT_VERSION,
  languages: TESSERACT_LANGUAGES,
  async recognize(image: Blob, opts: { lang: string; onProgress?: (p: { status: string; progress: number }) => void }): Promise<OcrResult> {
    const lang = opts.lang || 'eng';
    if (!TESSERACT_LANGUAGES.includes(lang)) {
      throw new Error(`language data for "${lang}" is not installed (bundled: ${TESSERACT_LANGUAGES.join(', ')})`);
    }
    // Dynamic import: the ONLY edge from app code to tesseract.js.
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker(lang, 1, {
      workerPath: '/ocr/worker.min.js',
      corePath: '/ocr/',
      langPath: '/ocr/lang',
      workerBlobURL: false,
      gzip: true,
      logger: (m: { status: string; progress: number }) => {
        opts.onProgress?.({ status: m.status, progress: m.progress });
      },
    });
    try {
      const { data } = await worker.recognize(image, {}, { blocks: true });
      const result = mapTesseractData(data as never);
      if (!result.text.trim()) {
        throw new Error('OCR found no text in this image');
      }
      return result;
    } finally {
      await worker.terminate();
    }
  },
};

registerOcrEngine(tesseractEngine);

export default tesseractEngine;
