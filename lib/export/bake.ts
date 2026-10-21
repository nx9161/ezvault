// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/export/bake.ts — server-side edit baking (phase2 §6.4).
 *
 * FIXED pipeline order (measured byte-deterministic on the pinned sharp):
 *   .rotate()                    EXIF auto-orient
 *   .rotate((360 - angle) % 360)  Tropy angle is CCW; sharp rotates CW
 *   .flop()                      mirror boolean (horizontal-only)
 *   .linear(1 + c/100, ...)      contrast
 *   .modulate({brightness, saturation, hue})
 *   .negate({ alpha: false })    negative
 *   .sharpen({ sigma: (sh/100) * 3 })
 *   .toFormat(png|jpeg)
 * Selection export: .extract({x,y,width,height}) FIRST.
 * EXIF orientation is normalized into pixels; EXIF stripped by default.
 */

import type { EditParams } from '../types';

export interface BakeOptions {
  edits: EditParams;
  format: 'png' | 'jpg';
  /** Selection rect — applied before the edit pipeline. */
  extract?: { x: number; y: number; width: number; height: number };
  /**
   * Wave B1 (row 7): rasterization density (PPI) for vector inputs (SVG).
   * Ignored by sharp for raster inputs. Callers pass the photo's stored
   * density (photos.density) so exports match the import render.
   */
  density?: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Bake edits into output bytes. `input` is the decoded source image buffer
 * (any sharp-supported format). Returns the encoded file bytes.
 */
export async function bakeImage(input: Buffer, opts: BakeOptions): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const e = opts.edits ?? {};
  const angle = clamp(Number(e.angle ?? 0), 0, 360);
  const brightness = clamp(Number(e.brightness ?? 0), -100, 100);
  const contrast = clamp(Number(e.contrast ?? 0), -100, 100);
  const hue = clamp(Number(e.hue ?? 0), -180, 180);
  const saturation = clamp(Number(e.saturation ?? 0), -100, 100);
  const sharpen = clamp(Number(e.sharpen ?? 0), 0, 100);

  let pipeline = sharp(input, {
    limitInputPixels: 50_000_000,
    ...(opts.density ? { density: opts.density } : {}),
  });

  // Selection export: extract region first (§6.4).
  if (opts.extract) {
    const r = opts.extract;
    pipeline = pipeline.extract({
      left: Math.max(0, Math.round(r.x)),
      top: Math.max(0, Math.round(r.y)),
      width: Math.max(1, Math.round(r.width)),
      height: Math.max(1, Math.round(r.height)),
    });
  }

  pipeline = pipeline.rotate(); // EXIF auto-orient into pixels
  const ccw = ((360 - angle) % 360 + 360) % 360;
  if (ccw !== 0) pipeline = pipeline.rotate(ccw);
  if (e.mirror) pipeline = pipeline.flop();

  if (contrast !== 0) {
    const a = 1 + contrast / 100;
    pipeline = pipeline.linear(a, 128 * (1 - a));
  }
  if (brightness !== 0 || saturation !== 0 || hue !== 0) {
    pipeline = pipeline.modulate({
      brightness: 1 + brightness / 100,
      saturation: 1 + saturation / 100,
      hue,
    });
  }
  if (e.negative) pipeline = pipeline.negate({ alpha: false });
  if (sharpen !== 0) pipeline = pipeline.sharpen({ sigma: (sharpen / 100) * 3 });

  if (opts.format === 'png') pipeline = pipeline.png();
  else pipeline = pipeline.jpeg({ quality: 92 });

  return pipeline.toBuffer();
}

/**
 * Render the 1600px WebP q80 thumbnail derivative (ADR-2.4: exactly ONE
 * derivative, pre-generated at upload). Never enlarges small images.
 * `density` (Wave B1) rasterizes SVG inputs at the chosen PPI.
 */
export async function renderThumb(input: Buffer, density?: number): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  return sharp(input, {
    limitInputPixels: 50_000_000,
    ...(density ? { density } : {}),
  })
    .rotate() // EXIF auto-orient
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}
