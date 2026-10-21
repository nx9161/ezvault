// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/import/csv-import.ts — CSV metadata import core (parity row 23).
 *
 * Input: CSV text whose header row names property URIs (the export shape:
 * optional leading `id` / `template` bookkeeping columns are ignored —
 * imported rows always become NEW items under the chosen template).
 * Each remaining column maps to a metadata property; a cell with several
 * values separates them with "; " (the export separator). Ingest runs the
 * B15 unsanitizer (lib/import/csv-parse.ts) so exported formula-guarded
 * cells round-trip to their original text.
 *
 * Job pattern: one import_jobs row (kind 'csv', needs migration 0009)
 * tracks total/done/failed and carries the honest per-row error report.
 * Bad rows are skipped and reported — never silently dropped, never
 * half-imported (each row is its own transaction).
 */

import { randomUUID } from 'node:crypto';
import { sql, tx, bumpRevQuery, type TxQuery } from '@/lib/db/index';
import { parseCsv, unsanitizeCsvCell } from './csv-parse';
import { HttpError } from '@/lib/api/route-utils';
import { CSV_MULTI_VALUE_SEP } from '@/lib/export/csv-export';

export const CSV_IMPORT_MAX_ROWS = 5000;
export const CSV_IMPORT_MAX_COLUMNS = 200;

export interface CsvImportRowError {
  row: number; // 1-based data-row number (header excluded)
  message: string;
}

export interface CsvImportResult {
  job_id: string;
  imported: number;
  failed: number;
  errors: CsvImportRowError[];
  item_ids: string[];
}

interface TemplateFieldLite {
  property_uri?: string;
  datatype?: string;
}

const DEFAULT_DATATYPE = 'http://www.w3.org/2001/XMLSchema#string';

export async function importCsvItems(
  projectId: string,
  csvText: string,
  templateId: string,
): Promise<CsvImportResult> {
  const tpl = await sql()`SELECT id, fields FROM templates WHERE id = ${templateId} AND project_id = ${projectId}`;
  if (!tpl.length) {
    throw new HttpError(400, 'validation', 'template not found in this project');
  }
  const fields = Array.isArray(tpl[0]['fields']) ? (tpl[0]['fields'] as TemplateFieldLite[]) : [];
  const datatypeByUri = new Map<string, string>();
  for (const f of fields) {
    if (f.property_uri) datatypeByUri.set(f.property_uri, f.datatype || DEFAULT_DATATYPE);
  }

  let parsed: string[][];
  try {
    parsed = parseCsv(csvText);
  } catch (err) {
    throw new HttpError(400, 'validation', `CSV parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed.length) {
    throw new HttpError(400, 'validation', 'CSV is empty');
  }

  const headers = parsed[0].map((h) => unsanitizeCsvCell(h.trim()));
  if (headers.length > CSV_IMPORT_MAX_COLUMNS) {
    throw new HttpError(400, 'validation', `too many columns (max ${CSV_IMPORT_MAX_COLUMNS})`);
  }
  // Column plan: index -> property URI (bookkeeping columns skipped).
  const columns: { index: number; uri: string }[] = [];
  const seenUris = new Set<string>();
  headers.forEach((h, index) => {
    if (!h || h === 'id' || h === 'template') return;
    if (seenUris.has(h)) return; // duplicate header: first column wins
    seenUris.add(h);
    columns.push({ index, uri: h });
  });
  if (!columns.length) {
    throw new HttpError(400, 'validation', 'no property-URI columns found in the header row');
  }

  const dataRows = parsed.slice(1);
  if (dataRows.length > CSV_IMPORT_MAX_ROWS) {
    throw new HttpError(400, 'validation', `too many rows (max ${CSV_IMPORT_MAX_ROWS})`);
  }

  const jobId = randomUUID();
  await sql()`INSERT INTO import_jobs (id, project_id, kind, status, total)
    VALUES (${jobId}, ${projectId}, 'csv', 'running', ${dataRows.length})`;

  const errors: CsvImportRowError[] = [];
  const itemIds: string[] = [];
  let imported = 0;

  const qq = (text: string, params?: unknown[]): TxQuery => ({ text, params });
  for (const [r, cells] of dataRows.entries()) {
    const rowNo = r + 1;
    if (cells.length > headers.length) {
      errors.push({
        row: rowNo,
        message: `row has ${cells.length} cells but the header has ${headers.length} columns`,
      });
      continue;
    }
    // Collect values; a row with no values at all is reported, not imported.
    const values: { uri: string; datatype: string; text: string }[] = [];
    for (const col of columns) {
      const raw = unsanitizeCsvCell(cells[col.index] ?? '');
      if (!raw.trim()) continue;
      for (const part of raw.split(CSV_MULTI_VALUE_SEP)) {
        const text = part.trim();
        if (text) values.push({ uri: col.uri, datatype: datatypeByUri.get(col.uri) ?? DEFAULT_DATATYPE, text });
      }
    }
    if (!values.length) {
      errors.push({ row: rowNo, message: 'row has no metadata values' });
      continue;
    }
    const itemId = randomUUID();
    try {
      await tx(() => {
        const queries = [
          qq(`INSERT INTO subjects (id, project_id, kind, template_id) VALUES ($1,$2,'item',$3)`, [itemId, projectId, templateId]),
          qq(`INSERT INTO items (subject_id) VALUES ($1)`, [itemId]),
        ];
        for (const v of values) {
          const valueId = randomUUID();
          queries.push(qq(`INSERT INTO metadata_values (value_id, datatype, text) VALUES ($1,$2,$3)`,
            [valueId, v.datatype, v.text.slice(0, 100000)]));
          queries.push(qq(`INSERT INTO metadata (subject_id, property_uri, value_id) VALUES ($1,$2,$3)`,
            [itemId, v.uri, valueId]));
        }
        queries.push(bumpRevQuery(projectId));
        return queries;
      });
      imported += 1;
      itemIds.push(itemId);
    } catch (err) {
      errors.push({ row: rowNo, message: err instanceof Error ? err.message : 'database error' });
    }
  }

  const report = { imported, failed: errors.length, errors: errors.slice(0, 200) };
  await sql()`UPDATE import_jobs SET status = 'done', done = ${imported}, failed = ${errors.length},
      report = ${JSON.stringify(report)}::jsonb, updated_at = now() WHERE id = ${jobId}`;

  return { job_id: jobId, imported, failed: errors.length, errors: report.errors, item_ids: itemIds };
}
