// SPDX-License-Identifier: MIT
/**
 * lib/export/csv-sanitize.ts — CSV formula-injection guard (B15).
 *
 * For every cell AND header: if the string starts with `=`, `+`, `-`, `@`,
 * `\t`, or `\r`, prepend a single quote `'`. Double-quote field wrapping is
 * kept — quoting alone does NOT stop Excel; the `'` prefix is the defense
 * (inert in Sheets/LibreOffice too).
 *
 * Applied to: v1 `.tpy` import report CSV (conflicts/duplicates carry
 * untrusted filenames/metadata); wave-2 export CSV by design.
 */

const DANGEROUS_START = /^[=+\-@\t\r]/;

/** Sanitize one cell value (or header). Returns the safe string. */
export function sanitizeCsvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return DANGEROUS_START.test(s) ? `'${s}` : s;
}

/** Sanitize a full row (cells AND headers go through this). */
export function sanitizeCsvRow(cells: readonly unknown[]): string[] {
  return cells.map(sanitizeCsvCell);
}

function quoteField(s: string): string {
  // Quote when the field contains a comma, quote, or newline (or the added
  // tick — harmless either way). Quoting is structural, not the defense.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Build a CSV document: headers + rows, all sanitized + quoted. */
export function toCsv(headers: readonly unknown[], rows: readonly (readonly unknown[])[]): string {
  const lines = [sanitizeCsvRow(headers).map(quoteField).join(',')];
  for (const row of rows) lines.push(sanitizeCsvRow(row).map(quoteField).join(','));
  return lines.join('\r\n') + '\r\n';
}
