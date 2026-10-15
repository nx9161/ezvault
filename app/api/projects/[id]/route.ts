// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql, tx, bumpRevQuery } from '@/lib/db/index';
import { getStorageDriver } from '@/lib/storage/driver';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const project = await requireProject(id);
  return ok(project);
});

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{
    name?: string; default_template_id?: string | null; duplicate_policy?: string;
    notes_export_format?: string; clientOpId?: string;
  }>(req);

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (frag: string, v: unknown) => {
    params.push(v);
    sets.push(`${frag} $${params.length}`);
  };
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) throw new HttpError(400, 'validation', 'name must not be empty');
    push('name =', name.slice(0, 200));
  }
  if (body.default_template_id !== undefined) {
    if (body.default_template_id !== null) {
      const t = await sql()`SELECT id FROM templates WHERE id = ${body.default_template_id} AND project_id = ${id}`;
      if (!t.length) throw new HttpError(400, 'validation', 'template not found in this project');
    }
    push('default_template_id =', body.default_template_id);
  }
  if (body.duplicate_policy !== undefined) {
    if (!['skip', 'keep_both', 'ask'].includes(body.duplicate_policy)) {
      throw new HttpError(400, 'validation', 'invalid duplicate_policy');
    }
    push('duplicate_policy =', body.duplicate_policy);
  }
  if (body.notes_export_format !== undefined) {
    if (!['html', 'markdown'].includes(body.notes_export_format)) {
      throw new HttpError(400, 'validation', 'invalid notes_export_format');
    }
    push('notes_export_format =', body.notes_export_format);
  }
  if (!sets.length) throw new HttpError(400, 'validation', 'nothing to update');

  const rows = await tx((q) => [
    q(`UPDATE projects SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length + 1} RETURNING *`, [...params, id]),
    bumpRevQuery(id),
    ...(body.clientOpId
      ? [q(`INSERT INTO command_log (project_id, op_id, kind, payload) VALUES ($1,$2,'project.update',$3::jsonb) ON CONFLICT (op_id) DO NOTHING`,
          [id, body.clientOpId, JSON.stringify(body)])]
      : []),
  ]);
  const project = (rows[0] as unknown[])[0] as { rev: number };
  return ok({ ...project, rev: Number(project.rev) });
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);

  // Live R2 bytes deleted synchronously (Tech Law §3.3: "irreversible empty"
  // must hold as far as technically feasible; backups are crypto-shredded
  // separately via the monthly workflow's per-backup keys).
  const storage = await getStorageDriver();
  const doomed: string[] = [];
  for (const prefix of [`originals/${id}/`, `thumbs/${id}/`, `transcriptions/${id}/`]) {
    doomed.push(...(await storage.listKeys(prefix)));
  }
  // Project-scoped exports live under exports/{jobId}/ — enumerate this
  // project's jobs and sweep their prefixes.
  const exportJobs = await sql()`SELECT id FROM import_jobs WHERE project_id = ${id}`;
  for (const j of exportJobs as { id: string }[]) {
    doomed.push(...(await storage.listKeys(`exports/${j.id}/`)));
  }
  // .tpy staging for this project's jobs.
  for (const j of exportJobs as { id: string }[]) {
    doomed.push(...(await storage.listKeys(`tpy-staging/${j.id}/`)));
    doomed.push(...(await storage.listKeys(`uploads/${j.id}/`)));
  }
  // CR-3: DB cascade FIRST, R2 deletes after commit. If the DELETE fails,
  // every key reference survives — retryable. Leaked bytes (deleteMany
  // failing after commit) are the lesser evil vs ghost rows on an
  // IRREVERSIBLE op.
  await tx((q) => [q(`DELETE FROM projects WHERE id = $1`, [id])]);
  await storage.deleteMany(doomed).catch((err) => {
    console.error('project DELETE: R2 deleteMany failed after DB commit:', err);
  });
  return ok({ deleted: id, r2_objects_deleted: doomed.length });
});
