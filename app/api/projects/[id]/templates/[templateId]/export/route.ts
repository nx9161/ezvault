// SPDX-License-Identifier: MIT
import { handle, requireProject, HttpError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; templateId: string }> };

/** Export a template as a .ttp JSON document (download). */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id, templateId } = await ctx.params;
  await requireProject(id);
  const rows = await sql()`SELECT name, uri, label_i18n, fields FROM templates
    WHERE id = ${templateId} AND project_id = ${id}`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'template not found');
  const r = rows[0];
  const ttp = {
    name: r['name'],
    ...(r['uri'] ? { uri: r['uri'] } : {}),
    label_i18n: r['label_i18n'] ?? {},
    fields: r['fields'] ?? [],
  };
  const filename = `${String(r['name']).replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()}.ttp`;
  return new Response(JSON.stringify(ttp, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, max-age=240',
    },
  });
});
