// SPDX-License-Identifier: MIT
/**
 * lib/import/relink-wire.ts — .tpy relink MATCHING (pure module: no
 * `server-only`, no DB imports — safe to unit-test and to import anywhere
 * that needs the contract constants).
 *
 * =====================================================================
 * W2-D SERVER CONTRACT — .tpy relink checksum matching (for the frontend builder)
 * =====================================================================
 *
 * POST /api/import/tpy/resolve-missing
 *
 * Request (job_id + project_id required; at least one of
 * `resolutions` / `links` / `files` must be non-empty):
 *   {
 *     job_id: string, project_id: string,
 *     // Path A — explicit links (client already matched; backward compatible).
 *     // `links` is accepted as an alias for `resolutions`.
 *     resolutions?: [{ photo_subject_id?: string, staged_key?: string, skip?: boolean }],
 *     links?:       [{ photo_subject_id?: string, staged_key?: string }],
 *     // Path B — server-side matching (NEW, W2-D). The client stages each
 *     // picked original via the normal presign flow with its REAL 64-hex
 *     // sha256 (presign hard-rejects anything else, so the old
 *     // `sha256: "relink"` placeholder cannot reach this route), then sends
 *     // one entry per staged file. The server matches each file to a missing
 *     // original: checksum first, filename fallback.
 *     files?: [{ staged_key?: string, filename?: string, sha256?: string, mimetype?: string }]
 *   }
 *
 * Matching order per file (matchRelinkFiles, pure — unit-tested):
 *   1. checksum — the client sha256 (must be 64 hex chars; anything else
 *      skips this leg, including the old "relink" placeholder) equals a
 *      missing original's recorded checksum_sha256 (case-insensitive;
 *      empty/absent recorded checksums never match).
 *   2. filename — basename of the uploaded filename equals the basename of
 *      the missing original's original_filename (case-insensitive).
 *   Each missing original is consumed at most once (first file wins, in
 *   request order). Every staged file is integrity-verified before linking:
 *   the staged bytes are streamed-hashed server-side and must equal the
 *   claimed sha256 (422 checksum_mismatch otherwise) — the server never
 *   writes a client-claimed checksum to the DB unverified. On success the
 *   photo row is updated: missing_original=false, checksum_sha256=<verified>,
 *   original_filename/mimetype=<uploaded truth> (Path B).
 *
 * Response:
 *   {
 *     job_id: string,
 *     results: [{ photo_subject_id: string, status: string }],
 *       // status: relinked | skipped | not_found | invalid | invalid_key |
 *       //         invalid_sha256 | checksum_mismatch | no_match |
 *       //         failed | failed:<code>
 *     matched: number,            // count of results with status 'relinked'
 *     still_missing: [{ filename: string, photo_subject_id: string }]
 *   }
 * `matched` / `still_missing` are additive — clients reading only `results`
 * are unaffected.
 */

export interface RelinkFileInput {
  staged_key?: string;
  filename?: string;
  sha256?: string;
  mimetype?: string;
}

export interface MissingOriginalRow {
  photo_subject_id: string;
  /** photos.original_filename as recorded at import. */
  filename: string;
  checksum_sha256: string | null;
  tpy_checksum_md5: string | null;
}

export type RelinkMatchMethod = 'checksum' | 'filename';

export interface RelinkMatch {
  /** Index into the files[] array. */
  file_index: number;
  photo_subject_id: string;
  method: RelinkMatchMethod;
}

export interface RelinkPlan {
  matches: RelinkMatch[];
  /** Indexes into files[] that matched nothing. */
  unmatched: number[];
  /** Missing originals not consumed by any match. */
  still_missing: { filename: string; photo_subject_id: string }[];
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/** Normalize a client sha256 claim; null when it is not a 64-hex digest. */
export function normalizeSha256(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const n = v.trim().toLowerCase();
  return SHA256_RE.test(n) ? n : null;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/**
 * Match uploaded files to missing originals: checksum first, filename
 * fallback. Pure — no I/O. Each missing original is consumed at most once;
 * ties resolve to the earliest missing row, files processed in order.
 */
export function matchRelinkFiles(
  files: RelinkFileInput[],
  missing: MissingOriginalRow[],
): RelinkPlan {
  const consumed = new Set<string>();
  const matchedFile = new Set<number>();
  const matches: RelinkMatch[] = [];

  const take = (fileIndex: number, m: MissingOriginalRow, method: RelinkMatchMethod) => {
    consumed.add(m.photo_subject_id);
    matchedFile.add(fileIndex);
    matches.push({ file_index: fileIndex, photo_subject_id: m.photo_subject_id, method });
  };

  // Pass 1 — checksum: only files with a real 64-hex claim, only missing
  // originals that actually recorded a checksum ('' / null never match).
  files.forEach((f, i) => {
    const h = normalizeSha256(f.sha256);
    if (!h) return;
    const m = missing.find(
      (c) =>
        !consumed.has(c.photo_subject_id) &&
        typeof c.checksum_sha256 === 'string' &&
        c.checksum_sha256.trim().toLowerCase() === h,
    );
    if (m) take(i, m, 'checksum');
  });

  // Pass 2 — filename fallback (case-insensitive basename compare).
  files.forEach((f, i) => {
    if (matchedFile.has(i)) return;
    const name = baseName(String(f.filename ?? '')).toLowerCase();
    if (!name) return;
    const m = missing.find(
      (c) =>
        !consumed.has(c.photo_subject_id) &&
        baseName(String(c.filename ?? '')).toLowerCase() === name,
    );
    if (m) take(i, m, 'filename');
  });

  const unmatched = files.map((_, i) => i).filter((i) => !matchedFile.has(i));
  const still_missing = missing
    .filter((m) => !consumed.has(m.photo_subject_id))
    .map((m) => ({ filename: m.filename, photo_subject_id: m.photo_subject_id }));
  return { matches, unmatched, still_missing };
}
