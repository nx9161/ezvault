// SPDX-License-Identifier: MIT
import { handle, ok, parseCappedJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { getStorageDriver } from '@/lib/storage/driver';
import { magicMatchesMimetype, detectFromBytes } from '@/lib/import/magic';
import { isAllowedUploadMimetype, MAX_PHOTO_BYTES, MAGIC_PROBE_BYTES } from '@/lib/import/validation';
import { verifyStagedSha256 } from '@/lib/import/process-photo';
import { createPhotoRows, type PhotoEntry } from '@/lib/import/photos';
import { requireRateLimit } from '@/lib/ratelimit';
import type { ImportCompletePhoto } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/import/complete — client confirms bytes landed.
 *
 * Per staged key (all-or-nothing per FILE, not per batch):
 *   1. HeadObject size (B4: 413 on >200MB — staged object deleted).
 *   2. Magic-byte verify of the first 16KB (B1: 422 + delete staged on
 *      mismatch — claimed Content-Type must be on the allowlist AND match).
 *   3. Streaming full-file SHA-256 vs the client claim (B18: 422 + delete
 *      on mismatch; constant-memory streaming).
 *   4. Dual-checksum dedupe (sha256, then .tpy md5 if present; policy
 *      skip/keep_both/ask) -> one subject item + photo + images rows each.
 */
export const POST = handle(async (req: Request) => {
  await requireRateLimit('import:complete');
  const body = await parseCappedJson<{
    job_id?: string; project_id?: string;
    files?: { key?: string; sha256?: string; filename?: string }[]; keys?: string[];
    conversions?: { key?: string; conversion_of?: string }[];
    exif?: Record<string, Record<string, unknown>>;
    duplicate_policy?: 'skip' | 'keep_both' | 'ask';
    clientOpId?: string;
  }>(req);

  if (!body.job_id) throw new HttpError(400, 'validation', 'job_id is required');
  if (!body.project_id) throw new HttpError(400, 'validation', 'project_id is required');
  await requireProject(body.project_id);
  const jobRows = await sql()`SELECT id, project_id, kind FROM import_jobs
    WHERE id = ${body.job_id} AND project_id = ${body.project_id}`;
  if (!jobRows.length) throw new HttpError(404, 'not_found', 'import job not found');
  const kind = jobRows[0]['kind'] as string;
  if (kind !== 'upload' && kind !== 'folder') {
    throw new HttpError(400, 'validation', 'job is not an upload job');
  }

  const files = body.files?.length
    ? body.files
    : (body.keys ?? []).map((key) => ({ key, sha256: '', filename: key.split('/').pop() }));
  if (!files.length) throw new HttpError(400, 'validation', 'files[] (or keys[]) is required');

  const jobPrefix = `uploads/${body.job_id}/`;
  const policy = body.duplicate_policy ?? 'skip';
  const storage = await getStorageDriver();

  // Conversion artifacts: artifact staged key -> original staged key.
  const conversions: Record<string, string> = {};
  for (const c of body.conversions ?? []) {
    if (c.key?.startsWith(jobPrefix) && c.conversion_of?.startsWith(jobPrefix)) {
      conversions[c.conversion_of] = c.key;
    }
  }

  const entries: PhotoEntry[] = [];
  const acceptedKeys: string[] = [];
  const rejected: { key: string; reason: string }[] = [];

  for (const f of files) {
    const key = f.key ?? '';
    const reject = async (reason: string, code: 413 | 422, deleteStaged: boolean) => {
      if (deleteStaged) await storage.delete(key).catch(() => {});
      rejected.push({ key, reason: `${code}:${reason}` });
    };

    // Keys are server-minted and job-prefix-constrained — never client-chosen.
    if (!key.startsWith(jobPrefix) || key.includes('..') || key !== encodeURI(decodeURI(key))) {
      await reject('key not in this job staging prefix', 422, false);
      continue;
    }
    const head = await storage.head(key);
    if (!head) {
      await reject('staged upload not found (PUT it first — the grant may have expired)', 422, false);
      continue;
    }
    // B4: byte cap via HeadObject.
    if (head.size > MAX_PHOTO_BYTES) {
      await reject(`exceeds the ${MAX_PHOTO_BYTES}-byte per-photo cap`, 413, true);
      continue;
    }
    if (!head.contentType || !isAllowedUploadMimetype(head.contentType)) {
      await reject('staged Content-Type is not on the v1 allowlist', 422, true);
      continue;
    }
    // B1: magic-byte verify against the allowlist — the signature that
    // governs is the BYTES, not the metadata.
    const probe = await storage.getRange(key, 0, Math.min(MAGIC_PROBE_BYTES, head.size) - 1);
    const detected = detectFromBytes(probe);
    if (!detected || !magicMatchesMimetype(detected, probe) || !isAllowedUploadMimetype(detected)) {
      await reject('magic_mismatch: bytes do not match an allowlisted image format', 422, true);
      continue;
    }
    // B18: streaming full-file SHA-256 verification (constant memory).
    const claimed = (f.sha256 ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(claimed)) {
      await reject('a 64-hex sha256 claim is required per file', 422, false);
      continue;
    }
    try {
      await verifyStagedSha256(key, claimed);
    } catch {
      await reject('checksum_mismatch: bytes do not match the client sha256', 422, true);
      continue;
    }
    entries.push({
      originalFilename: (f.filename ?? key.split('/').pop() ?? 'upload').slice(0, 500),
      mimetype: detected,
      checksumSha256: claimed,
      exif: body.exif?.[key],
    });
    acceptedKeys.push(key);
  }

  // Dual-checksum dedupe + one item/photo/images rows each (compound txn).
  const created = await createPhotoRows(body.project_id, body.job_id, entries, { duplicatePolicy: policy });

  const accepted: ImportCompletePhoto[] = [];
  for (let i = 0; i < acceptedKeys.length; i++) {
    const c = created[i];
    if (c.dedupe === 'skipped_duplicate') {
      rejected.push({ key: acceptedKeys[i], reason: 'duplicate_skipped' });
    } else {
      accepted.push({
        key: acceptedKeys[i],
        photo_subject_id: c.subjectId,
        item_id: c.itemId,
        dedupe: c.dedupe,
      });
    }
  }

  // Stash conversions + exif on the job for /process (checkpoint, not rows).
  await sql()`UPDATE import_jobs
    SET checkpoint = COALESCE(checkpoint,'{}'::jsonb)
        || ${JSON.stringify({ conversions, exif: body.exif ?? {} })}::jsonb,
        status = 'running', updated_at = now()
    WHERE id = ${body.job_id}`;

  const rev = await sql()`SELECT rev FROM projects WHERE id = ${body.project_id}`;
  return ok({
    job_id: body.job_id,
    accepted,
    rejected,
    rev: Number(rev[0]['rev']),
    ...(body.clientOpId ? { clientOpId: body.clientOpId } : {}),
  });
});
