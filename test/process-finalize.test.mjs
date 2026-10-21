// SPDX-License-Identifier: MIT
/**
 * test/process-finalize.test.mjs — contract guard for the /process
 * finalize transaction (lib/import/process-photo.ts).
 *
 * lib/import/photos.ts documents the staged-row contract: photo rows are
 * created with "r2_key NULL / missing_original=true until /process
 * finalizes them". The finalize UPDATE set r2_key/thumb/dimensions but
 * never cleared missing_original, so EVERY browser-uploaded photo stayed
 * flagged missing-original forever — item copy then skipped copying its
 * original bytes (lib/items/copy.ts gates on !missing_original) and the
 * storage dialog treated live originals as missing. Caught live
 * 2026-10-21 on the owner's first finalized photo.
 *
 * Source-contract assertion (the repo's wire-test convention — the module
 * imports `server-only` and sharp, so it cannot be unit-imported under
 * tsx); the behavioral proof is the live import sweep.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'lib/import/process-photo.ts'), 'utf8');

describe('process-photo finalize contract', () => {
  it('the finalizing UPDATE clears missing_original', () => {
    const m = src.match(/UPDATE photos SET r2_key = \$2[\s\S]*?WHERE subject_id = \$1/);
    assert.ok(m, 'finalize UPDATE must exist');
    assert.match(m[0], /missing_original = false/);
  });
});
