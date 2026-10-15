// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; subjectId: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id, subjectId } = await ctx.params;
  await requireProject(id);
  const s = await sql()`SELECT id FROM subjects WHERE id = ${subjectId} AND project_id = ${id}`;
  if (!s.length) throw new HttpError(404, 'not_found', 'subject not found');
  const rows = await sql()`SELECT m.id, m.property_uri, m.language, m.created_at,
      v.value_id, v.datatype, v.text, v.data
    FROM metadata m JOIN metadata_values v ON v.value_id = m.value_id
    WHERE m.subject_id = ${subjectId} ORDER BY m.created_at`;
  return ok({ values: rows });
});

/**
 * Set metadata values — immutable-value semantics: every set creates NEW
 * metadata_values rows (the DB trigger forbids UPDATE of values).
 * With replace=true, existing values for the listed property_uris are
 * removed first (the VALUE rows stay — immutable — only the links go).
 */
export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const { id, subjectId } = await ctx.params;
  await requireProject(id);
  const s = await sql()`SELECT id FROM subjects WHERE id = ${subjectId} AND project_id = ${id}`;
  if (!s.length) throw new HttpError(404, 'not_found', 'subject not found');
  const body = await parseJson<{
    values?: { property_uri?: string; datatype?: string; text?: string; data?: Record<string, unknown> | null; language?: string | null }[];
    replace?: boolean; clientOpId?: string;
  }>(req);
  const values = body.values ?? [];
  if (!values.length) throw new HttpError(400, 'validation', 'values is required');

  for (const [i, v] of values.entries()) {
    if (!v.property_uri?.trim()) throw new HttpError(400, 'validation', `values[${i}].property_uri is required`);
    if (typeof v.text !== 'string') throw new HttpError(400, 'validation', `values[${i}].text must be a string`);
  }

  const qq = (text: string, params?: unknown[]) => ({ text, params });
  await tx(() => {
    const queries = [];
    if (body.replace) {
      const uris = [...new Set(values.map((v) => v.property_uri!.trim()))];
      queries.push(qq(`DELETE FROM metadata WHERE subject_id = $1 AND property_uri = ANY($2)`, [subjectId, uris]));
    }
    for (const v of values) {
      const valueId = randomUUID();
      queries.push(qq(`INSERT INTO metadata_values (value_id, datatype, text, data) VALUES ($1,$2,$3,$4::jsonb)`,
        [valueId, v.datatype?.trim() || 'http://www.w3.org/2001/XMLSchema#string',
          v.text!.slice(0, 100000), v.data ? JSON.stringify(v.data) : null]));
      queries.push(qq(`INSERT INTO metadata (subject_id, property_uri, value_id, language) VALUES ($1,$2,$3,$4)`,
        [subjectId, v.property_uri!.trim(), valueId, v.language ?? null]));
    }
    queries.push(bumpRevQuery(id));
    if (body.clientOpId) {
      queries.push(qq(`INSERT INTO command_log (project_id, op_id, kind, payload) VALUES ($1,$2,'metadata.set',$3::jsonb)
        ON CONFLICT (op_id) DO NOTHING`, [id, body.clientOpId, JSON.stringify({ subject_id: subjectId })]));
    }
    return queries;
  });
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
  return ok({ subject_id: subjectId, rev: Number(rev[0]['rev']) });
});
