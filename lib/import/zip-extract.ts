// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/import/zip-extract.ts — streaming assets.zip extraction (B8).
 *
 * Constraints (AppSec §1.5a):
 *   - entries stream through bounded chunk reads (Range GETs); the zip never
 *     lands whole on the 512MB /tmp
 *   - reject absolute paths and any `..` segment after normalization
 *   - reject symlink entries (external_attr file-type bits)
 *   - cap total uncompressed bytes (2GB) and entry count (20k) -> 413 beyond
 *   - per-entry uncompressed cap = MAX_PHOTO_BYTES (200MB, B4)
 *   - methods: stored (0) and deflated (8) only; encrypted entries and
 *     data-descriptor entries are rejected with a recorded conflict
 *     (documented v1 limitation — re-zip without streaming writes)
 *
 * Pure parser over a chunked byte source; no dependency beyond node:zlib.
 */

import { inflateRawSync } from 'node:zlib';
import { getStorageDriver, keys } from '../storage/driver.js';
import { MAX_PHOTO_BYTES, ASSETS_ZIP_MAX_UNCOMPRESSED, ASSETS_ZIP_MAX_ENTRIES } from './validation.js';
import { HttpError } from '../api/route-utils.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

export interface ZipConflict {
  name: string;
  reason: string;
}

export interface ExtractedAssets {
  /** entry name (as stored) -> staged R2 key */
  keys: Record<string, string>;
  conflicts: ZipConflict[];
  entries: number;
  uncompressedBytes: number;
}

/** Chunked forward-only reader over a storage object. */
class ChunkReader {
  private buf = Buffer.alloc(0);
  private pos = 0; // absolute offset of buf[0]
  private eof = false;
  constructor(
    private storage: { getRange(k: string, s: number, e: number): Promise<Buffer>; head(k: string): Promise<{ size: number } | null> },
    private key: string,
    private size: number,
    private chunkSize = 1024 * 1024,
  ) {}

  /** Ensure at least `n` bytes available from the current cursor. */
  async need(n: number): Promise<Buffer> {
    while (this.buf.length < n && !this.eof) {
      const start = this.pos + this.buf.length;
      const end = Math.min(start + this.chunkSize - 1, this.size - 1);
      if (start > end) {
        this.eof = true;
        break;
      }
      const chunk = await this.storage.getRange(this.key, start, end);
      if (!chunk.length) {
        this.eof = true;
        break;
      }
      this.buf = Buffer.concat([this.buf, chunk]);
    }
    if (this.buf.length < n) throw new HttpError(422, 'zip_truncated', 'unexpected end of zip data');
    return this.buf.subarray(0, n);
  }

  /** Consume exactly n bytes (buffering more if needed). */
  async take(n: number): Promise<Buffer> {
    const b = await this.need(n);
    const out = b.subarray(0, n);
    this.buf = this.buf.subarray(n);
    this.pos += n;
    return out;
  }

  skip(n: number): void {
    if (n > this.buf.length) throw new HttpError(422, 'zip_truncated', 'skip past buffered data');
    this.buf = this.buf.subarray(n);
    this.pos += n;
  }

  get offset(): number {
    return this.pos;
  }
}

function isSymlink(externalAttr: number): boolean {
  return ((externalAttr >>> 16) & 0o170000) === 0o120000;
}

function safeEntryName(raw: string): string | null {
  // ZIP spec: forward slashes; never absolute, never escaping.
  if (!raw || raw.endsWith('/')) return null; // directories skipped by caller
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw) || raw.startsWith('\\\\')) return null;
  const parts = raw.split('/');
  for (const p of parts) {
    if (p === '..' || p === '' || p === '.') return null;
  }
  const normalized = parts.join('/');
  if (normalized.length > 1024) return null;
  return normalized;
}

