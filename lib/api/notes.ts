// SPDX-License-Identifier: MIT
import 'server-only';
import { handle, ok, parseJson, pagination, nextCursor, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { sanitizeTiptapDoc } from '@/lib/notes/sanitize';
import { tiptapToText } from '@/lib/export/jsonld.js';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Shared note-list/create logic for photo + selection note routes. */
export async function listNotes(projectId: string, subjectId: string, url: URL) {
  const chk = await sql()`SELECT id FROM subjects WHERE id = ${subjectId} AND project_id = ${projectId}`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'subject not found');
  const { limit, offset } = pagination(url);
  const rows = await sql()`SELECT id, subject_id, text, state, language, created_at, updated_at
    FROM notes WHERE subject_id = ${subjectId} AND deleted_at IS NULL
    ORDER BY created_at LIMIT ${limit} OFFSET ${offset}`;
  const total = await sql()`SELECT COUNT(*)::int AS c FROM notes WHERE subject_id = ${subjectId} AND deleted_at IS NULL`;
  return ok({
    items: rows,
    total: (total[0]['c'] as number),
    ...(nextCursor(offset, limit, rows.length) ? { nextCursor: nextCursor(offset, limit, rows.length) } : {}),
  });
}

/**
 * Create a note. The TipTap JSON goes through the B13 sanitizer BEFORE
 * storage (link marks with disallowed protocols are stripped, text kept).
 */
export async function createNote(projectId: string, subjectId: string, req: Request) {
  const chk = await sql()`SELECT id FROM subjects WHERE id = ${subjectId} AND project_id = ${projectId}`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'subject not found');
  const body = await parseJson<{ state?: unknown; text?: string; language?: string | null; clientOpId?: string }>(req);
  if (body.state === undefined || body.state === null || typeof body.state !== 'object') {
    throw new HttpError(400, 'validation', 'state (TipTap JSON) is required');
  }
  let sanitized: unknown;
  let stripped = 0;
  try {
    const r = sanitizeTiptapDoc(body.state);
    sanitized = r.doc;
    stripped = r.stripped;
  } catch {
    throw new HttpError(400, 'validation', 'note state could not be sanitized');
  }
  const text = (typeof body.text === 'string' && body.text) || tiptapToText(sanitized);
  const noteId = randomUUID();
  const qq = (t: string, p?: unknown[]) => ({ text: t, params: p });
  await tx(() => {
    const queries = [
      qq(`INSERT INTO notes (id, subject_id, text, state, language) VALUES ($1,$2,$3,$4::jsonb,$5)`,
        [noteId, subjectId, text.slice(0, 100000), JSON.stringify(sanitized), body.language ?? null]),
      bumpRevQuery(projectId),
    ];
    if (body.clientOpId) {
      queries.push(qq(`INSERT INTO command_log (project_id, op_id, kind, payload) VALUES ($1,$2,'note.create',$3::jsonb)
        ON CONFLICT (op_id) DO NOTHING`, [projectId, body.clientOpId, JSON.stringify({ subject_id: subjectId })]));
    }
    return queries;
  });
  const rows = await sql()`SELECT id, subject_id, text, state, language, created_at, updated_at FROM notes WHERE id = ${noteId}`;
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${projectId}`;
  return ok({
    ...rows[0],
    rev: Number(rev[0]['rev']),
    sanitized_links_stripped: stripped,
    ...(body.clientOpId ? { clientOpId: body.clientOpId } : {}),
  }, 201);
}

type PhotoCtx = { params: Promise<{ id: string; photoId: string }> };
type SelCtx = { params: Promise<{ id: string; selectionId: string }> };

export function photoNotesRoute() {
  return {
    GET: handle(async (req: Request, ctx: PhotoCtx) => {
      const { id, photoId } = await ctx.params;
      await requireProject(id);
      return listNotes(id, photoId, new URL(req.url));
    }),
    POST: handle(async (req: Request, ctx: PhotoCtx) => {
      const { id, photoId } = await ctx.params;
      await requireProject(id);
      return createNote(id, photoId, req);
    }),
  };
}

export function selectionNotesRoute() {
  return {
    GET: handle(async (req: Request, ctx: SelCtx) => {
      const { id, selectionId } = await ctx.params;
      await requireProject(id);
      return listNotes(id, selectionId, new URL(req.url));
    }),
    POST: handle(async (req: Request, ctx: SelCtx) => {
      const { id, selectionId } = await ctx.params;
      await requireProject(id);
      return createNote(id, selectionId, req);
    }),
  };
}
