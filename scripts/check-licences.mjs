// SPDX-License-Identifier: MIT
// check-licences.mjs — walk node_modules and fail on copyleft/viral licenses
// vendored into the build. Allowlist: MIT, Apache-2.0, BSD-*, ISC, CC0, Unlicense,
// Python-2.0, PSF, MPL-2.0 (weak copyleft, file-scoped — allowed), LGPL-2.1/3.0
// (dynamic linkage only — backend must never statically build libvips/libheif).
// Denylist: GPL-*, AGPL-*, SSPL-*, Commons Clause, Elastic License.
import { readdirSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const NM = join(ROOT, 'node_modules');

const DENY = [/(?<!L)GPL/i, /AGPL/i, /SSPL/i, /commons clause/i, /elastic license/i];
// LGPL is allowed only as dynamically-linked (WASM artifact / prebuilt binary).
const WARN = [/LGPL/i];

const bad = [];
const warn = [];

function licenseOf(pkgDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const lic = pkg.license ?? pkg.licenses ?? 'UNKNOWN';
    // licenses: [{type:'MIT',url:...}] object form — join the type strings
    // instead of stringifying to "[object Object]".
    if (Array.isArray(lic)) {
      return lic.map((e) => (typeof e === 'string' ? e : e?.type ?? 'UNKNOWN')).join(' OR ');
    }
    return String(lic);
  } catch {
    return 'UNKNOWN';
  }
}

function walk(dir, depth = 0) {
  if (depth > 20) return; // pathological nesting guard (npm flattens; 20 is plenty)
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e.startsWith('.')) continue;
    const p = join(dir, e);
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue; // no symlink cycles
    if (!st.isDirectory()) continue;
    if (existsSync(join(p, 'package.json'))) {
      const lic = licenseOf(p);
      if (DENY.some((re) => re.test(lic))) bad.push(`${p.replace(NM + '/', '')}: ${lic}`);
      else if (WARN.some((re) => re.test(lic))) warn.push(`${p.replace(NM + '/', '')}: ${lic}`);
    }
    // Recurse everywhere: @scoped dirs (no package.json of their own —
    // previously never scanned), nested node_modules, bundled deps.
    walk(p, depth + 1);
  }
}

walk(NM);

for (const w of warn) console.warn(`check-licences: WARNING (allowed, dynamic-link only) — ${w}`);
if (bad.length) {
  for (const b of bad) console.error(`check-licences: FAIL — ${b}`);
  process.exit(1);
}
console.log('check-licences: OK (no GPL/AGPL/SSPL vendored)');
