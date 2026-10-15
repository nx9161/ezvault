// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, pagination, nextCursor, HttpError } from '@/lib/api/route-utils.js';
import { sql, tx } from '@/lib/db/index.js';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const { limit, offset } = pagination(url);
  const rows = await sql()`SELECT * FROM projects ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  const total = await sql()`SELECT COUNT(*)::int AS c FROM projects`;
  return ok({
    items: rows,
    total: (total[0] as { c: number }).c,
    ...(nextCursor(offset, limit, rows.length) ? { nextCursor: nextCursor(offset, limit, rows.length) } : {}),
  });
});

export const POST = handle(async (req: Request) => {
  const body = await parseJson<{
    name?: string; duplicate_policy?: string; notes_export_format?: string; clientOpId?: string;
  }>(req);
  const name = (body.name ?? '').trim();
  if (!name) throw new HttpError(400, 'validation', 'name is required');
  if (body.duplicate_policy && !['skip', 'keep_both', 'ask'].includes(body.duplicate_policy)) {
    throw new HttpError(400, 'validation', 'invalid duplicate_policy');
  }
  if (body.notes_export_format && !['html', 'markdown'].includes(body.notes_export_format)) {
    throw new HttpError(400, 'validation', 'invalid notes_export_format');
  }

  // Idempotent replay: an op_id already claimed returns the original project.
  const opId = body.clientOpId;
  if (opId) {
    const prior = await sql()`SELECT p.* FROM projects p
      JOIN command_log c ON c.project_id = p.id WHERE c.op_id = ${opId} LIMIT 1`;
    if (prior.length) {
      const p = prior[0] as { rev: number };
      return ok({ ...prior[0], replayed: true, rev: Number(p.rev), clientOpId: opId });
    }
  }

  const id = randomUUID();
  const rows = await tx((q) => [
    q(`INSERT INTO projects (id, name, duplicate_policy, notes_export_format)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [id, name.slice(0, 200), body.duplicate_policy ?? 'skip', body.notes_export_format ?? 'html']),
    q(`INSERT INTO storage_counters (project_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]),
    ...(opId
      ? [q(`INSERT INTO command_log (project_id, op_id, kind, payload) VALUES ($1,$2,'project.create',$3::jsonb)
            ON CONFLICT (op_id) DO NOTHING`, [id, opId, JSON.stringify(body)])]
      : []),
  ]);
  const project = (rows[0] as unknown[])[0] as Record<string, unknown>;
  return ok({ ...project, ...(opId ? { clientOpId: opId } : {}) }, 201);
});
