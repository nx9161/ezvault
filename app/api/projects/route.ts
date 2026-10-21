// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, pagination, nextCursor, HttpError } from '@/lib/api/route-utils';
import { sql, tx } from '@/lib/db/index';
import { idempotentCreate, readStashedResult, resolveClientOpId } from '@/lib/api/idempotency';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

export const GET = handle(async (req: Request) => {
  // Wave D (row 36): developer API tokens honored on this route ('read').
  const { enforceTokenScope } = await import('@/lib/token-auth');
  await enforceTokenScope(req, 'read');
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

  // A4: claim-first idempotency via the canonical helper (replaces the old
  // check-then-act replay lookup, which raced under concurrent retries).
  const opId = resolveClientOpId(req, body);
  const id = randomUUID();
  const { result, replayed, clientOpId } = await idempotentCreate({
    projectId: id,
    opId,
    kind: 'project.create',
    payload: { name: name.slice(0, 200) },
    create: async () => {
      const rows = await tx((q) => [
        q(`INSERT INTO projects (id, name, duplicate_policy, notes_export_format)
           VALUES ($1,$2,$3,$4) RETURNING *`,
          [id, name.slice(0, 200), body.duplicate_policy ?? 'skip', body.notes_export_format ?? 'html']),
        q(`INSERT INTO storage_counters (project_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]),
      ]);
      const project = (rows[0] as unknown[])[0] as Record<string, unknown>;
      return { project, project_id: id };
    },
    findPrior: async () => {
      const stashed = await readStashedResult<{ project_id: string }>(opId!);
      if (!stashed?.project_id) return null;
      const rows = await sql()`SELECT * FROM projects WHERE id = ${stashed.project_id}`;
      return rows.length ? { project: rows[0], project_id: stashed.project_id } : null;
    },
  });
  if (replayed) {
    if (!result) {
      return ok({ replayed: true, clientOpId,
        note: 'first attempt did not complete; retry with a fresh clientOpId' });
    }
    const p = result.project as { rev: number };
    return ok({ ...result.project, replayed: true, rev: Number(p.rev), clientOpId });
  }
  return ok({ ...result!.project, ...(clientOpId ? { clientOpId } : {}) }, 201);
});
