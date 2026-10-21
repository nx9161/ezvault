// SPDX-License-Identifier: MIT
/**
 * lib/ocr/adapter.ts — the OCR hook (Wave C, row 14).
 *
 * The parity item is the PLUGGABLE ADAPTER: a small engine contract that
 * any OCR engine can register against. Engines write into the existing
 * transcriptions shape (text + words + config provenance) — nothing
 * OCR-specific leaks into storage.
 *
 * Contract:
 *   engine.id        stable id recorded in config.engine
 *   engine.languages ISO codes the deployment actually ships data for
 *   engine.recognize(image, opts) -> { text, words }
 * Words are in IMAGE PIXEL coordinates of the image handed to the
 * engine; the caller stores page_width/page_height = that image's size.
 *
 * This module is pure (no DOM, no engine imports) so adapter mapping is
 * unit-testable with a stub engine. The real Tesseract engine lives in
 * lib/ocr/tesseract-engine.ts and is dynamic-imported on first use —
 * nothing OCR-related enters First Load JS.
 */

import type { TranscriptionWord } from '@/lib/types';

export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence?: number;
}

export interface OcrResult {
  text: string;
  words: OcrWord[];
}

export interface OcrProgress {
  status: string;
  /** 0..1 within the current status. */
  progress: number;
}

export interface OcrEngine {
  id: string;
  /** Engine build/version string recorded in config.version. */
  version: string;
  /** Languages this deployment can actually run (data shipped). */
  languages: string[];
  recognize(
    image: Blob,
    opts: { lang: string; onProgress?: (p: OcrProgress) => void },
  ): Promise<OcrResult>;
}

// --- registry ---------------------------------------------------------------

const engines = new Map<string, OcrEngine>();

export function registerOcrEngine(engine: OcrEngine): void {
  engines.set(engine.id, engine);
}

export function getOcrEngine(id: string): OcrEngine | undefined {
  return engines.get(id);
}

export function listOcrEngines(): OcrEngine[] {
  return [...engines.values()];
}

// --- Tesseract.js result mapping ---------------------------------------------

/** Minimal structural view of tesseract.js recognize() output. */
export interface TesseractLikeData {
  text?: string;
  /** Legacy flat word list (pre-blocks output). */
  words?: Array<{
    text?: string;
    confidence?: number;
    bbox?: { x0: number; y0: number; x1: number; y1: number };
  }>;
  /** Block hierarchy (blocks output): block>paragraph>line>word. */
  blocks?: Array<{
    paragraphs?: Array<{
      lines?: Array<{
        words?: Array<{
          text?: string;
          confidence?: number;
          bbox?: { x0: number; y0: number; x1: number; y1: number };
        }>;
      }>;
    }>;
  }> | null;
}

function bboxWord(text: string | undefined, confidence: number | undefined,
  bbox: { x0: number; y0: number; x1: number; y1: number } | undefined): OcrWord | null {
  if (!text || !bbox) return null;
  const w = bbox.x1 - bbox.x0;
  const h = bbox.y1 - bbox.y0;
  if (!(w > 0) || !(h > 0)) return null;
  return {
    text,
    x: bbox.x0,
    y: bbox.y0,
    w,
    h,
    ...(typeof confidence === 'number' ? { confidence: confidence / 100 } : {}),
  };
}

/**
 * Map tesseract.js output (either shape) to the adapter result.
 * Tesseract confidences arrive as 0..100; the transcription shape stores
 * 0..1 (ALTO WC convention) — normalized here. Throws on an empty/junk
 * payload so a failed recognize can never masquerade as an empty success.
 */
export function mapTesseractData(data: TesseractLikeData): OcrResult {
  if (!data || typeof data !== 'object') {
    throw new Error('OCR engine returned no data');
  }
  const words: OcrWord[] = [];
  if (Array.isArray(data.blocks)) {
    for (const block of data.blocks) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) {
          for (const word of line.words ?? []) {
            const mapped = bboxWord(word.text, word.confidence, word.bbox);
            if (mapped) words.push(mapped);
          }
        }
      }
    }
  }
  if (!words.length && Array.isArray(data.words)) {
    for (const word of data.words) {
      const mapped = bboxWord(word.text, word.confidence, word.bbox);
      if (mapped) words.push(mapped);
    }
  }
  const text = typeof data.text === 'string' ? data.text : '';
  return { text, words };
}

/** Build the POST body that persists an OCR result as a transcription. */
export function transcriptionPayloadFromOcr(
  result: OcrResult,
  meta: { engine: string; version: string; lang: string; pageWidth: number; pageHeight: number },
): {
  text: string;
  config: Record<string, unknown>;
  status: string;
  words: TranscriptionWord[];
  page_width: number;
  page_height: number;
} {
  return {
    text: result.text,
    config: { source: 'ocr', engine: meta.engine, version: meta.version, lang: meta.lang },
    status: 'done',
    words: result.words,
    page_width: meta.pageWidth,
    page_height: meta.pageHeight,
  };
}
