// SPDX-License-Identifier: MIT
/**
 * lib/export/csv-export.ts — item metadata CSV export (parity row 23).
 *
 * Shape (Tropy CSV-plugin parity, clean-room): one row per item; the header
 * is the union of the exported items' template property URIs (template field
 * order first, then any non-template properties sorted), preceded by two
 * bookkeeping columns: the item id and its template URI. A property with
 * several values is joined with "; " (the import side splits on the same
 * separator — see lib/import/csv-parse.ts). All cells pass through the B15
 * formula-injection sanitizer via toCsv (lib/export/csv-sanitize.ts).
 *
 * Pure module (no DB / no server-only) so the shape is unit-testable and the
 * route stays a thin loader.
 */

import { toCsv } from './csv-sanitize';

export interface CsvTemplateField {
  property_uri: string;
  order?: number;
}

export interface CsvItemData {
  id: string;
  templateUri: string | null;
  /** template fields for this item's template (may be empty) */
  templateFields: readonly CsvTemplateField[];
  /** property_uri -> values in stored order */
  metadata: ReadonlyMap<string, readonly string[]>;
}

export const CSV_MULTI_VALUE_SEP = '; ';

/** Ordered union of property URIs across the exported items. */
export function csvColumns(items: readonly CsvItemData[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const extras = new Set<string>();
  for (const item of items) {
    const fields = [...item.templateFields].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0),
    );
    for (const f of fields) {
      if (!seen.has(f.property_uri)) {
        seen.add(f.property_uri);
        ordered.push(f.property_uri);
      }
    }
  }
  for (const item of items) {
    for (const uri of item.metadata.keys()) {
      if (!seen.has(uri)) extras.add(uri);
    }
  }
  return [...ordered, ...[...extras].sort()];
}

/** Build the CSV document for a set of items (already in export order). */
export function buildItemsCsv(items: readonly CsvItemData[]): string {
  const columns = csvColumns(items);
  const headers = ['id', 'template', ...columns];
  const rows = items.map((item) => [
    item.id,
    item.templateUri ?? '',
    ...columns.map((uri) => (item.metadata.get(uri) ?? []).join(CSV_MULTI_VALUE_SEP)),
  ]);
  return toCsv(headers, rows);
}
