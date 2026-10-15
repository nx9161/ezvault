// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** Bulk metadata edit — one undo step (single txn + single rev bump). */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{
    subject_ids?: string[];
    values?: { property_uri?: string; datatype?: string; text?: string; data?: Record<string, unknown> | null; language?: string | null }[];
    replace?: boolean; clientOpId?: string;
  }>(req);
  const subjectIds = [...new Set(body.subject_ids ?? [])];
  const values = body.values ?? [];
  if (!subjectIds.length) throw new HttpError(400, 'validation', 'subject_ids is required');
  if (!values.length) throw new HttpError(400, 'validation', 'values is required');

  const found = await sql()`SELECT id FROM subjects WHERE project_id = ${id} AND id = ANY(${subjectIds})`;
  if (found.length !== subjectIds.length) throw new HttpError(404, 'not_found', 'one or more subjects not found');
  for (const [i, v] of values.entries()) {
    if (!v.property_uri?.trim()) throw new HttpError(400, 'validation', `values[${i}].property_uri is required`);
    if (typeof v.text !== 'string') throw new HttpError(400, 'validation', `values[${i}].text must be a string`);
  }

  const qq = (text: string, params?: unknown[]) => ({ text, params });
  await tx(() => {
    const queries = [];
    for (const subjectId of subjectIds) {
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
    }
    queries.push(bumpRevQuery(id));
    if (body.clientOpId) {
      queries.push(qq(`INSERT INTO command_log (project_id, op_id, kind, payload) VALUES ($1,$2,'metadata.bulk',$3::jsonb)
        ON CONFLICT (op_id) DO NOTHING`, [id, body.clientOpId, JSON.stringify({ subject_ids: subjectIds })]));
    }
    return queries;
  });
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
  return ok({ updated: subjectIds.length, rev: Number(rev[0]['rev']) });
});
