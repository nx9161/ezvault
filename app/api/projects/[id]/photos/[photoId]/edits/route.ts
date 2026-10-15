// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { getPhotoJson } from '@/lib/api/shapes';
import type { EditParams } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; photoId: string }> };

const RANGES: Record<keyof EditParams, [number, number]> = {
  angle: [0, 360],
  mirror: [0, 1],
  brightness: [-100, 100],
  contrast: [-100, 100],
  hue: [-180, 180],
  saturation: [-100, 100],
  negative: [0, 1],
  sharpen: [0, 100],
};

function validateEdits(e: EditParams): void {
  for (const [k, v] of Object.entries(e)) {
    const key = k as keyof EditParams;
    const range = RANGES[key];
    if (!range) throw new HttpError(400, 'validation', `unknown edit param: ${k}`);
    if (key === 'mirror' || key === 'negative') {
      if (typeof v !== 'boolean') throw new HttpError(400, 'validation', `${k} must be boolean`);
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new HttpError(400, 'validation', `${k} must be a number`);
    }
    if (v < range[0] || v > range[1]) {
      throw new HttpError(400, 'validation', `${k} out of range ${range[0]}..${range[1]}`);
    }
  }
}

/** Set non-destructive edit params (images row — Tropy-exact columns). */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id, photoId } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{ edits?: EditParams; clientOpId?: string }>(req);
  const edits = body.edits ?? {};
  validateEdits(edits);

  const chk = await sql()`SELECT image_id FROM photos JOIN subjects s ON s.id = photos.subject_id
    WHERE photos.subject_id = ${photoId} AND s.project_id = ${id}`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'photo not found');
  const imageId = chk[0]['image_id'] as string;

  const sets: string[] = [];
  const params: unknown[] = [imageId];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (edits.angle !== undefined) set('angle', edits.angle);
  if (edits.mirror !== undefined) set('mirror', edits.mirror);
  if (edits.brightness !== undefined) set('brightness', Math.round(edits.brightness));
  if (edits.contrast !== undefined) set('contrast', Math.round(edits.contrast));
  if (edits.hue !== undefined) set('hue', Math.round(edits.hue));
  if (edits.saturation !== undefined) set('saturation', Math.round(edits.saturation));
  if (edits.negative !== undefined) set('negative', edits.negative);
  if (edits.sharpen !== undefined) set('sharpen', Math.round(edits.sharpen));
  if (!sets.length) throw new HttpError(400, 'validation', 'no edit params provided');

  const qq = (text: string, p?: unknown[]) => ({ text, params: p });
  await tx(() => {
    const queries = [qq(`UPDATE images SET ${sets.join(', ')} WHERE id = $1`, params), bumpRevQuery(id)];
    if (body.clientOpId) {
      queries.push(qq(`INSERT INTO command_log (project_id, op_id, kind, payload) VALUES ($1,$2,'photo.edits',$3::jsonb)
        ON CONFLICT (op_id) DO NOTHING`, [id, body.clientOpId, JSON.stringify(body)]));
    }
    return queries;
  });
  return ok(await getPhotoJson(id, photoId));
});
