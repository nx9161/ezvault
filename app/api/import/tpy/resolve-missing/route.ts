// SPDX-License-Identifier: MIT
import { handle, ok, parseCappedJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { processPhoto, verifyStagedSha256, sha256OfStaged } from '@/lib/import/process-photo';
import { matchRelinkFiles, normalizeSha256, type RelinkFileInput, type MissingOriginalRow } from '@/lib/import/relink-wire';
import { requireRateLimit } from '@/lib/ratelimit';
import { checkCpuGuard } from '@/lib/cpu-budget';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface ExplicitLink {
  photo_subject_id?: string;
  staged_key?: string;
  skip?: boolean;
}

interface ResolveMissingBody {
  job_id?: string;
  project_id?: string;
  /** Path A — explicit links (client already matched). Backward compatible. */
  resolutions?: ExplicitLink[];
  /** Compat alias: the shipped wizard posts `links`. */
  links?: { photo_subject_id?: string; staged_key?: string }[];
  /** Path B — server-side matching (W2-D): checksum first, filename fallback. */
  files?: RelinkFileInput[];
}

/**
 * POST /api/import/tpy/resolve-missing — re-link photos whose originals
 * were missing. Full contract: lib/import/relink-wire.ts (W2-D SERVER
 * CONTRACT block — the frontend builder's reference).
 *
 * Path A (resolutions/links): explicit photo_subject_id → staged_key links.
 *   The server streams-hashes the staged bytes itself (no client claim in
 *   this path) and records the real digest. With skip: true the photo stays
 *   missing (re-link later via /import/complete + /process against the new
 *   photo row — original row keeps missing_original).
 * Path B (files): per-file { staged_key, filename, sha256, mimetype? }.
 *   sha256 must be a real 64-hex digest — presign already rejects the old
 *   `sha256: "relink"` placeholder, so that path is replaced, not kept.
 *   Each staged file is integrity-verified (422 checksum_mismatch) and
 *   matched checksum-first, filename-fallback via matchRelinkFiles.
 *
 * On every successful link the photo row is finalized:
 *   missing_original=false, checksum_sha256=<verified digest>.
 * (Pre-W2-D the flag was never cleared, so relinked photos stayed missing.)
 *
 * Response is backward compatible: { job_id, results } keeps its shape;
 * `matched` and `still_missing` are additive.
 */
export const POST = handle(async (req: Request) => {
  await requireRateLimit('import:tpy:resolve-missing');
  await checkCpuGuard();
  const body = await parseCappedJson<ResolveMissingBody>(req);
  if (!body.job_id) throw new HttpError(400, 'validation', 'job_id is required');
  if (!body.project_id) throw new HttpError(400, 'validation', 'project_id is required');
  await requireProject(body.project_id);
  const jobRows = await sql()`SELECT id FROM import_jobs
    WHERE id = ${body.job_id} AND project_id = ${body.project_id} AND kind = 'tpy'`;
  if (!jobRows.length) throw new HttpError(404, 'not_found', 'tpy import job not found');

  const resolutions: ExplicitLink[] = [
    ...(body.resolutions ?? []),
    ...(body.links ?? []).map((l) => ({ photo_subject_id: l.photo_subject_id, staged_key: l.staged_key })),
  ];
  const files = body.files ?? [];
  if (!resolutions.length && !files.length) {
    throw new HttpError(400, 'validation', 'resolutions[] or files[] is required');
  }
  const prefix = `uploads/${body.job_id}/`;
  const badKey = (k: unknown): boolean =>
    typeof k !== 'string' || !k.startsWith(prefix) || k.includes('..');

  // The missing-original pool (project-scoped, single-user). Carries the
  // recorded checksums for the checksum leg plus filenames for the fallback.
  const missingRows = await sql()`SELECT p.subject_id AS photo_subject_id,
      p.original_filename AS filename, p.checksum_sha256, p.tpy_checksum_md5,
      p.mimetype AS row_mimetype, p.item_id AS row_item_id
    FROM photos p JOIN subjects s ON s.id = p.subject_id
    WHERE s.project_id = ${body.project_id} AND p.missing_original = true`;
  const missingById = new Map<string, MissingOriginalRow & { row_mimetype: string; row_item_id: string }>();
  for (const r of missingRows) {
    missingById.set(r['photo_subject_id'] as string, {
      photo_subject_id: r['photo_subject_id'] as string,
      filename: r['filename'] as string,
      checksum_sha256: r['checksum_sha256'] as string | null,
      tpy_checksum_md5: r['tpy_checksum_md5'] as string | null,
      row_mimetype: r['row_mimetype'] as string,
      row_item_id: r['row_item_id'] as string,
    });
  }

  const results: { photo_subject_id: string; status: string }[] = [];
  const relinkedIds = new Set<string>();

  /** Finalize one linked photo: run the pipeline, then clear the flag + record the digest. */
  async function linkPhoto(args: {
    photoSubjectId: string; stagedKey: string; sha256: string;
    filename: string; mimetype: string; itemId: string; updateName: boolean;
  }): Promise<void> {
    await processPhoto({
      jobId: body.job_id!,
      projectId: body.project_id!,
      photoSubjectId: args.photoSubjectId,
      itemId: args.itemId,
      originalFilename: args.filename,
      mimetype: args.mimetype,
      checksumSha256: args.sha256,
      stagedKey: args.stagedKey,
    });
    if (args.updateName) {
      await sql()`UPDATE photos SET missing_original = false, checksum_sha256 = ${args.sha256},
        original_filename = ${args.filename.slice(0, 255)}, mimetype = ${args.mimetype}
        WHERE subject_id = ${args.photoSubjectId}`;
    } else {
      await sql()`UPDATE photos SET missing_original = false, checksum_sha256 = ${args.sha256}
        WHERE subject_id = ${args.photoSubjectId}`;
    }
    relinkedIds.add(args.photoSubjectId);
  }

  const pushFailed = (id: string, err: unknown) => {
    if (err instanceof HttpError) {
      results.push({
        photo_subject_id: id,
        status: err.code === 'checksum_mismatch' ? 'checksum_mismatch' : `failed:${err.code}`,
      });
    } else {
      results.push({ photo_subject_id: id, status: 'failed' });
    }
  };

  // ---- Path A: explicit links (backward compatible) ----
  for (const r of resolutions) {
    if (!r.photo_subject_id) { results.push({ photo_subject_id: '', status: 'invalid' }); continue; }
    const row = missingById.get(r.photo_subject_id);
    if (!row) { results.push({ photo_subject_id: r.photo_subject_id, status: 'not_found' }); continue; }
    if (r.skip) { results.push({ photo_subject_id: r.photo_subject_id, status: 'skipped' }); continue; }
    if (badKey(r.staged_key)) { results.push({ photo_subject_id: r.photo_subject_id, status: 'invalid_key' }); continue; }
    try {
      // No client claim in this path — the server hashes the staged bytes.
      const sha256 = await sha256OfStaged(r.staged_key!);
      await linkPhoto({
        photoSubjectId: r.photo_subject_id,
        stagedKey: r.staged_key!,
        sha256,
        filename: row.filename,
        mimetype: row.row_mimetype,
        itemId: row.row_item_id,
        updateName: false,
      });
      results.push({ photo_subject_id: r.photo_subject_id, status: 'relinked' });
    } catch (err) {
      pushFailed(r.photo_subject_id, err);
    }
  }

  // ---- Path B: server-side matching (W2-D) ----
  if (files.length) {
    const pool: MissingOriginalRow[] = [...missingById.values()]
      .filter((m) => !relinkedIds.has(m.photo_subject_id));
    const plan = matchRelinkFiles(files, pool);
    const matchByFile = new Map(plan.matches.map((m) => [m.file_index, m]));
    for (const [i, f] of files.entries()) {
      const match = matchByFile.get(i);
      if (!match) { results.push({ photo_subject_id: '', status: 'no_match' }); continue; }
      const row = missingById.get(match.photo_subject_id)!;
      if (badKey(f.staged_key)) { results.push({ photo_subject_id: match.photo_subject_id, status: 'invalid_key' }); continue; }
      const claimed = normalizeSha256(f.sha256);
      if (!claimed) { results.push({ photo_subject_id: match.photo_subject_id, status: 'invalid_sha256' }); continue; }
      try {
        // Integrity first: staged bytes must equal the client claim.
        await verifyStagedSha256(f.staged_key!, claimed);
        const filename = (f.filename?.trim() || row.filename).slice(0, 255);
        await linkPhoto({
          photoSubjectId: match.photo_subject_id,
          stagedKey: f.staged_key!,
          sha256: claimed,
          filename,
          mimetype: f.mimetype?.trim() || row.row_mimetype,
          itemId: row.row_item_id,
          updateName: true,
        });
        results.push({ photo_subject_id: match.photo_subject_id, status: 'relinked' });
      } catch (err) {
        pushFailed(match.photo_subject_id, err);
      }
    }
  }

  const still_missing = [...missingById.values()]
    .filter((m) => !relinkedIds.has(m.photo_subject_id))
    .map((m) => ({ filename: m.filename, photo_subject_id: m.photo_subject_id }));
  const matched = results.filter((r) => r.status === 'relinked').length;
  return ok({ job_id: body.job_id, results, matched, still_missing });
});
