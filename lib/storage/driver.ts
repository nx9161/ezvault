// SPDX-License-Identifier: MIT
/**
 * lib/storage/driver.ts — S3-API StorageDriver abstraction (ADR-2.9).
 *
 * No Cloudflare-specific calls may exist outside this module's R2 driver.
 * Backblaze B2 is the named fallback: swapping providers = config change
 * (endpoint + credentials) + data copy, no code change.
 */

export interface HeadInfo {
  size: number;
  contentType?: string;
  metadata?: Record<string, string>;
  /** ISO timestamp of last write (for lifecycle sweeps); may be absent. */
  lastModified?: string;
}

export interface PresignGetOptions {
  /** Presigned URL TTL in seconds (default 300). */
  ttlSec?: number;
  /** B2: pinned ResponseContentDisposition for originals = 'attachment'. */
  disposition?: 'attachment' | 'inline';
  /** B2: pinned ResponseContentType from the DB-recorded allowlist mimetype. */
  contentType?: string;
  /** Suggested download filename for attachment disposition. */
  filename?: string;
}

export interface StorageDriver {
  readonly name: 'r2' | 'local';
  /** Presigned PUT for direct-to-storage client upload (15-min TTL default). */
  presignPut(key: string, contentType: string, ttlSec?: number): Promise<string>;
  /** Presigned GET (5-min TTL default). */
  presignGet(key: string, opts?: PresignGetOptions): Promise<string>;
  head(key: string): Promise<HeadInfo | null>;
  /** Inclusive byte range fetch (magic-byte verification, B1). */
  getRange(key: string, start: number, end: number): Promise<Buffer>;
  /**
   * Full object bytes. Prefer streaming callers for large objects; this
   * buffers (used for .tpy DBs ≤100MB, zip entries, bake inputs).
   */
  getBytes(key: string): Promise<Buffer>;
  putBytes(key: string, body: Buffer, opts?: { contentType?: string; metadata?: Record<string, string> }): Promise<void>;
  copy(srcKey: string, destKey: string, opts?: { contentType?: string; metadata?: Record<string, string> }): Promise<void>;
  delete(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
  /** Prefix listing — nightly auditor only (meter uses DB counters, ADR-2.7). */
  listKeys(prefix: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Key layout (phase2 §5 — both buckets private; all reads via presigned URLs)
// ---------------------------------------------------------------------------

export const keys = {
  /** Source-of-truth original, byte-preserved, never mutated. */
  original: (projectId: string, photoId: string, ext: string) =>
    `originals/${projectId}/${photoId}.${ext}`,
  /** ONE derivative: 1600px longest side, WebP q80. */
  thumb: (projectId: string, photoId: string) => `thumbs/${projectId}/${photoId}.webp`,
  /** Presigned-upload landing (transient; lifecycle 24h). Server-chosen. */
  upload: (jobId: string, uuid: string, ext: string) => `uploads/${jobId}/${uuid}.${ext}`,
  /** .tpy wizard staging (transient; lifecycle 24h; never user-facing). */
  tpyStaging: (jobId: string, name: string) => `tpy-staging/${jobId}/${name}`,
  /** Baked exports / JSON-LD / CSV / ZIP (lifecycle 7d). */
  exportFile: (jobId: string, filename: string) => `exports/${jobId}/${filename}`,
  /** Full ALTO-XML (wave2+). */
  transcription: (projectId: string, id: string) => `transcriptions/${projectId}/${id}.xml`,
};

let cached: StorageDriver | null = null;

/**
 * Select the driver: R2 when the R2 env vars are present, otherwise the
 * local filesystem driver (local dev/QA). Fails with a clear message only
 * when R2 is *partially* configured.
 */
export async function getStorageDriver(): Promise<StorageDriver> {
  if (cached) return cached;
  const { R2StorageDriver } = await import('./r2');
  const { LocalStorageDriver } = await import('./local');
  const hasAccount = Boolean(process.env.R2_ACCOUNT_ID);
  const hasKey = Boolean(process.env.R2_ACCESS_KEY_ID);
  const hasSecret = Boolean(process.env.R2_SECRET_ACCESS_KEY);
  if (hasAccount || hasKey || hasSecret) {
    if (!(hasAccount && hasKey && hasSecret)) {
      throw new Error(
        'R2 is partially configured: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY together (or unset all three to use local storage).',
      );
    }
    cached = new R2StorageDriver();
  } else {
    cached = new LocalStorageDriver();
  }
  return cached;
}

/** Extension (no dot) for a mimetype on the v1 allowlist. */
export function extForMimetype(mimetype: string): string {
  switch (mimetype.toLowerCase()) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/svg+xml': return 'svg';
    case 'image/tiff': return 'tiff';
    case 'image/heic': return 'heic';
    case 'image/heif': return 'heif';
    case 'image/avif': return 'avif';
    default: return 'bin';
  }
}
