// SPDX-License-Identifier: MIT
/**
 * lib/plugins/registry.ts — the EZVault extension registry (Wave E
 * part 2; the plugin-equivalent surface, docs/PLUGINS.md).
 *
 * PURE module (no DB, no framework imports): imported by the server
 * guard (lib/plugins/server.ts), the settings UI, and the unit tests.
 *
 * EZVault does NOT execute third-party plugin code: Tropy plugins are
 * separately installed local packages that run with full app access,
 * which a hosted serverless single-user app cannot mirror safely (the
 * honest platform delta is documented in docs/PLUGINS.md). Instead,
 * every built-in capability that occupies a Tropy plugin hook point —
 * export, import, integration, engine — is registered here as a typed
 * manifest, can be enabled/disabled per project (persisted server-side
 * in plugin_settings, migration 0012), and its routes enforce that
 * state via requirePluginEnabled().
 */

export type PluginKind = "export" | "import" | "integration" | "engine";

export const PLUGIN_KINDS: readonly PluginKind[] = [
  "export",
  "import",
  "integration",
  "engine",
] as const;

export interface PluginManifest {
  /** Stable id: registry key, plugin_settings.plugin_id, route guards. */
  id: string;
  /** Semver of the built-in capability's contract. */
  version: string;
  kind: PluginKind;
  /** next-intl key under the `plugins` namespace: `<i18nBase>.name`. */
  i18nBase: string;
  /** Anchor in docs/PLUGINS.md describing the capability. */
  docsAnchor: string;
}

export const PLUGIN_REGISTRY: readonly PluginManifest[] = [
  { id: "csv-export", version: "1.0.0", kind: "export", i18nBase: "csvExport", docsAnchor: "csv-export" },
  { id: "archive-export", version: "1.0.0", kind: "export", i18nBase: "archiveExport", docsAnchor: "archive-export" },
  { id: "jsonld-export", version: "1.0.0", kind: "export", i18nBase: "jsonldExport", docsAnchor: "jsonld-export" },
  { id: "csv-import", version: "1.0.0", kind: "import", i18nBase: "csvImport", docsAnchor: "csv-import" },
  { id: "jsonld-import", version: "1.0.0", kind: "import", i18nBase: "jsonldImport", docsAnchor: "jsonld-import" },
  { id: "iiif-import", version: "1.0.0", kind: "import", i18nBase: "iiifImport", docsAnchor: "iiif-import" },
  { id: "alto-import", version: "1.0.0", kind: "import", i18nBase: "altoImport", docsAnchor: "alto-import" },
  { id: "omeka-push", version: "1.0.0", kind: "integration", i18nBase: "omekaPush", docsAnchor: "omeka-push" },
  { id: "tesseract-ocr", version: "1.0.0", kind: "engine", i18nBase: "tesseractOcr", docsAnchor: "tesseract-ocr" },
] as const;

export const PLUGIN_IDS: readonly string[] = PLUGIN_REGISTRY.map((p) => p.id);

const BY_ID = new Map(PLUGIN_REGISTRY.map((p) => [p.id, p]));

export function getPlugin(id: string): PluginManifest | undefined {
  return BY_ID.get(id);
}

export function isPluginId(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id);
}

/** Structural validation for a manifest (registry integrity tests). */
export function isValidManifest(m: unknown): m is PluginManifest {
  if (!m || typeof m !== "object") return false;
  const p = m as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.id) &&
    typeof p.version === "string" &&
    /^\d+\.\d+\.\d+$/.test(p.version) &&
    typeof p.kind === "string" &&
    (PLUGIN_KINDS as readonly string[]).includes(p.kind) &&
    typeof p.i18nBase === "string" &&
    p.i18nBase.length > 0 &&
    typeof p.docsAnchor === "string" &&
    p.docsAnchor.length > 0
  );
}

/**
 * Persisted enable/disable state for one project: plugin id -> enabled.
 * A plugin with NO stored row is ENABLED (the registry ships on; the
 * settings table records only explicit choices, migration 0012).
 */
export type PluginState = Readonly<Record<string, boolean>>;

export function isPluginEnabledIn(state: PluginState, id: string): boolean {
  if (!isPluginId(id)) return false;
  return state[id] !== false;
}

/** Pure toggle: returns a NEW state object with `id` set to `enabled`. */
export function applyPluginToggle(
  state: PluginState,
  id: string,
  enabled: boolean,
): Record<string, boolean> {
  if (!isPluginId(id)) throw new Error(`unknown plugin id: ${String(id)}`);
  return { ...state, [id]: enabled };
}

/** Merge persisted rows over the all-enabled default. */
export function resolvePluginState(
  rows: Iterable<{ plugin_id: string; enabled: boolean }>,
): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  for (const p of PLUGIN_REGISTRY) state[p.id] = true;
  for (const row of rows) {
    if (isPluginId(row.plugin_id)) state[row.plugin_id] = row.enabled !== false;
  }
  return state;
}

export interface PluginGateDecision {
  allowed: boolean;
  /** HTTP status when not allowed (403 — the capability exists but is off). */
  status: 403 | null;
  code: "plugin_disabled" | null;
}

/** The enforcement decision every guarded route applies. */
export function pluginGate(state: PluginState, id: string): PluginGateDecision {
  return isPluginEnabledIn(state, id)
    ? { allowed: true, status: null, code: null }
    : { allowed: false, status: 403, code: "plugin_disabled" };
}
