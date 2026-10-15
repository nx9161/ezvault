// SPDX-License-Identifier: MIT
/**
 * lib/import/magic.ts — magic-byte verification for the v1 upload allowlist
 * (B1: Range-GET first 16 KB at /complete, 422 + delete staged object on
 * mismatch).
 *
 * Detects the 10 v1 formats: jpg, png, gif, webp, svg, tiff, heic, heif, avif
 * (+ tiff counted once: the allowlist is {jpg,png,gif,webp,svg,tiff,heic,
 * heif,avif} — 9 distinct formats, svg included).
 */

export type DetectedFormat =
  | 'jpg' | 'png' | 'gif' | 'webp' | 'svg' | 'tiff'
  | 'heic' | 'heif' | 'avif';

const HEIC_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs',
]);
const HEIF_BRANDS = new Set(['mif1', 'msf1', 'hevc', 'hevx', ...HEIC_BRANDS]);
const AVIF_BRANDS = new Set(['avif', 'avis']);

function ascii(buf: Buffer, start: number, len: number): string {
  return buf.subarray(start, start + len).toString('ascii');
}

/**
 * Detect the image format from the first bytes. Returns null when the
 * bytes match none of the v1 allowlist signatures.
 */
export function detectFormat(head: Buffer): DetectedFormat | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'jpg';
  }
  if (
    head.length >= 8 &&
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
  ) {
    return 'png';
  }
  if (head.length >= 6 && ascii(head, 0, 4) === 'GIF8') return 'gif';
  if (
    head.length >= 12 &&
    ascii(head, 0, 4) === 'RIFF' &&
    ascii(head, 8, 4) === 'WEBP'
  ) {
    return 'webp';
  }
  if (
    head.length >= 4 &&
    ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0x00) ||
      (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00 && head[3] === 0x2a))
  ) {
    return 'tiff';
  }
  // ISO BMFF (HEIC/HEIF/AVIF): 'ftyp' at offset 4, brand at offset 8.
  if (head.length >= 12 && ascii(head, 4, 4) === 'ftyp') {
    const brand = ascii(head, 8, 4);
    if (AVIF_BRANDS.has(brand)) return 'avif';
    if (HEIC_BRANDS.has(brand)) return 'heic';
    if (HEIF_BRANDS.has(brand)) return 'heif';
    return null; // unknown BMFF brand (e.g. video mp4) — reject
  }
  // SVG: XML text — look for `<svg` in the head, tolerating BOM, XML
  // declarations, comments and doctypes before the root element.
  const text = head.subarray(0, Math.min(head.length, 16384)).toString('utf8').toLowerCase();
  const stripped = text
    .replace(/^\uFEFF/, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!doctype[^>]*>/g, '')
    .trimStart();
  if (stripped.startsWith('<svg')) return 'svg';
  return null;
}

/** The mimetype the client claimed at presign must match the magic bytes. */
export function magicMatchesMimetype(mimetype: string, head: Buffer): boolean {
  const detected = detectFormat(head);
  if (!detected) return false;
  switch (mimetype.toLowerCase()) {
    case 'image/jpeg': return detected === 'jpg';
    case 'image/png': return detected === 'png';
    case 'image/gif': return detected === 'gif';
    case 'image/webp': return detected === 'webp';
    case 'image/svg+xml': return detected === 'svg';
    case 'image/tiff': return detected === 'tiff';
    case 'image/heic': return detected === 'heic' || detected === 'heif';
    case 'image/heif': return detected === 'heif' || detected === 'heic';
    case 'image/avif': return detected === 'avif';
    default: return false;
  }
}

/** Mimetype implied by magic bytes (for server-chosen extensions). */
export function mimetypeForFormat(format: DetectedFormat): string {
  switch (format) {
    case 'jpg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'tiff': return 'image/tiff';
    case 'heic': return 'image/heic';
    case 'heif': return 'image/heif';
    case 'avif': return 'image/avif';
  }
}

/** Alias for route-friendly naming (identical to detectFormat). */
export const detectFromBytes = detectFormat;
