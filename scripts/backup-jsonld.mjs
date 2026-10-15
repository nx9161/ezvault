#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * scripts/backup-jsonld.mjs — shared-module JSON-LD dump for the monthly backup.
 *
 * Reads DATABASE_URL from env (never commits it), imports
 * ../lib/export/jsonld.js (the same module the app route uses), and writes
 * one JSON-LD file per project to backups/jsonld/. Exit codes:
 *   0 ok, 2 DATABASE_URL missing, 3 dump failure.
 *
 * Security notes (B24/B26):
 *   - the shared module never emits subjects.raw_import or note
 *     `_importedFrom` audit JSON.
 *   - per-backup data-key crypto-shredding design: each monthly run writes
 *     its JSON-LD to a NEW object key (backups/<date>/<uuid>.json);
 *     the private bucket lifecycle expires objects after 365 days, and
 *     because nothing is ever overwritten, deletion of the key destroys the
 *     only copy of that month's plaintext (forward-secure deletion).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const dbUrl = process.env['DATABASE_URL'];
if (!dbUrl) {
  console.error('backup-jsonld: DATABASE_URL is not set');
  process.exit(2);
}

const { neon } = await import('@neondatabase/serverless');
const { buildProjectJsonLd } = await import('../lib/export/jsonld.js');
const sql = neon(dbUrl);

const outDir = resolve(process.cwd(), 'backups', 'jsonld');
await mkdir(outDir, { recursive: true });

const projects = await sql`SELECT id, name, rev FROM projects ORDER BY name`;
const results = [];
for (const p of projects) {
  const doc = await buildProjectJsonLd(sql, p, { format: 'html' });
  const filename = `${String(p.name).replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()}-${p.id.slice(0, 8)}.json`;
  const path = join(outDir, filename);
  await writeFile(path, JSON.stringify(doc));
  const rows = await sql`SELECT COUNT(*)::int AS c FROM subjects WHERE project_id = ${p.id}`;
  results.push({ project: p.name, file: filename, subjects: rows[0].c });
  console.log(`backup-jsonld: ${p.name} -> ${filename} (${rows[0].c} subjects)`);
}
await writeFile(join(outDir, `manifest-${randomUUID()}.json`), JSON.stringify({
  at: new Date().toISOString(),
  results,
}));
console.log(`backup-jsonld: OK (${projects.length} projects)`);
