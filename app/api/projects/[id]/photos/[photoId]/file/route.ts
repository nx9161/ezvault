// SPDX-License-Identifier: MIT
import { handle, requireProject, HttpError, apiError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { getStorageDriver } from '@/lib/storage/driver';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; photoId: string }> };

/**
 * GET ?kind=original|thumb — 302 to a 5-min presigned R2 URL.
 *
 * B2: originals are served `attachment` (never render inline) with
 * ResponseContentType pinned to the DB-recorded allowlist mimetype (never
 * from object metadata). Thumbs stay inline image/webp.
 * B3: the 302 carries `Cache-Control: private, max-age=240` — never public
 * (the Location is a 5-minute bearer URL; shared caching would serve a dead
 * credential).
 */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id, photoId } = await ctx.params;
  await requireProject(id);
  const url = new URL(req.url);
  const kind = url.searchParams.get('kind') ?? 'thumb';
  if (kind !== 'original' && kind !== 'thumb') {
    return apiError('validation', 'kind must be original|thumb', 400);
  }

  const rows = await sql()`SELECT p.r2_key, p.thumb_r2_key, p.mimetype, p.original_filename, p.missing_original
    FROM photos p JOIN subjects s ON s.id = p.subject_id
    WHERE s.project_id = ${id} AND p.subject_id = ${photoId}`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'photo not found');
  const r = rows[0];
  const key = (kind === 'original' ? r['r2_key'] : r['thumb_r2_key']) as string | null;
  if (!key || (kind === 'original' && r['missing_original'])) {
    throw new HttpError(404, 'not_found', kind === 'original' ? 'original is missing (re-link required)' : 'thumbnail not ready');
  }
  if (key.includes(':')) {
    // Placeholder sentinel (tpy:pending / jsonld:pending) — not a real object.
    throw new HttpError(404, 'not_found', 'file not ready');
  }

  const storage = await getStorageDriver();
  const target = kind === 'original'
    ? await storage.presignGet(key, {
        disposition: 'attachment',
        contentType: r['mimetype'] as string,
        filename: r['original_filename'] as string,
      })
    : await storage.presignGet(key, { disposition: 'inline', contentType: 'image/webp' });

  return new Response(null, {
    status: 302,
    headers: {
      Location: target,
      // B3: private + short — the bearer URL dies in 5 minutes.
      'Cache-Control': 'private, max-age=240',
    },
  });
});
