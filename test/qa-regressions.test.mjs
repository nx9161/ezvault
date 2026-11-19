// SPDX-License-Identifier: MIT
/**
 * test/qa-regressions.test.mjs — regression guards for the 2026-11-18 QA
 * pass on the astryx-upgrade branch (REPORT.md in the QA evidence pack).
 * Wire/source style, matching merge-copy-wire.test.mjs: each assertion
 * pins the root-cause fix for one defect so it cannot silently return.
 *
 *   D1  Esc must close workspace dialogs (hotkey layer must not
 *       suppress the native <dialog> cancel; closeTopmost covers all
 *       store-flagged dialog layers).
 *   D2  Toast bridge must not add its own dismiss button (Astryx Toast
 *       already renders one).
 *   D3  Settings plugin checkboxes are named for their plugin.
 *   D4  errors.retry exists in every locale (Feedback.tsx renders it).
 *   D5  Photoless items get an item-level inspector, not the photos
 *       ErrorCard (the `!photo` early return must not render ErrorCard).
 *   D6  Items list + stats exclude subjects present in `trash`.
 *   D7  Sidebar Trash click must not reset the filter it just set.
 *   D8  "?" shortcut uses shift+? with useKey (react-hotkeys-hook v5
 *       matches on e.code, so a bare "?" can never fire).
 *   D9  Template .ttp import posts the parsed document, not a wrapper.
 *   D10 TpyWizard: no early return before the last hook (React #310).
 *   O1  Bulk metadata apply replaces values for the applied properties.
 *   O2  Single-item GET enriches the resolved title like the list GET.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

describe('D4 — errors.retry present in every locale', () => {
  const files = readdirSync(join(root, 'messages')).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 11, 'locale census');
  for (const f of files) {
    it(`${f} defines errors.retry`, () => {
      const msgs = JSON.parse(read(join('messages', f)));
      assert.equal(typeof msgs.errors?.retry, 'string');
      assert.ok(msgs.errors.retry.length > 0);
    });
  }
});

describe('D10 — TpyWizard hook order', () => {
  const src = read('components/tpy/TpyWizard.tsx');
  it('early return for closed state sits after every hook call', () => {
    const earlyReturn = src.indexOf('if (!open) return null');
    assert.ok(earlyReturn > -1, 'early return present');
    const lastHook = Math.max(
      src.lastIndexOf('useEffect('),
      src.lastIndexOf('useJob('),
      src.lastIndexOf('useState('),
      src.lastIndexOf('useRef('),
    );
    assert.ok(earlyReturn > lastHook, 'early return must follow the last hook');
  });
});

describe('D1/D8 — hotkey registry and binding', () => {
  const registry = read('lib/shortcuts/registry.ts');
  const binding = read('components/shortcuts/useRegisteredHotkeys.tsx');
  it('closeTopmost covers the Astryx-dialog store layers', () => {
    for (const flag of ['settingsOpen', 'retentionOpen', 'templatesOpen', 'aboutOpen']) {
      assert.match(registry, new RegExp(`ui\\.${flag}`), `closeTopmost handles ${flag}`);
    }
  });
  it('esc entry does not preventDefault (native dialog cancel must survive)', () => {
    assert.match(registry, /id: "closeTopmost"[\s\S]{0,1200}preventDefault: false/);
    assert.match(binding, /entry\.preventDefault/);
  });
  it('esc handler defers to an open native dialog', () => {
    assert.match(registry, /dialog\[open\]/);
  });
  it('"?" entry binds both shift states with useKey (v5 matches e.code otherwise)', () => {
    assert.match(registry, /id: "toggleShortcuts"[\s\S]{0,700}useKey: true/);
    assert.match(registry, /id: "toggleShortcuts"[\s\S]{0,600}keys: "shift\+\?, \?"/);
    assert.match(binding, /entry\.useKey/);
  });
});

describe('D2 — toast bridge has exactly one dismiss control', () => {
  const src = read('components/ui/Toasts.tsx');
  it('bridge does not render its own dismiss button', () => {
    assert.ok(!src.includes('label={t("dismiss")}'), 'no bridge dismiss button');
  });
});

describe('D3 — plugin checkboxes named for their plugin', () => {
  const src = read('components/settings/SettingsDialog.tsx');
  it('plugin CheckboxInput label is the plugin name, visually hidden', () => {
    assert.match(src, /label=\{tp\(`\$\{p\.i18n_base\}\.name` as never\)\}/);
    assert.match(src, /isLabelHidden/);
  });
});

describe('D5 — photoless items reach item metadata', () => {
  const src = read('components/inspector/Inspector.tsx');
  it('the no-photo path renders an item-subject MetadataForm', () => {
    assert.match(src, /subjectKind="item"/);
    assert.match(src, /items\/\$\{itemId\}/);
  });
  it('photos error still renders the ErrorCard (error and empty differ)', () => {
    assert.match(src, /if \(photosError\)/);
  });
});

describe('D6 — trashed subjects excluded from items and stats', () => {
  const items = read('app/api/projects/[id]/items/route.ts');
  const stats = read('app/api/projects/[id]/stats/route.ts');
  it('items GET excludes trash rows', () => {
    assert.match(items, /NOT EXISTS \(SELECT 1 FROM trash/);
  });
  it('stats item_count excludes trash rows', () => {
    assert.match(stats, /FROM trash/);
  });
});

describe('D7 — sidebar Trash click keeps the trash filter', () => {
  const src = read('components/sidebar/Sidebar.tsx');
  it('trash nav onClick does not call setActiveListId', () => {
    const m = src.match(/aria-current=\{libraryFilter === "trash"\}[\s\S]{0,600}/);
    assert.ok(m, 'trash nav row found');
    assert.ok(!m[0].includes('setActiveListId(null);'), 'no filter reset call in trash onClick');
  });
});

describe('D9 — .ttp import posts the raw document', () => {
  const src = read('components/templates/TemplatesDialog.tsx');
  it('importTtp parses the file and posts the document itself', () => {
    assert.match(src, /JSON\.parse\(text\)/);
    assert.ok(!src.includes('{ ttp: text, filename: file.name }'), 'no wrapper payload');
  });
});

describe('D10 contract — wizard speaks the tpy routes\' language', () => {
  const wizard = read('components/tpy/TpyWizard.tsx');
  it('presign sends tpy_size + with_assets_zip (route requires them)', () => {
    assert.match(wizard, /"\/api\/import\/tpy\/presign"[\s\S]{0,300}tpy_size: tpyFile\.size/);
    assert.match(wizard, /with_assets_zip: !!assetsFile/);
    assert.ok(!wizard.includes('with_assets: !!assetsFile'), 'stale with_assets field gone');
  });
  it('presign response is read as a grants array', () => {
    assert.match(wizard, /grants\.find\(\(g\) => g\.kind === "tpy"\)/);
    assert.ok(!wizard.includes('presigned.tpy_grant'), 'no tpy_grant field reads');
    assert.ok(!wizard.includes('presigned.assets_grant'), 'no assets_grant field reads');
  });
  it('analyze sends project_id + staged_key and normalizes camelCase', () => {
    assert.match(wizard, /"\/api\/import\/tpy\/analyze"[\s\S]{0,200}staged_key: tpyGrant\.key/);
    assert.match(wizard, /template_uris: rawAnalysis\.templateUris/);
  });
  it('run response conflicts array is counted, expected defaults empty', () => {
    assert.match(wizard, /conflicts: rawRep\.conflicts\.length/);
    assert.match(wizard, /expected: \{\}/);
  });
});

describe('O1 — bulk metadata apply replaces', () => {
  const src = read('lib/commands/ops.ts');
  it('bulkMetadataOp sends replace: true', () => {
    assert.match(src, /metadata\/bulk`, \{ subject_ids: subjectIds, values: metadataWire\(values\), replace: true \}/);
  });
});

describe('O2 — single-item GET enriches title', () => {
  const src = read('app/api/projects/[id]/items/[itemId]/route.ts');
  it('GET resolves the display title like the list route', () => {
    assert.match(src, /resolveItemTitles/);
    assert.match(src, /title:/);
  });
});
