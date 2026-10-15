// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, pagination, nextCursor, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { idempotentCreate, readStashedResult, resolveClientOpId } from '@/lib/api/idempotency';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; photoId: string }> };

async function selectionJson(projectId: string, selectionId: string) {
  const rows = await sql()`SELECT s.id AS subject_id, s.project_id, s.template_id,
      sel.photo_id, sel.name, sel.x, sel.y, sel.width, sel.height, sel.position,
      (SELECT COUNT(*)::int FROM notes n WHERE n.subject_id = sel.subject_id AND n.deleted_at IS NULL) AS note_count
    FROM selections sel JOIN subjects s ON s.id = sel.subject_id
    WHERE s.project_id = ${projectId} AND sel.subject_id = ${selectionId}`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'selection not found');
  const r = rows[0];
  return {
    subject_id: r['subject_id'], project_id: r['project_id'], kind: 'selection',
    photo_id: r['photo_id'], name: r['name'],
    x: Number(r['x']), y: Number(r['y']), width: Number(r['width']), height: Number(r['height']),
    position: Number(r['position']), template_id: r['template_id'],
    note_count: Number(r['note_count'] ?? 0),
  };
}

export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id, photoId } = await ctx.params;
  await requireProject(id);
  const url = new URL(req.url);
  const { limit, offset } = pagination(url);
  const rows = await sql()`SELECT sel.subject_id FROM selections sel JOIN subjects s ON s.id = sel.subject_id
    WHERE s.project_id = ${id} AND sel.photo_id = ${photoId} ORDER BY sel.position LIMIT ${limit} OFFSET ${offset}`;
  const total = await sql()`SELECT COUNT(*)::int AS c FROM selections sel JOIN subjects s ON s.id = sel.subject_id
    WHERE s.project_id = ${id} AND sel.photo_id = ${photoId}`;
  const items = [];
  for (const r of rows) items.push(await selectionJson(id, r['subject_id'] as string));
  return ok({
    items, total: (total[0]['c'] as number),
    ...(nextCursor(offset, limit, rows.length) ? { nextCursor: nextCursor(offset, limit, rows.length) } : {}),
  });
});

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id, photoId } = await ctx.params;
  await requireProject(id);
  const photo = await sql()`SELECT p.width, p.height FROM photos p JOIN subjects s ON s.id = p.subject_id
    WHERE s.project_id = ${id} AND p.subject_id = ${photoId}`;
  if (!photo.length) throw new HttpError(404, 'not_found', 'photo not found');
  const body = await parseJson<{
    name?: string; x?: number; y?: number; width?: number; height?: number;
    position?: number; template_id?: string | null; clientOpId?: string;
  }>(req);

  for (const f of ['x', 'y', 'width', 'height'] as const) {
    const v = body[f];
    if (v === undefined || typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new HttpError(400, 'validation', `${f} is required and must be a non-negative number`);
    }
  }
  if (body.width === 0 || body.height === 0) throw new HttpError(400, 'validation', 'width/height must be positive');
  if (body.template_id) {
    const t = await sql()`SELECT id FROM templates WHERE id = ${body.template_id} AND project_id = ${id}`;
    if (!t.length) throw new HttpError(400, 'validation', 'template not found in this project');
  }

  // A4: claim-first idempotency — a retried request returns the original
  // selection instead of drawing a duplicate.
  const opId = resolveClientOpId(req, body);
  const selId = randomUUID();
  const imageId = randomUUID();
  const qq = (text: string, params?: unknown[]) => ({ text, params });
  const { result, replayed, clientOpId } = await idempotentCreate({
    projectId: id,
    opId,
    kind: 'selection.create',
    payload: { photo_id: photoId, x: body.x, y: body.y, width: body.width, height: body.height },
    create: async () => {
      await tx(() => [
        qq(`INSERT INTO subjects (id, project_id, kind, template_id) VALUES ($1,$2,'selection',$3)`,
          [selId, id, body.template_id ?? null]),
        qq(`INSERT INTO images (id, width, height) VALUES ($1,$2,$3)`,
          [imageId, Math.round(body.width!), Math.round(body.height!)]),
        qq(`INSERT INTO selections (subject_id, photo_id, name, x, y, width, height, position)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [selId, photoId, (body.name ?? 'Selection').slice(0, 200),
            Math.round(body.x!), Math.round(body.y!), Math.round(body.width!), Math.round(body.height!),
            body.position ?? 0]),
        bumpRevQuery(id),
      ]);
      return { selection_id: selId };
    },
    findPrior: async () => {
      const stashed = await readStashedResult<{ selection_id: string }>(opId!);
      return stashed?.selection_id ? { selection_id: stashed.selection_id } : null;
    },
  });
  if (replayed) {
    const prior = result?.selection_id ? await selectionJson(id, result.selection_id).catch(() => null) : null;
    return ok({ ...(prior ?? {}), replayed: true, clientOpId });
  }
  return ok({ ...(await selectionJson(id, selId)), ...(clientOpId ? { clientOpId } : {}) }, 201);
});
