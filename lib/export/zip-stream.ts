// SPDX-License-Identifier: MIT
/**
 * lib/export/zip-stream.ts — streaming ZIP writer (parity row 24).
 *
 * Wraps fflate's streaming Zip (MIT, vetted — INTEGRATION-DECISIONS.md #8)
 * behind a Web ReadableStream so the archive route can pipe a whole project
 * to the response without ever holding the archive (or any single original)
 * in memory: source bytes are pulled in bounded chunks from the storage
 * driver. Media originals are STORED (they are already compressed — JPEG /
 * PNG / WebP gain nothing from deflate and the CPU budget is binding);
 * text entries (metadata JSON-LD, notes, manifest) are deflated.
 */

import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

export interface ZipSourceFile {
  /** archive path (forward slashes, no leading slash) */
  name: string;
  /** true = deflate (text); false = stored (media originals) */
  compress: boolean;
  /** lazy byte source — pulled chunk by chunk, never fully buffered here */
  chunks: () => AsyncIterable<Uint8Array>;
}

/** Sanitize one path segment for use inside the archive. */
export function zipSegment(raw: string): string {
  const s = raw
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return s.length ? s.slice(0, 120) : 'untitled';
}

/**
 * Build a ReadableStream<Uint8Array> of ZIP bytes for the given files.
 * Files are written strictly in array order; each file's chunk source is
 * fully drained before the next file starts (fflate serializes entries).
 * A source error errors the stream — the archive is aborted, never silently
 * truncated mid-file without a stream error.
 */
export function createZipStream(files: readonly ZipSourceFile[]): ReadableStream<Uint8Array> {
  let zip: Zip | null = null;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((err, chunk, final) => {
        if (cancelled) return;
        if (err) {
          controller.error(err);
          return;
        }
        if (chunk.length) controller.enqueue(chunk);
        if (final) controller.close();
      });
      void (async () => {
        try {
          for (const file of files) {
            if (cancelled) return;
            const entry: ZipDeflate | ZipPassThrough = file.compress
              ? new ZipDeflate(file.name, { level: 6 })
              : new ZipPassThrough(file.name);
            zip!.add(entry);
            for await (const chunk of file.chunks()) {
              if (cancelled) return;
              if (chunk.length) entry.push(chunk, false);
            }
            entry.push(new Uint8Array(0), true);
          }
          zip!.end();
        } catch (err) {
          if (!cancelled) controller.error(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    },
    cancel() {
      cancelled = true;
      try {
        zip?.terminate();
      } catch {
        /* already finished */
      }
    },
  });
}

/** Chunk a storage object's bytes via ranged reads (bounded memory). */
export async function* storageChunks(
  storage: { getRange(key: string, start: number, end: number): Promise<Buffer> },
  key: string,
  size: number,
  chunkBytes = 4 * 1024 * 1024,
): AsyncIterable<Uint8Array> {
  let offset = 0;
  while (offset < size) {
    const end = Math.min(size, offset + chunkBytes) - 1;
    const buf = await storage.getRange(key, offset, end);
    yield new Uint8Array(buf);
    offset = end + 1;
  }
  if (size === 0) yield new Uint8Array(0);
}

/** One-shot byte source for small in-memory entries (metadata, notes). */
export function bytesChunks(bytes: Uint8Array): () => AsyncIterable<Uint8Array> {
  return async function* () {
    yield bytes;
  };
}
