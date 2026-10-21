// SPDX-License-Identifier: MIT
/**
 * test/single-statement-sql.test.mjs — regression guard for the
 * 2026-10-21 import crash.
 *
 * ROOT CAUSE: bumpCountersQuery (lib/db/index.ts) returned a TxQuery whose
 * text carried TWO statements (INSERT ... ON CONFLICT DO NOTHING; WITH ...
 * UPDATE ...). Every statement this app sends goes through the Neon HTTP
 * driver as a prepared statement, and Postgres rejects multi-command
 * prepared statements: "cannot insert multiple commands into a prepared
 * statement". /api/import/process died inside its finalizing transaction;
 * the owner's photo wedged mid-import. The unit suite never caught it
 * because nothing executed the shipped SQL text through the real driver.
 *
 * GUARD (two layers):
 *  1. Static: scan every template literal in lib/ + app/ that looks like
 *     SQL and fail if any literal contains more than one statement. This
 *     catches the CLASS anywhere it reappears, not just the one site.
 *  2. Behavioral (DB-gated, like the sibling *-db tests): extract the
 *     ACTUAL bumpCountersQuery text from lib/db/index.ts and run it
 *     through neon's transaction() — the exact production path — against
 *     a scratch project, asserting lazy-create + increment + decrement.
 *     On the old two-statement text this fails with the production error.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATEMENT_START = /^(INSERT|UPDATE|DELETE|SELECT|WITH|CREATE|DROP|ALTER|TRUNCATE|SET|BEGIN|COMMIT|GRANT|REVOKE)\b/i;
const SQL_HINT = /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|WITH|CREATE TABLE)\b/i;

/** Extract template literals from TS source, ${...} collapsed to '?'. */
function templateLiterals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === '`') {
      let j = i + 1;
      let depth = 0;
      let buf = '';
      while (j < src.length) {
        const c = src[j];
        if (c === '\\') { buf += src[j + 1] ?? ''; j += 2; continue; }
        if (c === '$' && src[j + 1] === '{') { depth++; buf += '?'; j += 2; continue; }
        if (c === '}' && depth > 0) { depth--; j++; continue; }
        if (c === '`' && depth === 0) break;
        if (depth === 0) buf += c;
        j++;
      }
      out.push(buf);
      i = j + 1;
    } else i++;
  }
  return out;
}

/** Count SQL statements in a literal: fragments split on ';' that begin
 *  with a statement keyword. A trailing ';' yields an empty fragment. */
function statementCount(lit) {
  return lit.split(';').filter((f) => STATEMENT_START.test(f.trim())).length;
}

function* tsFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'vendor' || e.name === 'node_modules') continue;
      yield* tsFiles(p);
    } else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) yield p;
  }
}

describe('single-statement SQL guard (lib/ + app/)', () => {
  it('no SQL template literal contains more than one statement', () => {
    const violations = [];
    for (const dir of ['lib', 'app']) {
      for (const file of tsFiles(path.join(ROOT, dir))) {
        const src = fs.readFileSync(file, 'utf8');
        for (const lit of templateLiterals(src)) {
          if (!SQL_HINT.test(lit)) continue;
          const n = statementCount(lit);
          if (n > 1) {
            violations.push(`${path.relative(ROOT, file)}: ${n} statements: ${lit.trim().slice(0, 80)}…`);
          }
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  it('bumpCountersQuery is a single upsert statement', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/db/index.ts'), 'utf8');
    const fnStart = src.indexOf('export function bumpCountersQuery');
    assert.ok(fnStart >= 0, 'bumpCountersQuery must exist');
    const m = src.slice(fnStart).match(/text:\s*`([\s\S]*?)`/);
    assert.ok(m, 'bumpCountersQuery must carry a text template literal');
    assert.equal(statementCount(m[1]), 1, 'bumpCountersQuery text must be exactly one statement');
    assert.match(m[1], /ON CONFLICT \(project_id\) DO UPDATE/);
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.log('(single-statement-sql: behavioral part skipped — set DATABASE_URL to run)');
} else {
  describe('bumpCountersQuery through the real driver transaction()', () => {
    let db;
    const projectId = randomUUID();

    before(async () => {
      const { neon } = await import('@neondatabase/serverless');
      db = neon(DATABASE_URL);
      await db.query(`INSERT INTO projects (id, name) VALUES ($1, 'single-statement-test')`, [projectId]);
    });

    after(async () => {
      await db.query(`DELETE FROM storage_counters WHERE project_id = $1`, [projectId]);
      await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    });

    it('lazy-creates, increments and decrements atomically in tx batches', async () => {
      const src = fs.readFileSync(path.join(ROOT, 'lib/db/index.ts'), 'utf8');
      const m = src.slice(src.indexOf('export function bumpCountersQuery')).match(/text:\s*`([\s\S]*?)`/);
      const text = m[1];
      const bump = (o, t, e) => db.query(text, [projectId, o, t, e]);
      // The exact production shape: bumpCounters rides inside a
      // transaction batch alongside other statements.
      await db.transaction([bump(100, 40, 0), db.query(`UPDATE projects SET rev = rev + 1 WHERE id = $1`, [projectId])]);
      await db.transaction([bump(50, -10, 5)]);
      const rows = await db.query(
        `SELECT bytes_originals::int AS o, bytes_thumbs::int AS t, bytes_exports::int AS e FROM storage_counters WHERE project_id = $1`,
        [projectId],
      );
      assert.deepEqual(rows, [{ o: 150, t: 30, e: 5 }]);
    });
  });
}
