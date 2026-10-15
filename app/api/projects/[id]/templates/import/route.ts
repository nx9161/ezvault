// SPDX-License-Identifier: MIT
import { handle, ok, parseCappedJson, requireProject, HttpError, apiError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { randomUUID } from 'node:crypto';
import type { TtpDocument } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

function validateTtp(doc: unknown): TtpDocument {
  if (!doc || typeof doc !== 'object') throw new HttpError(400, 'validation', '.ttp must be a JSON object');
  const d = doc as Record<string, unknown>;
  const name = String(d['name'] ?? '').trim();
  if (!name) throw new HttpError(400, 'validation', '.ttp name is required');
  if (!Array.isArray(d['fields'])) throw new HttpError(400, 'validation', '.ttp fields must be an array');
  const seen = new Set<string>();
  const fields = (d['fields'] as unknown[]).map((f, i) => {
    if (!f || typeof f !== 'object') throw new HttpError(400, 'validation', `.ttp fields[${i}] must be an object`);
    const o = f as Record<string, unknown>;
    const property_uri = String(o['property_uri'] ?? '').trim();
    const label = String(o['label'] ?? '').trim();
    if (!property_uri || !label) throw new HttpError(400, 'validation', `.ttp fields[${i}] needs property_uri + label`);
    if (seen.has(property_uri)) throw new HttpError(400, 'validation', `duplicate property_uri: ${property_uri}`);
    seen.add(property_uri);
    return { property_uri, label: label.slice(0, 200), order: i };
  });
  return {
    name: name.slice(0, 200),
    ...(typeof d['uri'] === 'string' && d['uri'].trim() ? { uri: d['uri'].trim() } : {}),
    ...(d['label_i18n'] && typeof d['label_i18n'] === 'object' ? { label_i18n: d['label_i18n'] as Record<string, string> } : {}),
    fields,
  };
}

/** Import a .ttp template document (project-scoped). B11-capped parse. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const doc = await parseCappedJson(req);
  const ttp = validateTtp(doc);
  const templateId = randomUUID();
  const qq = (text: string, params?: unknown[]) => ({ text, params });
  try {
    await tx(() => [
      qq(`INSERT INTO templates (id, project_id, name, uri, label_i18n, fields)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
        [templateId, id, ttp.name, ttp.uri ?? null, JSON.stringify(ttp.label_i18n ?? {}), JSON.stringify(ttp.fields)]),
      bumpRevQuery(id),
    ]);
  } catch (err) {
    if (String(err).includes('duplicate key')) {
      return apiError('conflict', 'a template with this name already exists in the project', 409);
    }
    throw err;
  }
  const rows = await sql()`SELECT * FROM templates WHERE id = ${templateId}`;
  return ok(rows[0], 201);
});
