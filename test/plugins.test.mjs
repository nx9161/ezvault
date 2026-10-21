// SPDX-License-Identifier: MIT
/**
 * test/plugins.test.mjs — Wave E part 2: the plugin-equivalent
 * extension surface (docs/PLUGINS.md).
 *
 * - Registry integrity: unique ids, valid manifests, the nine real
 *   built-in capabilities across all four kinds.
 * - i18n wiring: every manifest's i18nBase resolves to name+description
 *   keys in ALL 11 locale files (the Settings UI renders from these).
 * - Enable/disable state logic: default-on, persisted-row resolution,
 *   toggle round-trips through an in-memory store shaped exactly like
 *   plugin_settings rows (migration 0012) — the same contract
 *   lib/plugins/server.ts applies over SQL.
 * - Enforcement logic: pluginGate decisions + a source-level check
 *   that every registered plugin id is actually guarded in a route or
 *   handler (no registry entry without a real enforcement point).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PLUGIN_REGISTRY,
  PLUGIN_IDS,
  PLUGIN_KINDS,
  getPlugin,
  isPluginId,
  isValidManifest,
  isPluginEnabledIn,
  applyPluginToggle,
  resolvePluginState,
  pluginGate,
} from '../lib/plugins/registry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

describe('plugin registry integrity', () => {
  it('registers the nine real built-in capabilities, unique ids', () => {
    assert.deepEqual(
      [...PLUGIN_IDS].sort(),
      ['alto-import', 'archive-export', 'csv-export', 'csv-import', 'iiif-import', 'jsonld-export', 'jsonld-import', 'omeka-push', 'tesseract-ocr'].sort(),
    );
    assert.equal(new Set(PLUGIN_IDS).size, PLUGIN_IDS.length);
  });

  it('every manifest is structurally valid', () => {
    for (const m of PLUGIN_REGISTRY) assert.ok(isValidManifest(m), m.id);
    assert.ok(!isValidManifest({ id: 'Bad Id', version: '1.0.0', kind: 'export', i18nBase: 'x', docsAnchor: 'x' }));
    assert.ok(!isValidManifest({ id: 'ok-id', version: '1.0', kind: 'export', i18nBase: 'x', docsAnchor: 'x' }));
    assert.ok(!isValidManifest({ id: 'ok-id', version: '1.0.0', kind: 'rootkit', i18nBase: 'x', docsAnchor: 'x' }));
    assert.ok(!isValidManifest(null));
  });

  it('covers all four kinds (export, import, integration, engine)', () => {
    const kinds = new Set(PLUGIN_REGISTRY.map((p) => p.kind));
    assert.deepEqual([...kinds].sort(), [...PLUGIN_KINDS].sort());
    assert.equal(getPlugin('tesseract-ocr').kind, 'engine');
    assert.equal(getPlugin('omeka-push').kind, 'integration');
  });

  it('getPlugin / isPluginId agree with the registry', () => {
    for (const id of PLUGIN_IDS) assert.ok(isPluginId(id));
    assert.ok(!isPluginId('tropy-plugin'));
    assert.ok(!isPluginId(''));
    assert.equal(getPlugin('nope'), undefined);
  });
});

describe('plugin i18n wiring (all 11 locales)', () => {
  const codes = ['en', 'de', 'es', 'fr', 'it', 'ja', 'nl', 'pt', 'pt-BR', 'uk', 'zh'];
  for (const code of codes) {
    it(`${code}: every plugin has a name + description`, () => {
      const messages = JSON.parse(readFileSync(join(root, 'messages', `${code}.json`), 'utf8'));
      for (const p of PLUGIN_REGISTRY) {
        const entry = messages.plugins?.[p.i18nBase];
        assert.ok(entry, `${code}: plugins.${p.i18nBase} missing`);
        assert.ok(typeof entry.name === 'string' && entry.name.length > 0, `${code}:${p.id} name`);
        assert.ok(typeof entry.description === 'string' && entry.description.length > 0, `${code}:${p.id} description`);
      }
      for (const kind of PLUGIN_KINDS) {
        const key = `kind${kind[0].toUpperCase()}${kind.slice(1)}`;
        assert.ok(typeof messages.plugins[key] === 'string', `${code}: plugins.${key}`);
      }
    });
  }
});

describe('enable/disable state (plugin_settings contract)', () => {
  it('defaults: no persisted rows means everything is enabled', () => {
    const state = resolvePluginState([]);
    for (const id of PLUGIN_IDS) assert.equal(isPluginEnabledIn(state, id), true, id);
  });

  it('persisted rows override defaults; unknown ids are ignored', () => {
    const state = resolvePluginState([
      { plugin_id: 'csv-export', enabled: false },
      { plugin_id: 'retired-plugin', enabled: false },
      { plugin_id: 'omeka-push', enabled: true },
    ]);
    assert.equal(isPluginEnabledIn(state, 'csv-export'), false);
    assert.equal(isPluginEnabledIn(state, 'omeka-push'), true);
    assert.equal(isPluginEnabledIn(state, 'iiif-import'), true);
    assert.equal(isPluginEnabledIn(state, 'retired-plugin'), false);
  });

  it('toggle round-trip through a plugin_settings-shaped store', () => {
    // In-memory stand-in for the SQL upsert in lib/plugins/server.ts:
    // rows keyed (project_id, plugin_id), exactly migration 0012's shape.
    const table = new Map();
    const upsert = (projectId, pluginId, enabled) => table.set(`${projectId}:${pluginId}`, { plugin_id: pluginId, enabled });
    const read = (projectId) => resolvePluginState([...table.entries()].filter(([k]) => k.startsWith(`${projectId}:`)).map(([, v]) => v));

    let state = read('p1');
    assert.equal(isPluginEnabledIn(state, 'csv-export'), true);
    state = applyPluginToggle(state, 'csv-export', false);
    upsert('p1', 'csv-export', state['csv-export']);
    assert.equal(isPluginEnabledIn(read('p1'), 'csv-export'), false);
    // Another project is unaffected.
    assert.equal(isPluginEnabledIn(read('p2'), 'csv-export'), true);
    // Toggling back on persists.
    upsert('p1', 'csv-export', true);
    assert.equal(isPluginEnabledIn(read('p1'), 'csv-export'), true);
    // applyPluginToggle does not mutate its input and rejects strangers.
    const before = { 'csv-export': true };
    const after = applyPluginToggle(before, 'csv-export', false);
    assert.equal(before['csv-export'], true);
    assert.equal(after['csv-export'], false);
    assert.throws(() => applyPluginToggle({}, 'nope', true), /unknown plugin id/);
  });
});

describe('enforcement logic (pluginGate + real route wiring)', () => {
  it('gate allows enabled, denies disabled with 403 plugin_disabled', () => {
    assert.deepEqual(pluginGate({}, 'csv-export'), { allowed: true, status: null, code: null });
    assert.deepEqual(pluginGate({ 'csv-export': false }, 'csv-export'), {
      allowed: false, status: 403, code: 'plugin_disabled',
    });
    assert.equal(pluginGate({ 'csv-export': false }, 'csv-import').allowed, true);
  });

  it('every registered plugin id is guarded in a route or handler', () => {
    const sources = [
      'app/api/projects/[id]/export/csv/route.ts',
      'app/api/projects/[id]/export/zip/route.ts',
      'app/api/projects/[id]/export/jsonld/route.ts',
      'app/api/projects/[id]/import/csv/route.ts',
      'app/api/projects/[id]/import/iiif/route.ts',
      'app/api/import/jsonld/route.ts',
      'app/api/projects/[id]/omeka/push/route.ts',
      'app/api/projects/[id]/omeka/push-project/route.ts',
      'lib/api/transcriptions.ts',
    ].map((rel) => readFileSync(join(root, rel), 'utf8')).join('\n');
    for (const id of PLUGIN_IDS) {
      assert.ok(sources.includes(`requirePluginEnabled`), 'guard helper imported');
      assert.ok(new RegExp(`requirePluginEnabled\\([^)]*'${id}'`).test(sources), `${id} has no enforcement point`);
    }
  });

  it('the plugins API route exists (list + toggle surface)', () => {
    assert.ok(existsSync(join(root, 'app/api/projects/[id]/plugins/route.ts')));
    assert.ok(existsSync(join(root, 'db/migrations/0012_plugin_settings.sql')));
  });
});
