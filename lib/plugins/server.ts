// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/plugins/server.ts — server persistence + enforcement for the
 * extension registry (lib/plugins/registry.ts, docs/PLUGINS.md).
 *
 * State lives in plugin_settings (migration 0012), per project. A
 * plugin with no row is enabled. Guarded routes call
 * requirePluginEnabled() BEFORE doing any work: a disabled plugin's
 * route answers an honest 403 `plugin_disabled` — the capability is
 * not hidden or faked, it is off, and Settings turns it back on.
 */

import { sql } from "@/lib/db/index";
import { HttpError } from "@/lib/api/route-utils";
import {
  isPluginId,
  isPluginEnabledIn,
  resolvePluginState,
  type PluginState,
} from "@/lib/plugins/registry";

/** Full resolved state for a project (every registry id -> enabled). */
export async function getPluginStates(projectId: string): Promise<PluginState> {
  const rows = await sql()`SELECT plugin_id, enabled FROM plugin_settings WHERE project_id = ${projectId}`;
  return resolvePluginState(
    rows as unknown as Array<{ plugin_id: string; enabled: boolean }>,
  );
}

export async function isPluginEnabled(
  projectId: string,
  pluginId: string,
): Promise<boolean> {
  const states = await getPluginStates(projectId);
  return isPluginEnabledIn(states, pluginId);
}

/** Persist one toggle (upsert). Unknown ids are a validation error. */
export async function setPluginEnabled(
  projectId: string,
  pluginId: string,
  enabled: boolean,
): Promise<PluginState> {
  if (!isPluginId(pluginId)) {
    throw new HttpError(400, "validation", `unknown plugin id: ${pluginId}`);
  }
  await sql()`INSERT INTO plugin_settings (project_id, plugin_id, enabled, updated_at)
    VALUES (${projectId}, ${pluginId}, ${enabled}, now())
    ON CONFLICT (project_id, plugin_id)
    DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`;
  return getPluginStates(projectId);
}

/**
 * Route guard: throws HttpError 403 `plugin_disabled` when the plugin
 * is off for this project. Call after requireProject(), before work.
 */
export async function requirePluginEnabled(
  projectId: string,
  pluginId: string,
): Promise<void> {
  if (!(await isPluginEnabled(projectId, pluginId))) {
    throw new HttpError(
      403,
      "plugin_disabled",
      `The ${pluginId} extension is disabled for this project (Project settings → Extensions).`,
    );
  }
}
