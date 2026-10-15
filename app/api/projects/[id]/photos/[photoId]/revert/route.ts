// SPDX-License-Identifier: MIT
import { handle, ok, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { getPhotoJson } from '@/lib/api/shapes';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; photoId: string }> };

/** Revert to Original — reset all edit params to defaults. */
export const POST = handle(async (_req: Request, ctx: Ctx) => {
  const { id, photoId } = await ctx.params;
  await requireProject(id);
  const chk = await sql()`SELECT image_id FROM photos JOIN subjects s ON s.id = photos.subject_id
    WHERE photos.subject_id = ${photoId} AND s.project_id = ${id}`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'photo not found');
  const imageId = chk[0]['image_id'] as string;
  await tx((q) => [
    q(`UPDATE images SET angle = 0, mirror = false, brightness = 0, contrast = 0,
       hue = 0, saturation = 0, negative = false, sharpen = 0 WHERE id = $1`, [imageId]),
    bumpRevQuery(id),
  ]);
  return ok(await getPhotoJson(id, photoId));
});
