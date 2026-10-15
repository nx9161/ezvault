// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, pagination, nextCursor, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { randomUUID } from 'node:crypto';
import type { TemplateField } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

function validateFields(fields: unknown): TemplateField[] {
  if (!Array.isArray(fields)) throw new HttpError(400, 'validation', 'fields must be an array');
  const seen = new Set<string>();
  return fields.map((f, i) => {
    if (!f || typeof f !== 'object') throw new HttpError(400, 'validation', `fields[${i}] must be an object`);
    const o = f as Record<string, unknown>;
    const property_uri = String(o['property_uri'] ?? '').trim();
    const label = String(o['label'] ?? '').trim();
    if (!property_uri) throw new HttpError(400, 'validation', `fields[${i}].property_uri is required`);
    if (!label) throw new HttpError(400, 'validation', `fields[${i}].label is required`);
    // One property per template max (§2.5).
    if (seen.has(property_uri)) throw new HttpError(400, 'validation', `duplicate property_uri: ${property_uri}`);
    seen.add(property_uri);
    return {
      property_uri,
      label: label.slice(0, 200),
      ...(o['label_i18n'] && typeof o['label_i18n'] === 'object' ? { label_i18n: o['label_i18n'] as Record<string, string> } : {}),
      ...(typeof o['datatype'] === 'string' ? { datatype: o['datatype'] } : {}),
      ...(typeof o['required'] === 'boolean' ? { required: o['required'] } : {}),
      order: typeof o['order'] === 'number' ? o['order'] : i,
    };
  });
}

export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const url = new URL(req.url);
  const { limit, offset } = pagination(url);
  const rows = await sql()`SELECT * FROM templates WHERE project_id = ${id} ORDER BY name LIMIT ${limit} OFFSET ${offset}`;
  const total = await sql()`SELECT COUNT(*)::int AS c FROM templates WHERE project_id = ${id}`;
  return ok({
    items: rows,
    total: (total[0]['c'] as number),
    ...(nextCursor(offset, limit, rows.length) ? { nextCursor: nextCursor(offset, limit, rows.length) } : {}),
  });
});

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{
    name?: string; uri?: string | null; label_i18n?: Record<string, string>;
    fields?: unknown; clientOpId?: string;
  }>(req);
  const name = (body.name ?? '').trim();
  if (!name) throw new HttpError(400, 'validation', 'name is required');
  const fields = validateFields(body.fields ?? []);

  const templateId = randomUUID();
  const qq = (text: string, params?: unknown[]) => ({ text, params });
  try {
    await tx(() => {
      const queries = [
        qq(`INSERT INTO templates (id, project_id, name, uri, label_i18n, fields)
            VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
          [templateId, id, name.slice(0, 200), body.uri?.trim() || null,
            JSON.stringify(body.label_i18n ?? {}), JSON.stringify(fields)]),
        bumpRevQuery(id),
      ];
      if (body.clientOpId) {
        queries.push(qq(`INSERT INTO command_log (project_id, op_id, kind, payload) VALUES ($1,$2,'template.create',$3::jsonb)
          ON CONFLICT (op_id) DO NOTHING`, [id, body.clientOpId, JSON.stringify({ name })]));
      }
      return queries;
    });
  } catch (err) {
    if (String(err).includes('duplicate key') || String(err).includes('templates_project_id_name_key')) {
      throw new HttpError(409, 'conflict', 'a template with this name already exists in the project');
    }
    throw err;
  }
  const rows = await sql()`SELECT * FROM templates WHERE id = ${templateId}`;
  return ok({ ...rows[0], ...(body.clientOpId ? { clientOpId: body.clientOpId } : {}) }, 201);
});
