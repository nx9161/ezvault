// SPDX-License-Identifier: MIT
/**
 * test/export-jsonld-db.test.mjs — regression guard for the 2026-10-21
 * sweep find: BOTH archive export routes 500'd on every real project.
 *
 * ROOT CAUSE: lib/db's `sql` is a FACTORY (export function sql(): SqlTag).
 * The export routes passed the factory itself — buildProjectJsonLd(sql, …)
 * — into lib/export/jsonld.js, which invokes its parameter as a tagged
 * template. Calling the factory returns the SqlTag FUNCTION (it ignores
 * its arguments), so `templates.map(...)` inside the builder hit
 * "(intermediate value).map is not a function". The backup script passed
 * a real neon tag and worked, which is why exports looked fine in backup
 * testing while both user-facing routes were dead.
 *
 * GUARD: (1) static — both routes must pass sql() (invoked);
 * (2) behavioral, DB-gated like the sibling *-db tests — run the REAL
 * builder through a shim identical to lib/db's sql() wrapper, including
 * the itemId fragment path, over a scratch project with one item.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('export routes pass an invoked sql tag', () => {
  for (const f of ['app/api/projects/[id]/export/jsonld/route.ts', 'app/api/projects/[id]/export/zip/route.ts']) {
    it(f, () => {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.match(src, /buildProjectJsonLd\(sql\(\)/);
      assert.doesNotMatch(src, /buildProjectJsonLd\(sql,/);
    });
  }
});

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.log('(export-jsonld-db: behavioral part skipped — set DATABASE_URL to run)');
} else {
  describe('buildProjectJsonLd through the lib/db-shaped sql() tag', () => {
    let sql;
    const projectId = randomUUID();
    const itemId = randomUUID();

    before(async () => {
      const { neon } = await import('@neondatabase/serverless');
      const raw = neon(DATABASE_URL);
      // Mirrors lib/db/index.ts sql(): factory returning the tag; the tag
      // forwards to the raw neon function (module itself is server-only).
      sql = (strings, ...params) => raw(strings, ...params);
      const q = (text, params) => raw.query(text, params);
      await q(`INSERT INTO projects (id, name) VALUES ($1, 'export-jsonld-test')`, [projectId]);
      await q(`INSERT INTO subjects (id, project_id, kind) VALUES ($1, $2, 'item')`, [itemId, projectId]);
      await q(`INSERT INTO items (subject_id) VALUES ($1)`, [itemId]);
    });

    after(async () => {
      const q = (text, params) => sql.query ? sql.query(text, params) : null;
      const { neon } = await import('@neondatabase/serverless');
      const raw = neon(DATABASE_URL);
      await raw.query(`DELETE FROM subjects WHERE project_id = $1`, [projectId]);
      await raw.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
      void q;
    });

    it('builds a document for the whole project and for one item', async () => {
      const { buildProjectJsonLd } = await import(path.join(ROOT, 'lib/export/jsonld.js'));
      const project = { id: projectId, name: 'export-jsonld-test' };
      const whole = await buildProjectJsonLd(sql, project, { format: 'html' });
      assert.ok(Array.isArray(whole['@graph']));
      assert.equal(whole['@graph'].length, 1);
      const single = await buildProjectJsonLd(sql, project, { format: 'html', itemId });
      assert.equal(single['@graph'].length, 1);
    });
  });
}
