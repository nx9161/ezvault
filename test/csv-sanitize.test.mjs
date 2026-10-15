// SPDX-License-Identifier: MIT
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCsvCell, sanitizeCsvRow, csvCell, csvRow, toCsv } from '../lib/export/csv-sanitize';

describe('csv-sanitize (B15)', () => {
  it('prefixes formula cells with a single quote', () => {
    assert.equal(sanitizeCsvCell('=SUM(A1:A5)'), "'=SUM(A1:A5)");
    assert.equal(sanitizeCsvCell('+1+1'), "'+1+1");
    assert.equal(sanitizeCsvCell('-foo'), "'-foo");
    assert.equal(sanitizeCsvCell('@macro'), "'@macro");
    assert.equal(sanitizeCsvCell('\tindented'), "'\tindented");
    assert.equal(sanitizeCsvCell('\rline'), "'\rline");
  });
  it('leaves safe cells untouched', () => {
    assert.equal(sanitizeCsvCell('plain text'), 'plain text');
    assert.equal(sanitizeCsvCell('123'), '123');
    assert.equal(sanitizeCsvCell(''), '');
    assert.equal(sanitizeCsvCell(null), '');
  });
  it('sanitizes headers as well as cells', () => {
    assert.deepEqual(sanitizeCsvRow(['=name', 'count']), ["'=name", 'count']);
  });
  it('csvCell/csvRow aliases agree', () => {
    assert.equal(csvCell('=x'), "'=x");
    assert.equal(csvRow(['a', '=b']), "a,'=b");
  });
  it('toCsv sanitizes everything', () => {
    const out = toCsv(['=h'], [['=SUM(1)']]);
    assert.match(out, /'=h/);
    assert.match(out, /'=SUM\(1\)/);
  });
});
