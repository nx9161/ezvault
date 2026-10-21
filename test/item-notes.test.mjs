// SPDX-License-Identifier: MIT
/**
 * test/item-notes.test.mjs — item-notes surface guard (2026-10-21 sweep).
 *
 * The notes table/service are subject-generic and item notes already
 * existed as data (merge moves them; IIIF harvest writes them), but no
 * route could create or list them — the v1 surface stopped at photos +
 * selections. The sweep added the item route reusing the vetted service.
 * These source assertions pin the wiring (route file, service factory,
 * client key/kind) so the surface cannot silently unwire; the behavioral
 * proof is the live sweep (create/list/edit/delete on an item).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('item notes surface', () => {
  it('route file wires itemNotesRoute', () => {
    const src = read('app/api/projects/[id]/items/[itemId]/notes/route.ts');
    assert.match(src, /itemNotesRoute/);
    assert.match(src, /export \{ GET, POST \}/);
  });
  it('service exposes itemNotesRoute with token scopes', () => {
    const src = read('lib/api/notes.ts');
    assert.match(src, /export function itemNotesRoute/);
    const block = src.slice(src.indexOf('export function itemNotesRoute'));
    assert.match(block, /enforceTokenScope\(req, 'read'\)/);
    assert.match(block, /enforceTokenScope\(req, 'notes:write'\)/);
    assert.match(block, /createNote\(id, itemId, req\)/);
  });
  it('client hooks resolve item note keys', () => {
    const src = read('lib/api/hooks.ts');
    assert.match(src, /NoteSubjectKind = "photo" \| "selection" \| "item"/);
    assert.match(src, /itemNotes: \(id: string, itemId: string\)/);
    assert.match(src, /kind === "item"\) return key\.itemNotes/);
  });
});
