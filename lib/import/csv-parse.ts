// SPDX-License-Identifier: MIT
/**
 * lib/import/csv-parse.ts — CSV reader for the metadata import (row 23).
 *
 * RFC 4180 parser: quoted fields, "" escapes, embedded commas / CR / LF
 * inside quotes, CRLF or LF row endings, optional UTF-8 BOM. Hand-rolled
 * (no dependency) in the same spirit as lib/import/zip-extract.ts.
 *
 * Ingest sanitization (B15 counterpart): the exporter prefixes a leading
 * `'` onto cells whose value starts with a formula-dangerous character
 * (lib/export/csv-sanitize.ts). On ingest we strip exactly that one tick
 * back off — `'=x` -> `=x` — so an export -> import round-trip restores
 * the original metadata text instead of accumulating ticks. A cell that
 * genuinely starts with `'` followed by a non-dangerous character is data
 * and is left untouched.
 */

const DANGEROUS_AFTER_TICK = /^[=+\-@\t\r]/;

/** Inverse of sanitizeCsvCell for one parsed cell. */
export function unsanitizeCsvCell(value: string): string {
  if (value.length >= 2 && value[0] === "'" && DANGEROUS_AFTER_TICK.test(value[1])) {
    return value.slice(1);
  }
  return value;
}

/**
 * Parse CSV text into rows of raw string cells (no unsanitizing here —
 * callers decide; the import route unsanitizes headers + values).
 * Throws on an unterminated quoted field.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // CRLF or lone CR both end the row.
      endRow();
      i += src[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    fieldStarted = true;
    i += 1;
  }
  if (inQuotes) throw new Error('unterminated quoted field in CSV');
  // Trailing row without a final newline.
  if (fieldStarted || field !== '' || row.length > 0) endRow();
  // A document ending in a newline yields no phantom row (handled above:
  // row is empty and nothing was started). Drop a fully-empty trailing row
  // produced by a final blank line.
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === '') rows.pop();
    else break;
  }
  return rows;
}
