// SPDX-License-Identifier: MIT
/**
 * lib/import/validation.ts — upload-pipeline validation constants (B4).
 */

import { UPLOAD_MIMETYPES } from '../types';

/** B4: per-photo byte cap, enforced at /complete via HeadObject (413). */
export const MAX_PHOTO_BYTES = 200 * 1024 * 1024; // 200 MB

/** .tpy wizard ceiling (B9): measured-safe default; raise only on test evidence. */
export const TPY_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
export const TPY_HARD_MAX_BYTES = 250 * 1024 * 1024; // absolute ceiling, never exceeded

/** assets.zip caps (B8). */
export const ASSETS_ZIP_MAX_UNCOMPRESSED = 2 * 1024 * 1024 * 1024; // 2 GB
export const ASSETS_ZIP_MAX_ENTRIES = 20_000;

/** B5: sharp decode pixel cap (decompression-bomb guard). */
export const MAX_INPUT_PIXELS = 50_000_000;

/** Magic-byte probe size (B1): first 16 KB via Range GET. */
export const MAGIC_PROBE_BYTES = 16 * 1024;

const ALLOWLIST = new Set<string>(UPLOAD_MIMETYPES as readonly string[]);

export function isAllowedUploadMimetype(mimetype: string): boolean {
  return ALLOWLIST.has(mimetype.toLowerCase());
}

/** Server-chosen, allowlisted extension for a staged upload key. */
export function stagedExtension(mimetype: string): string {
  switch (mimetype.toLowerCase()) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/svg+xml': return 'svg';
    case 'image/tiff': return 'tif';
    case 'image/heic': return 'heic';
    case 'image/heif': return 'heif';
    case 'image/avif': return 'avif';
    case 'application/pdf': return 'pdf';
    case 'image/jp2': return 'jp2';
    default: throw new Error(`mimetype not on v1 allowlist: ${mimetype}`);
  }
}