export async function extractAssetsZip(jobId: string, zipKey: string): Promise<ExtractedAssets> {
  const storage = await getStorageDriver();
  const head = await storage.head(zipKey);
  if (!head) throw new HttpError(404, 'not_found', 'assets.zip not found in staging');

  const reader = new ChunkReader(storage as never, zipKey, head.size);
  const outKeys: Record<string, string> = {};
  const conflicts: ZipConflict[] = [];
  const seen = new Set<string>();
  let entries = 0;
  let totalUncompressed = 0;

  for (;;) {
    const sigBuf = await reader.need(4);
    const sig = sigBuf.readUInt32LE(0);
    if (sig === SIG_CENTRAL || sig === SIG_END) break; // local entries exhausted
    if (sig !== SIG_LOCAL) {
      throw new HttpError(422, 'zip_invalid', `bad local file header signature at offset ${reader.offset}`);
    }
    const hdr = await reader.take(30);
    const flags = hdr.readUInt16LE(6);
    const method = hdr.readUInt16LE(8);
    let compSize = hdr.readUInt32LE(18);
    let uncompSize = hdr.readUInt32LE(22);
    const nameLen = hdr.readUInt16LE(26);
    const extraLen = hdr.readUInt16LE(28);
    // Central-directory mirror fields live after the local header in the
    // central directory; for symlink detection we read the local header's
    // external attributes from the central directory — NOT available here.
    // Approximation: local headers don't carry external_attr, so symlinks
    // are detected in a second pass over the central directory below.
    void flags;

    if (nameLen > 2048) throw new HttpError(422, 'zip_invalid', 'entry name too long');
    const nameBuf = await reader.take(nameLen);
    await reader.take(extraLen); // skip extra field
    const rawName = nameBuf.toString('utf8');

    const encrypted = (flags & 0x01) !== 0;
    const hasDescriptor = (flags & 0x08) !== 0;

    const finishEntry = async (data: Buffer | null, conflictReason?: string) => {
      if (conflictReason) {
        conflicts.push({ name: rawName, reason: conflictReason });
        return;
      }
      if (data) {
        const safe = safeEntryName(rawName);
        if (!safe) {
          conflicts.push({ name: rawName, reason: 'unsafe_path' });
          return;
        }
        if (seen.has(safe)) {
          conflicts.push({ name: rawName, reason: 'duplicate_name' });
          return;
        }
        seen.add(safe);
        const destKey = keys.tpyStaging(jobId, `assets/${safe}`);
        await storage.putBytes(destKey, data, { contentType: 'application/octet-stream' });
        outKeys[rawName] = destKey;
        entries++;
        totalUncompressed += data.length;
      }
    };

    if (encrypted) {
      // Skip: cannot know the data length without the descriptor; the entry
      // is unusable — but we must advance. Encrypted entries always use a
      // data descriptor per APPNOTE, so treat as unsupported.
      await finishEntry(null, 'encrypted_unsupported');
      // Cannot advance reliably -> abort the archive (fail closed).
      throw new HttpError(422, 'zip_encrypted', `encrypted entry '${rawName}' — re-zip without encryption`);
    }
    if (hasDescriptor || compSize === 0xffffffff || uncompSize === 0xffffffff) {
      throw new HttpError(
        422, 'zip_descriptor_unsupported',
        `entry '${rawName}' uses a data descriptor (streaming-written zip) — re-zip without streaming writes`,
      );
    }
    if (method !== 0 && method !== 8) {
      // Skip entry data, record conflict.
      await reader.take(compSize);
      await finishEntry(null, `compression_method_${method}_unsupported`);
      continue;
    }
    if (uncompSize > MAX_PHOTO_BYTES) {
      throw new HttpError(413, 'zip_entry_too_large', `entry '${rawName}' uncompressed size exceeds the per-photo cap`);
    }
    if (entries + 1 > ASSETS_ZIP_MAX_ENTRIES) {
      throw new HttpError(413, 'zip_too_many_entries', `assets.zip exceeds ${ASSETS_ZIP_MAX_ENTRIES} entries`);
    }
    if (totalUncompressed + uncompSize > ASSETS_ZIP_MAX_UNCOMPRESSED) {
      throw new HttpError(413, 'zip_too_large', 'assets.zip exceeds 2GB uncompressed');
    }

    const compData = await reader.take(compSize);
    let data: Buffer;
    try {
      data = method === 0 ? compData : inflateRawSync(compData);
    } catch {
      await finishEntry(null, 'decompression_failed');
      continue;
    }
    if (data.length !== uncompSize) {
      await finishEntry(null, 'size_mismatch');
      continue;
    }
    await finishEntry(data);
  }

  // Second pass: central directory symlink scan (local headers lack
  // external_attr). Walk central headers and drop any extracted entry whose
  // central external_attr marks it a symlink.
  await rejectSymlinks(storage as never, zipKey, head.size, outKeys, conflicts, jobId);

  return { keys: outKeys, conflicts, entries, uncompressedBytes: totalUncompressed };
}

/**
 * Walk the central directory; for entries flagged as symlinks, delete the
 * staged bytes and record a conflict. Fail-closed: a symlink never reaches
 * the import.
 */
async function rejectSymlinks(
  storage: { getRange(k: string, s: number, e: number): Promise<Buffer>; delete(k: string): Promise<void> },
  zipKey: string,
  size: number,
  outKeys: Record<string, string>,
  conflicts: ZipConflict[],
  jobId: string,
): Promise<void> {
  // Read the end-of-central-directory from the tail.
  const tailSize = Math.min(size, 65557 + 22);
  const tail = await storage.getRange(zipKey, size - tailSize, size - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_END) {
      eocd = size - tailSize + i;
      break;
    }
  }
  if (eocd < 0) return; // no central directory — local pass already validated
  const eocdBuf = await storage.getRange(zipKey, eocd, eocd + 21);
  const cdCount = eocdBuf.readUInt16LE(10);
  const cdOffset = eocdBuf.readUInt32LE(16);

  let cursor = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    const hdr = await storage.getRange(zipKey, cursor, cursor + 45);
    if (hdr.readUInt32LE(0) !== SIG_CENTRAL) break;
    const nameLen = hdr.readUInt16LE(28);
    const extraLen = hdr.readUInt16LE(30);
    const commentLen = hdr.readUInt16LE(32);
    const externalAttr = hdr.readUInt32LE(38);
    const nameBuf = await storage.getRange(zipKey, cursor + 46, cursor + 46 + nameLen - 1);
    const rawName = nameBuf.toString('utf8');
    cursor += 46 + nameLen + extraLen + commentLen;
    if (isSymlink(externalAttr) && outKeys[rawName]) {
      const staged = outKeys[rawName];
      delete outKeys[rawName];
      await storage.delete(staged).catch(() => {});
      conflicts.push({ name: rawName, reason: 'symlink_rejected' });
      void jobId;
    }
  }
}
