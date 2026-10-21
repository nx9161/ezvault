// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { PLUGIN_REGISTRY, isPluginId } from '@/lib/plugins/registry';
import { getPluginStates, setPluginEnabled } from '@/lib/plugins/server';
import { sql } from '@/lib/db/index';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/[id]/plugins — the extension registry for this
 * project: every built-in manifest + its persisted enabled state
 * (Wave E part 2, docs/PLUGINS.md). Name/description are next-intl
 * keys under `plugins.<i18nBase>` — the client localizes them.
 */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const states = await getPluginStates(id);
  const items = PLUGIN_REGISTRY.map((p) => ({
    id: p.id,
    version: p.version,
    kind: p.kind,
    i18n_base: p.i18nBase,
    docs_anchor: p.docsAnchor,
    enabled: states[p.id] !== false,
  }));
  return ok({ items, total: items.length });
});

/**
 * PATCH /api/projects/[id]/plugins { plugin_id, enabled } — persist one
 * toggle (plugin_settings, migration 0012). Returns the full list so
 * the settings UI can re-render from server truth.
 */
export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{ plugin_id?: unknown; enabled?: unknown }>(req);
  if (!isPluginId(body.plugin_id)) {
    throw new HttpError(400, 'validation', 'plugin_id must be a registered plugin id');
  }
  if (typeof body.enabled !== 'boolean') {
    throw new HttpError(400, 'validation', 'enabled must be a boolean');
  }
  const states = await setPluginEnabled(id, body.plugin_id, body.enabled);
  const items = PLUGIN_REGISTRY.map((p) => ({
    id: p.id,
    version: p.version,
    kind: p.kind,
    i18n_base: p.i18nBase,
    docs_anchor: p.docsAnchor,
    enabled: states[p.id] !== false,
  }));
  const rev = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
  return ok({ items, total: items.length, rev: Number(rev[0]['rev']) });
});
