// SPDX-License-Identifier: MIT
/**
 * test/jsonld-roundtrip-keys.test.mjs — regression guard for the
 * 2026-10-21 sweep find: JSON-LD re-import silently dropped tags,
 * lists, notes, photos and selections.
 *
 * acceptJsonLd expanded the document (B10) and walked the EXPANDED
 * nodes with compact-vocabulary lookups (node['tag'], node['photo'],
 * nested 'filename'/'checksum'), so everything except items and
 * full-IRI metadata vanished. The fix routes the document through
 * lib/import/jsonld-expand.ts (expand → compact with the Tropy @vocab).
 * This test drives that seam with a document shaped exactly like the
 * app's own exporter output and asserts the walk's access patterns
 * resolve — on the old pipeline (expand only) every one of these is
 * an https://tropy.org/v1/tropy#… IRI key instead.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandAndCompact } from '../lib/import/jsonld-expand.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Mirrors lib/export/jsonld.js emit for one rich item (verified live).
const EXPORT_DOC = {
  '@context': { '@vocab': 'https://tropy.org/v1/tropy#' },
  '@graph': [
    {
      '@type': 'Item',
      'http://purl.org/dc/elements/1.1/title': { '@value': 'Harbor at Dawn', '@type': 'http://www.w3.org/2001/XMLSchema#string' },
      tag: ['harbor'],
      list: ['Favorites'],
      note: [{ '@type': 'Note', text: 'item note text', markdown: 'item note text' }],
      photo: [
        {
          protocol: 'file',
          filename: 'land.jpg',
          mimetype: 'image/jpeg',
          size: 70470,
          checksum: 'de2205491935b386e1bb437f2aa47face695dfb250c657af0af8cf17ed2a9841',
          width: 1200,
          height: 800,
          page: 0,
          note: [{ '@type': 'Note', text: 'photo note text', markdown: 'photo note text' }],
          selection: [
            { '@type': 'Selection', name: 'Harbor detail', x: 100, y: 80, width: 400, height: 300 },
          ],
        },
      ],
    },
  ],
};

describe('jsonld expand→compact seam', () => {
  it('acceptJsonLd routes through expandAndCompact', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/import/jsonld-accept.ts'), 'utf8');
    assert.match(src, /expandAndCompact\(doc\)/);
  });

  it('restores the compact keys + value shapes the import walk reads', async () => {
    const nodes = await expandAndCompact(EXPORT_DOC);
    assert.equal(nodes.length, 1);
    const item = nodes[0];
    const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
    assert.ok(types.some((t) => /Item$/.test(t)));
    // metadata keeps its full-IRI key + {@value,@type} shape
    assert.equal(item['http://purl.org/dc/elements/1.1/title']['@value'], 'Harbor at Dawn');
    // tags / lists come back as plain compact terms
    assert.deepEqual([item['tag']].flat(), ['harbor']);
    assert.deepEqual([item['list']].flat(), ['Favorites']);
    // item note readable via the walk's keys
    const note = [item['note']].flat()[0];
    assert.equal(note.text, 'item note text');
    // photo + nested shapes
    const photo = [item['photo']].flat()[0];
    assert.equal(photo.filename, 'land.jpg');
    assert.equal(photo.checksum, 'de2205491935b386e1bb437f2aa47face695dfb250c657af0af8cf17ed2a9841');
    assert.equal(photo.width, 1200);
    const pnote = [photo.note].flat()[0];
    assert.equal(pnote.text, 'photo note text');
    const sel = [photo.selection].flat()[0];
    assert.equal(sel.name, 'Harbor detail');
    assert.equal(sel.x, 100);
    // no tropy-IRI keys survive anywhere at item level
    assert.ok(!Object.keys(item).some((k) => k.startsWith('https://tropy.org/')));
  });
});
