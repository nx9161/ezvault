// SPDX-License-Identifier: MIT
/**
 * test/csv-roundtrip.test.mjs — row 23: CSV export shape + the
 * export -> import round-trip, including B15 formula-injection cells.
 * Pure modules only (lib/export/csv-export.ts, lib/import/csv-parse.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildItemsCsv, csvColumns, CSV_MULTI_VALUE_SEP } from '../lib/export/csv-export.ts';
import { parseCsv, unsanitizeCsvCell } from '../lib/import/csv-parse.ts';

const TITLE = 'http://purl.org/dc/terms/title';
const DATE = 'http://purl.org/dc/terms/date';
const CREATOR = 'http://purl.org/dc/terms/creator';

function item(id, templateUri, fields, meta) {
  return { id, templateUri, templateFields: fields, metadata: new Map(Object.entries(meta)) };
}

describe('buildItemsCsv shape (row 23)', () => {
  const items = [
    item('id-1', 'https://example.org/tpl/photo', [
      { property_uri: TITLE, order: 0 },
      { property_uri: DATE, order: 1 },
    ], { [TITLE]: ['Harbor at dawn'], [DATE]: ['1932'] }),
    item('id-2', 'https://example.org/tpl/photo', [
      { property_uri: TITLE, order: 0 },
      { property_uri: DATE, order: 1 },
    ], { [TITLE]: ['Mill, interior'], [CREATOR]: ['A. Rivera', 'B. Chen'] }),
  ];

  it('header = bookkeeping columns + template property URIs in field order, extras sorted after', () => {
    assert.deepEqual(csvColumns(items), [TITLE, DATE, CREATOR]);
    const [header] = buildItemsCsv(items).split('\r\n');
    assert.equal(header, `id,template,${TITLE},${DATE},${CREATOR}`);
  });

  it('one row per item; multi-values join with the separator; blanks stay blank', () => {
    const lines = buildItemsCsv(items).trimEnd().split('\r\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[1], 'id-1,https://example.org/tpl/photo,Harbor at dawn,1932,');
    assert.equal(lines[2], `id-2,https://example.org/tpl/photo,"Mill, interior",,A. Rivera${CSV_MULTI_VALUE_SEP}B. Chen`);
  });
});

describe('formula-injection sanitize on export (B15)', () => {
  it('dangerous leading characters are tick-prefixed in values AND survive quoting', () => {
    const items = [item('id-9', null, [], {
      [TITLE]: ['=SUM(A1:A9)'],
      [CREATOR]: ['@evil'],
      [DATE]: ['-2+3'],
    })];
    const csv = buildItemsCsv(items);
    assert.ok(csv.includes("'=SUM(A1:A9)"), csv);
    assert.ok(csv.includes("'@evil"), csv);
    assert.ok(csv.includes("'-2+3"), csv);
  });
});

describe('parseCsv (RFC 4180)', () => {
  it('handles quoted commas, escaped quotes, embedded newlines, CRLF', () => {
    const rows = parseCsv('a,b\r\n"x,y","q""z"\r\n"line1\nline2",plain\r\n');
    assert.deepEqual(rows, [['a', 'b'], ['x,y', 'q"z'], ['line1\nline2', 'plain']]);
  });

  it('accepts LF endings, a BOM, and no trailing newline', () => {
    assert.deepEqual(parseCsv('\ufeffa,b\n1,2'), [['a', 'b'], ['1', '2']]);
  });

  it('throws on an unterminated quoted field', () => {
    assert.throws(() => parseCsv('a,"b'), /unterminated/);
  });
});

describe('export -> import round-trip', () => {
  it('restores original values, including formula cells and multi-values', () => {
    const items = [item('id-1', 'tpl', [{ property_uri: TITLE, order: 0 }], {
      [TITLE]: ['=HYPERLINK("http://x")'],
      [CREATOR]: ['Doe, Jane', 'Roe, Richard'],
    })];
    const csv = buildItemsCsv(items);
    const rows = parseCsv(csv);
    const headers = rows[0].map((h) => unsanitizeCsvCell(h.trim()));
    const data = rows[1].map((c) => unsanitizeCsvCell(c));
    const byHeader = Object.fromEntries(headers.map((h, i) => [h, data[i]]));
    assert.equal(byHeader['id'], 'id-1');
    assert.equal(byHeader[TITLE], '=HYPERLINK("http://x")');
    // Multi-value cell splits back into the original values (commas ride
    // through CSV quoting untouched). Documented limit: a single value
    // containing the separator "; " itself would split on import — the
    // same separator ambiguity the reference CSV plugin has.
    assert.deepEqual(byHeader[CREATOR].split(CSV_MULTI_VALUE_SEP), ['Doe, Jane', 'Roe, Richard']);
  });

  it('unsanitize only strips the tick before a dangerous character', () => {
    assert.equal(unsanitizeCsvCell("'=x"), '=x');
    assert.equal(unsanitizeCsvCell("'@x"), '@x');
    assert.equal(unsanitizeCsvCell("'plain"), "'plain");
    assert.equal(unsanitizeCsvCell("''"), "''");
    assert.equal(unsanitizeCsvCell(''), '');
  });
});
