// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { sanitizeTiptapDoc } from '@/lib/notes/sanitize';
import { tiptapToText } from '@/lib/export/jsonld.js';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; noteId: string }> };

export const GET = handle(async (req: Request, ctx: Ctx) => {
  // Wave D (row 36): developer API tokens honored on this route ('read').
  const { enforceTokenScope } = await import('@/lib/token-auth');
  await enforceTokenScope(req, 'read');
  const { id, noteId } = await ctx.params;
  await requireProject(id);
  const rows = await sql()`SELECT n.id, n.subject_id, n.text, n.state, n.language, n.created_at, n.updated_at
    FROM notes n JOIN subjects s ON s.id = n.subject_id
    WHERE s.project_id = ${id} AND n.id = ${noteId} AND n.deleted_at IS NULL`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'note not found');
  return ok(rows[0]);
});

/** Autosave target — PATCH with a new TipTap state (sanitized, B13). */
export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  // Wave D (row 36): tokens honored — note update needs 'notes:write'.
  const { enforceTokenScope } = await import('@/lib/token-auth');
  await enforceTokenScope(req, 'notes:write');
  const { id, noteId } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{ state?: unknown; text?: string; language?: string | null }>(req);
  const chk = await sql()`SELECT n.id FROM notes n JOIN subjects s ON s.id = n.subject_id
    WHERE s.project_id = ${id} AND n.id = ${noteId} AND n.deleted_at IS NULL`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'note not found');

  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [noteId];
  if (body.state !== undefined) {
    if (body.state === null || typeof body.state !== 'object') {
      throw new HttpError(400, 'validation', 'state must be TipTap JSON');
    }
    let sanitized: unknown;
    try {
      sanitized = sanitizeTiptapDoc(body.state).doc;
    } catch {
      throw new HttpError(400, 'validation', 'note state could not be sanitized');
    }
    params.push(JSON.stringify(sanitized));
    sets.push(`state = $${params.length}::jsonb`);
    params.push((typeof body.text === 'string' && body.text) || tiptapToText(sanitized));
    sets.push(`text = $${params.length}`);
  }
  if (body.language !== undefined) {
    params.push(body.language);
    sets.push(`language = $${params.length}`);
  }
  await tx((q) => [
    q(`UPDATE notes SET ${sets.join(', ')} WHERE id = $1`, params),
    bumpRevQuery(id),
  ]);
  const rows = await sql()`SELECT n.id, n.subject_id, n.text, n.state, n.language, n.created_at, n.updated_at
    FROM notes n WHERE n.id = ${noteId}`;
  return ok(rows[0]);
});

/** Soft-delete a note (trash semantics: deleted_at; restorable via subject restore). */
export const DELETE = handle(async (req: Request, ctx: Ctx) => {
  // Wave D (row 36): deletion is OUTSIDE the token scopes (create/update
  // only) — a presented token is denied rather than silently honored.
  const { enforceTokenScope } = await import('@/lib/token-auth');
  const token = await enforceTokenScope(req, 'notes:write');
  if (token) throw new HttpError(403, 'forbidden', 'API tokens may not delete notes');
  const { id, noteId } = await ctx.params;
  await requireProject(id);
  const chk = await sql()`SELECT n.id, n.subject_id FROM notes n JOIN subjects s ON s.id = n.subject_id
    WHERE s.project_id = ${id} AND n.id = ${noteId} AND n.deleted_at IS NULL`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'note not found');
  // Trashing the note's subject would trash the photo — notes get
  // soft-delete only; the subject trash route handles subject-level trash.
  await tx((q) => [
    q(`UPDATE notes SET deleted_at = now() WHERE id = $1`, [noteId]),
    bumpRevQuery(id),
  ]);
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
  return ok({ deleted: noteId, rev: Number(rev[0]['rev']) });
});
