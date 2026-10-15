// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; templateId: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id, templateId } = await ctx.params;
  await requireProject(id);
  const rows = await sql()`SELECT * FROM templates WHERE id = ${templateId} AND project_id = ${id}`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'template not found');
  return ok(rows[0]);
});

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const { id, templateId } = await ctx.params;
  await requireProject(id);
  const chk = await sql()`SELECT id FROM templates WHERE id = ${templateId} AND project_id = ${id}`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'template not found');
  const body = await parseJson<{
    name?: string; uri?: string | null; label_i18n?: Record<string, string>;
    fields?: { property_uri: string; label: string }[]; clientOpId?: string;
  }>(req);

  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [templateId];
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) throw new HttpError(400, 'validation', 'name must not be empty');
    params.push(name.slice(0, 200));
    sets.push(`name = $${params.length}`);
  }
  if (body.uri !== undefined) {
    params.push(body.uri?.trim() || null);
    sets.push(`uri = $${params.length}`);
  }
  if (body.label_i18n !== undefined) {
    params.push(JSON.stringify(body.label_i18n));
    sets.push(`label_i18n = $${params.length}::jsonb`);
  }
  if (body.fields !== undefined) {
    if (!Array.isArray(body.fields)) throw new HttpError(400, 'validation', 'fields must be an array');
    params.push(JSON.stringify(body.fields));
    sets.push(`fields = $${params.length}::jsonb`);
  }
  const qq = (text: string, p?: unknown[]) => ({ text, params: p });
  try {
    await tx(() => {
      const queries = [qq(`UPDATE templates SET ${sets.join(', ')} WHERE id = $1`, params), bumpRevQuery(id)];
      if (body.clientOpId) {
        queries.push(qq(`INSERT INTO command_log (project_id, op_id, kind, payload) VALUES ($1,$2,'template.update',$3::jsonb)
          ON CONFLICT (op_id) DO NOTHING`, [id, body.clientOpId, JSON.stringify({ template_id: templateId })]));
      }
      return queries;
    });
  } catch (err) {
    if (String(err).includes('duplicate key')) throw new HttpError(409, 'conflict', 'a template with this name already exists');
    throw err;
  }
  const rows = await sql()`SELECT * FROM templates WHERE id = ${templateId}`;
  return ok(rows[0]);
});

/** Delete is BLOCKED while any subject uses the template (§2.5). */
export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const { id, templateId } = await ctx.params;
  await requireProject(id);
  const chk = await sql()`SELECT id FROM templates WHERE id = ${templateId} AND project_id = ${id}`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'template not found');
  const inUse = await sql()`SELECT COUNT(*)::int AS c FROM subjects WHERE template_id = ${templateId}`;
  if ((inUse[0]['c'] as number) > 0) {
    throw new HttpError(409, 'in_use', `template is in use by ${inUse[0]['c']} subject(s) — reassign them first`);
  }
  const isDefault = await sql()`SELECT id FROM projects WHERE id = ${id} AND default_template_id = ${templateId}`;
  if (isDefault.length) throw new HttpError(409, 'in_use', 'template is the project default — change the default first');
  await tx((q) => [
    q(`DELETE FROM templates WHERE id = $1`, [templateId]),
    bumpRevQuery(id),
  ]);
  return ok({ deleted: templateId });
});
