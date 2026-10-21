-- SPDX-License-Identifier: MIT
-- db/migrations/0012_plugin_settings.sql — Wave E part 2: the
-- plugin-equivalent extension surface (docs/PLUGINS.md).
--
-- plugin_settings: per-project enable/disable state for the built-in
-- capabilities registered in lib/plugins/registry.ts. A plugin with NO
-- row is ENABLED — the table records only explicit choices, so shipping
-- a new built-in never needs a backfill. Rows are keyed by the stable
-- registry id (not a FK: the registry lives in code, and an id retired
-- from the registry simply stops being read — resolvePluginState()
-- ignores unknown ids).
--
-- Apply with: psql "$DATABASE_URL" -f db/migrations/0012_plugin_settings.sql
-- (migrations apply in filename order). Idempotent.

CREATE TABLE IF NOT EXISTS plugin_settings (
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plugin_id           TEXT NOT NULL,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, plugin_id)
);
