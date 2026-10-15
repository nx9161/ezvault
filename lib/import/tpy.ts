// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/import/tpy.ts — .tpy (Tropy SQLite) import wizard core (phase2 §6.2).
 *
 * Table mapping verified against a real .tpy (DHUM_Project.tpy, 2026-10-14):
 *   subjects(id, template, type) — type is NULL; kind derived by presence
 *   items(id -> subjects)
 *   photos(id PK -> images.id, item_id, position, path, protocol, mimetype,
 *          checksum=md5, orientation, metadata JSON, size, page, color,
 *          density, filename)
 *   images(id -> subjects.id, width/height/angle/mirror/brightness/contrast/
 *          hue/saturation/negative/sharpen)
 *   selections(id -> images.id, photo_id, x, y, position) + own images row
 *          carries the selection's width/height
 *   notes(note_id, id -> subjects, text, state=ProseMirror JSON, language, deleted)
 *   tags(tag_id, name COLLATE NOCASE, color) + taggings(tag_id, id -> subjects)
 *   lists(list_id, name, parent_list_id, position) + list_items(list_id, id -> items)
 *   trash(id -> subjects, deleted, reason in user/auto/merge)
 *   metadata(id -> subjects, property, value_id, language) + metadata_values
 *   deleted_photos(path, checksum) — audit rows
 *
 * Schema facts (table/column names) are functional interop facts (GC §5.4);
 * zero Tropy code is reused — this importer is original.
 *
 * Gates: B8 (assets.zip via ./zip-extract), B9 (100MB ceiling + RSS guard),
 * B13 (per-note try/catch + link sanitizer BEFORE storage), B15 (report CSV),
 * B24 (unknown tables/columns -> raw JSON, never dropped).
 */

import { randomUUID, createHash } from 'node:crypto';
import { getStorageDriver, keys, extForMimetype } from '../storage/driver';
import { sql, tx, bumpRevQuery, bumpCountersQuery, type TxQuery } from '../db/index';
import { sanitizeTiptapDoc } from '../notes/sanitize';
import { tiptapToText } from '../export/jsonld.js';
import { processPhoto } from './process-photo';
import { detectFormat, mimetypeForFormat } from './magic';
import { isAllowedUploadMimetype, stagedExtension, TPY_MAX_BYTES, TPY_HARD_MAX_BYTES } from './validation';
import { checkCpuGuard } from '../cpu-budget';
import { HttpError } from '../api/route-utils';

export const TPY_APPLICATION_ID = -621960955;
export const TPY_PINNED_USER_VERSIONS = [2112312400];
export const SQLITE_MAGIC = 'SQLite format 3\x00';

/** .tpy tables we model; everything else -> unknown (B24). */
const KNOWN_TABLES = new Set([
  'project', 'subjects', 'items', 'photos', 'images', 'selections', 'notes',
  'metadata', 'metadata_values', 'tags', 'taggings', 'lists', 'list_items',
  'trash', 'deleted_photos', 'transcriptions', 'access', 'migrations',
]);

/** Expected columns per known table — extras land in raw_import (B24). */
const EXPECTED_COLUMNS: Record<string, Set<string>> = {
  subjects: new Set(['id', 'template', 'type', 'created', 'modified']),
  items: new Set(['id', 'cover_image_id', 'created', 'modified']),
  photos: new Set(['id', 'item_id', 'position', 'path', 'protocol', 'mimetype', 'checksum', 'orientation', 'metadata', 'size', 'page', 'color', 'density', 'filename', 'created', 'modified']),
  images: new Set(['id', 'width', 'height', 'angle', 'mirror', 'brightness', 'contrast', 'hue', 'saturation', 'negative', 'sharpen']),
  selections: new Set(['id', 'photo_id', 'x', 'y', 'position', 'created', 'modified']),
  notes: new Set(['note_id', 'id', 'text', 'state', 'language', 'created', 'modified', 'deleted']),
  tags: new Set(['tag_id', 'name', 'color', 'created', 'modified']),
  taggings: new Set(['tag_id', 'id', 'created']),
  lists: new Set(['list_id', 'name', 'parent_list_id', 'position', 'created', 'modified']),
  list_items: new Set(['list_id', 'id', 'position', 'added', 'deleted']),
  trash: new Set(['id', 'deleted', 'reason']),
  metadata: new Set(['id', 'property', 'value_id', 'language', 'created']),
  metadata_values: new Set(['value_id', 'datatype', 'text', 'data']),
  deleted_photos: new Set(['path', 'checksum', 'deleted']),
  transcriptions: new Set(['transcription_id', 'id', 'text', 'config', 'data', 'status', 'deleted', 'angle', 'mirror']),
};

// ---------------------------------------------------------------------------
// sql.js loading
// ---------------------------------------------------------------------------

interface SqlJsDb {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  close(): void;
}
interface SqlJsStatic {
  Database: new (data?: Uint8Array) => SqlJsDb;
}

let sqlJsStatic: SqlJsStatic | null = null;

async function getSqlJs(): Promise<SqlJsStatic> {
  if (sqlJsStatic) return sqlJsStatic;
  const { default: initSqlJs } = await import('sql.js');
  let wasmBinary: Uint8Array | null = null;
  const { readFile } = await import('node:fs/promises');
  try {
    const u = new URL('./vendor/sql-wasm.wasm', import.meta.url);
    if (u.protocol === 'file:') wasmBinary = await readFile(u);
  } catch { /* fall through */ }
  if (!wasmBinary) {
    const { join } = await import('node:path');
    wasmBinary = await readFile(join(process.cwd(), 'lib', 'import', 'vendor', 'sql-wasm.wasm'));
  }
  sqlJsStatic = (await initSqlJs({ wasmBinary })) as unknown as SqlJsStatic;
  return sqlJsStatic;
}

function rowsOf(db: SqlJsDb, table: string): Record<string, unknown>[] {
  let res;
  try {
    res = db.exec(`SELECT * FROM "${table}"`);
  } catch {
    return [];
  }
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((row) => Object.fromEntries(row.map((v, i) => [columns[i], v])));
}

/** Split a row into {known, unknown} by the expected-column set (B24). */
function splitRow(table: string, row: Record<string, unknown>): { known: Record<string, unknown>; unknown: Record<string, unknown> } {
  const expected = EXPECTED_COLUMNS[table];
  const known: Record<string, unknown> = {};
  const unknown: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!expected || expected.has(k)) known[k] = v;
    else unknown[k] = v;
  }
  return { known, unknown };
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

export interface TpyAnalyzeReport {
  userVersion: number;
  userVersionWarning: string | null;
  counts: Record<string, number>;
  templateUris: string[];
  unknownTables: string[];
  jsonlKey: string;
  subjectTotal: number;
}

export async function analyzeTpy(jobId: string, stagedKey: string): Promise<TpyAnalyzeReport> {
  const storage = await getStorageDriver();
  const head = await storage.head(stagedKey);
  if (!head) throw new HttpError(404, 'not_found', 'staged .tpy not found');
  // B9: default 100MB ceiling (measured-safe); absolute hard ceiling 250MB.
  if (head.size > TPY_HARD_MAX_BYTES) {
    throw new HttpError(413, 'tpy_too_large', `tpy exceeds the absolute ${TPY_HARD_MAX_BYTES}-byte ceiling`);
  }
  if (head.size > TPY_MAX_BYTES) {
    throw new HttpError(
      413, 'tpy_too_large',
      `tpy is ${(head.size / 1048576).toFixed(1)}MB; the measured-safe ceiling is ${TPY_MAX_BYTES / 1048576}MB (B9)`,
    );
  }
  // B9: RSS guard before sql.js open (whole DB lands in WASM memory).
  const rss = process.memoryUsage().rss;
  if (rss + head.size * 4 > 950 * 1024 * 1024) {
    throw new HttpError(413, 'tpy_too_large', 'insufficient function memory headroom for this .tpy (RSS guard)');
  }

  const bytes = await storage.getBytes(stagedKey);
  // SQLite magic re-verified server-side (the WASM parse is the real
  // validator per AppSec §1.5).
  if (bytes.subarray(0, 16).toString('binary') !== SQLITE_MAGIC) {
    throw new HttpError(422, 'not_sqlite', 'staged file is not a SQLite database');
  }

  const SQL = await getSqlJs();
  const db = new SQL.Database(bytes);
  try {
    const appId = db.exec('PRAGMA application_id')[0]?.values[0]?.[0];
    if (Number(appId) !== TPY_APPLICATION_ID) {
      throw new HttpError(422, 'not_tropy', `application_id ${appId} is not a Tropy project (expected ${TPY_APPLICATION_ID})`);
    }
    const userVersion = Number(db.exec('PRAGMA user_version')[0]?.values[0]?.[0] ?? 0);
    const userVersionWarning = TPY_PINNED_USER_VERSIONS.includes(userVersion)
      ? null
      : `user_version ${userVersion} is not the pinned ${TPY_PINNED_USER_VERSIONS.join(',')}; best-effort import with skipped-table flags`;

    const tableRows = db.exec(`SELECT name FROM sqlite_master WHERE type='table'`);
    const tables: string[] = tableRows.length ? (tableRows[0].values.map((v) => String(v[0]))) : [];
    const unknownTables = tables.filter(
      (t) => !KNOWN_TABLES.has(t) && !t.startsWith('fts_') && !t.startsWith('sqlite_'),
    );

    const data: Record<string, Record<string, unknown>[]> = {};
    const counts: Record<string, number> = {};
    for (const t of tables) {
      if (t.startsWith('fts_') || t.startsWith('sqlite_')) continue;
      data[t] = rowsOf(db, t);
      counts[t] = data[t].length;
    }

    const subjects = data['subjects'] ?? [];
    const items = new Map((data['items'] ?? []).map((r) => [Number(r['id']), r]));
    const photos = new Map((data['photos'] ?? []).map((r) => [Number(r['id']), r]));
    const selections = new Map((data['selections'] ?? []).map((r) => [Number(r['id']), r]));
    const images = new Map((data['images'] ?? []).map((r) => [Number(r['id']), r]));
    const notesBySubject = new Map<number, Record<string, unknown>[]>();
    for (const n of data['notes'] ?? []) {
      const sid = Number(n['id']);
      if (!notesBySubject.has(sid)) notesBySubject.set(sid, []);
      notesBySubject.get(sid)!.push(n);
    }
    const metaBySubject = new Map<number, { property: string; datatype: string; text: string; data: string | null; language: string | null; unknown: Record<string, unknown> }[]>();
    const valuesById = new Map((data['metadata_values'] ?? []).map((r) => [Number(r['value_id']), r]));
    for (const m of data['metadata'] ?? []) {
      const sid = Number(m['id']);
      const v = valuesById.get(Number(m['value_id']));
      if (!v) continue;
      if (!metaBySubject.has(sid)) metaBySubject.set(sid, []);
      const { unknown } = splitRow('metadata', m as Record<string, unknown>);
      metaBySubject.get(sid)!.push({
        property: String(m['property']),
        datatype: String(v['datatype'] ?? ''),
        text: String(v['text'] ?? ''),
        data: v['data'] != null ? String(v['data']) : null,
        language: m['language'] != null ? String(m['language']) : null,
        unknown,
      });
    }
    const tagsById = new Map((data['tags'] ?? []).map((r) => [Number(r['tag_id']), r]));
    const tagsBySubject = new Map<number, Record<string, unknown>[]>();
    for (const tg of data['taggings'] ?? []) {
      const tag = tagsById.get(Number(tg['tag_id']));
      if (!tag) continue;
      const sid = Number(tg['id']);
      if (!tagsBySubject.has(sid)) tagsBySubject.set(sid, []);
      tagsBySubject.get(sid)!.push(tag);
    }
    const trashById = new Map((data['trash'] ?? []).map((r) => [Number(r['id']), r]));

    const templateUris = [...new Set(subjects.map((s) => String(s['template'] ?? '')))].filter(Boolean);

    const lines: string[] = [];
    lines.push(JSON.stringify({
      _header: true,
      user_version: userVersion,
      counts,
      template_uris: templateUris,
      unknown_tables: unknownTables,
    }));

    let subjectTotal = 0;
    for (const s of subjects) {
      const tpyId = Number(s['id']);
      const kind = items.has(tpyId) ? 'item' : photos.has(tpyId) ? 'photo' : selections.has(tpyId) ? 'selection' : null;
      if (!kind) continue; // orphan subject row — counted in the header, not imported
      const { unknown: subjectUnknown } = splitRow('subjects', s as Record<string, unknown>);
      const raw: Record<string, unknown> = {};
      if (Object.keys(subjectUnknown).length) raw['subjects'] = subjectUnknown;

      const line: Record<string, unknown> = {
        tpy_id: tpyId,
        kind,
        template_uri: String(s['template'] ?? ''),
      };

      if (kind === 'item') {
        const it = items.get(tpyId)!;
        const { unknown } = splitRow('items', it as Record<string, unknown>);
        if (Object.keys(unknown).length) raw['items'] = unknown;
        line['cover_tpy_image_id'] = it['cover_image_id'] ?? null;
      }
      if (kind === 'photo' || kind === 'selection') {
        const img = images.get(tpyId);
        if (img) {
          const { known, unknown } = splitRow('images', img as Record<string, unknown>);
          line['image'] = {
            width: Number(known['width'] ?? 0),
            height: Number(known['height'] ?? 0),
            angle: Number(known['angle'] ?? 0),
            mirror: known['mirror'] === 1 || known['mirror'] === true,
            brightness: Number(known['brightness'] ?? 0),
            contrast: Number(known['contrast'] ?? 0),
            hue: Number(known['hue'] ?? 0),
            saturation: Number(known['saturation'] ?? 0),
            negative: known['negative'] === 1 || known['negative'] === true,
            sharpen: Number(known['sharpen'] ?? 0),
          };
          if (Object.keys(unknown).length) raw['images'] = unknown;
        }
      }
      if (kind === 'photo') {
        const ph = photos.get(tpyId)!;
        const { known, unknown } = splitRow('photos', ph as Record<string, unknown>);
        let inlineMeta: Record<string, unknown> = {};
        try {
          inlineMeta = known['metadata'] ? JSON.parse(String(known['metadata'])) : {};
        } catch { inlineMeta = {}; }
        line['photo'] = {
          item_tpy_id: Number(known['item_id']),
          position: Number(known['position'] ?? 0),
          path: String(known['path'] ?? ''),
          protocol: String(known['protocol'] ?? 'file'),
          mimetype: String(known['mimetype'] ?? ''),
          md5: String(known['checksum'] ?? ''),
          size: Number(known['size'] ?? 0),
          page: Number(known['page'] ?? 0),
          density: known['density'] != null ? Number(known['density']) : null,
          filename: String(known['filename'] ?? known['path'] ?? ''),
          inline_metadata: inlineMeta,
        };
        if (Object.keys(unknown).length) raw['photos'] = unknown;
      }
      if (kind === 'selection') {
        const sel = selections.get(tpyId)!;
        const { known, unknown } = splitRow('selections', sel as Record<string, unknown>);
        line['selection'] = {
          photo_tpy_id: Number(known['photo_id']),
          x: Number(known['x'] ?? 0),
          y: Number(known['y'] ?? 0),
          // width/height mapped from the selection's own images row (§6.2.4)
          width: Number((line['image'] as Record<string, number> | undefined)?.width ?? 0),
          height: Number((line['image'] as Record<string, number> | undefined)?.height ?? 0),
          position: Number(known['position'] ?? 0),
        };
        if (Object.keys(unknown).length) raw['selections'] = unknown;
      }

      // Notes: raw state kept for the run phase (sanitized there, per-note try/catch).
      line['notes'] = (notesBySubject.get(tpyId) ?? []).map((n) => {
        const { known, unknown } = splitRow('notes', n as Record<string, unknown>);
        return {
          note_tpy_id: Number(known['note_id']),
          text: String(known['text'] ?? ''),
          state: String(known['state'] ?? ''),
          language: known['language'] != null ? String(known['language']) : null,
          deleted: known['deleted'] != null,
          unknown,
        };
      });
      line['metadata'] = metaBySubject.get(tpyId) ?? [];
      line['tags'] = (tagsBySubject.get(tpyId) ?? []).map((t) => ({
        name: String(t['name'] ?? ''),
        color: t['color'] != null ? String(t['color']) : null,
      }));
      const tr = trashById.get(tpyId);
      if (tr) line['trash'] = { reason: String(tr['reason'] ?? 'user') };
      if (Object.keys(raw).length) line['raw'] = raw;

      lines.push(JSON.stringify(line));
      subjectTotal++;
    }

    // Lists sidecar (project-level; consumed by the run phase after items map).
    const listRows = (data['lists'] ?? []).map((l) => {
      const { known, unknown } = splitRow('lists', l as Record<string, unknown>);
      return {
        tpy_id: Number(known['list_id']),
        name: String(known['name'] ?? ''),
        parent_tpy_id: known['parent_list_id'] != null && Number(known['parent_list_id']) !== 0
          ? Number(known['parent_list_id']) : null,
        position: Number(known['position'] ?? 0),
        unknown,
      };
    });
    const listItemRows = (data['list_items'] ?? [])
      .filter((li) => li['deleted'] == null)
      .map((li) => {
        const { known } = splitRow('list_items', li as Record<string, unknown>);
        return {
          list_tpy_id: Number(known['list_id']),
          item_tpy_id: Number(known['id']),
          position: Number(known['position'] ?? 0),
        };
      });
    await storage.putBytes(
      keys.tpyStaging(jobId, 'lists.json'),
      Buffer.from(JSON.stringify({ lists: listRows, list_items: listItemRows }), 'utf8'),
      { contentType: 'application/json' },
    );

    // Unknown tables: persisted to staging (never dropped, B24) + reported.
    const unknownDump: Record<string, unknown> = {};
    for (const t of unknownTables) unknownDump[t] = data[t];
    if (unknownTables.length) {
      await storage.putBytes(keys.tpyStaging(jobId, 'unknown-tables.json'),
        Buffer.from(JSON.stringify(unknownDump).slice(0, 5_000_000), 'utf8'),
        { contentType: 'application/json' });
    }

    const jsonlKey = keys.tpyStaging(jobId, 'import.jsonl');
    await storage.putBytes(jsonlKey, Buffer.from(lines.join('\n'), 'utf8'), { contentType: 'application/jsonl' });

    return {
      userVersion,
      userVersionWarning,
      counts,
      templateUris,
      unknownTables,
      jsonlKey,
      subjectTotal,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export interface TpyRunOptions {
  mode: 'standard' | 'advanced';
  duplicatePolicy: 'skip' | 'keep_both' | 'ask';
  /** template URI -> 'use_existing' | 'create_new' */
  templateMap?: Record<string, 'use_existing' | 'create_new'>;
  /** Standard mode: tpy photo id -> staged asset key (from assets.zip extraction). */
  assetKeys?: Record<string, string>;
  /** HEIC browser-conversion artifacts: tpy photo id -> staged JPEG key. */
  conversions?: Record<string, string>;
  /** Max subjects to process this call (resume via checkpoint). */
  limit?: number;
}

export interface TpyConflict {
  tpy_id: number | string;
  kind: string;
  reason: string;
  detail?: string;
}

export interface TpyRunResult {
  processed: number;
  imported: Record<string, number>;
  conflicts: TpyConflict[];
  done: boolean;
}

const CHUNK_SUBJECTS = 50; // 50 items/txn (ADR-2.6)
const KIND_ORDER = { item: 0, photo: 1, selection: 2 } as const;

interface NormalizedSubject {
  tpy_id: number;
  kind: 'item' | 'photo' | 'selection';
  template_uri: string;
  cover_tpy_image_id?: number | null;
  image?: { width: number; height: number; angle: number; mirror: boolean; brightness: number; contrast: number; hue: number; saturation: number; negative: boolean; sharpen: number };
  photo?: { item_tpy_id: number; position: number; path: string; protocol: string; mimetype: string; md5: string; size: number; page: number; density: number | null; filename: string; inline_metadata: Record<string, unknown> };
  selection?: { photo_tpy_id: number; x: number; y: number; width: number; height: number; position: number };
  notes: { note_tpy_id: number; text: string; state: string; language: string | null; deleted: boolean; unknown: Record<string, unknown> }[];
  metadata: { property: string; datatype: string; text: string; data: string | null; language: string | null; unknown: Record<string, unknown> }[];
  tags: { name: string; color: string | null }[];
  trash?: { reason: string };
  raw?: Record<string, unknown>;
}

interface ListsSidecar {
  lists: { tpy_id: number; name: string; parent_tpy_id: number | null; position: number; unknown: Record<string, unknown> }[];
  list_items: { list_tpy_id: number; item_tpy_id: number; position: number }[];
}

async function readJsonlSubjects(jsonlKey: string): Promise<NormalizedSubject[]> {
  const storage = await getStorageDriver();
  const buf = await storage.getBytes(jsonlKey);
  const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
  return lines.slice(1).map((l) => JSON.parse(l) as NormalizedSubject);
}

async function readListsSidecar(jobId: string): Promise<ListsSidecar> {
  const storage = await getStorageDriver();
  try {
    const buf = await storage.getBytes(keys.tpyStaging(jobId, 'lists.json'));
    return JSON.parse(buf.toString('utf8')) as ListsSidecar;
  } catch {
    return { lists: [], list_items: [] };
  }
}

function assetBaseName(p: string): string {
  return p.split('/').pop() ?? p;
}

async function makePlaceholderThumb(projectId: string, photoSubjectId: string): Promise<{ key: string; bytes: number }> {
  const storage = await getStorageDriver();
  const { default: sharp } = await import('sharp');
  const buf = await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 42, g: 42, b: 46 } },
  }).webp({ quality: 80 }).toBuffer();
  const key = keys.thumb(projectId, photoSubjectId);
  await storage.putBytes(key, buf, { contentType: 'image/webp' });
  return { key, bytes: buf.length };
}

export async function runTpyImport(
  jobId: string,
  projectId: string,
  opts: TpyRunOptions,
): Promise<TpyRunResult> {
  await checkCpuGuard();
  const storage = await getStorageDriver();
  const subjects = await readJsonlSubjects(keys.tpyStaging(jobId, 'import.jsonl'));

  // Idempotency: already-mapped tpy ids are skipped (resume-from-checkpoint).
  const mappedRows = await sql()`SELECT tpy_subject_id, new_subject_id FROM tpy_import_map WHERE job_id = ${jobId}`;
  const mapped = new Map<string, string>(mappedRows.map((r) => [r.tpy_subject_id as string, r.new_subject_id as string]));
  // Seed item linkage from previous calls: which mapped subjects are items.
  const itemSeed = mapped.size
    ? await sql()`SELECT tim.tpy_subject_id FROM tpy_import_map tim
                  JOIN items i ON i.subject_id = tim.new_subject_id WHERE tim.job_id = ${jobId}`
    : [];

  const newIds = new Map<number, string>([...mapped.entries()].map(([k, v]) => [Number(k), v]));
  const itemNewIds = new Map<number, string>(
    itemSeed.map((r) => [Number(r.tpy_subject_id), mapped.get(r.tpy_subject_id as string)!]),
  );

  // Template resolution cache: uri -> template UUID (or null).
  const tplCache = new Map<string, string | null>();
  async function resolveTemplate(uri: string, observedProps: string[]): Promise<string | null> {
    if (tplCache.has(uri)) return tplCache.get(uri)!;
    const existing = await sql()`SELECT id FROM templates WHERE project_id = ${projectId} AND uri = ${uri} LIMIT 1`;
    if (existing.length) {
      tplCache.set(uri, existing[0].id as string);
      return existing[0].id as string;
    }
    const action = opts.templateMap?.[uri] ?? 'use_existing';
    if (action === 'create_new') {
      const name = uri.split('/').pop()?.split('#').pop() || uri;
      const fields = observedProps.map((p, i) => ({
        property_uri: p,
        label: p.split('/').pop()?.split('#').pop() || p,
        order: i,
      }));
      const created = await sql()`INSERT INTO templates (project_id, name, uri, fields)
        VALUES (${projectId}, ${name}, ${uri}, ${JSON.stringify(fields)}::jsonb) RETURNING id`;
      tplCache.set(uri, created[0].id as string);
      return created[0].id as string;
    }
    tplCache.set(uri, null);
    return null;
  }

  // Tag cache: lower(name) -> id (CITEXT dedupe).
  const tagCache = new Map<string, string>();
  async function resolveTag(name: string, color: string | null): Promise<string> {
    const key = name.trim().toLowerCase();
    if (tagCache.has(key)) return tagCache.get(key)!;
    await sql()`INSERT INTO tags (id, project_id, name, color)
      VALUES (${randomUUID()}, ${projectId}, ${name.trim()}, ${color ?? '#B3541E'})
      ON CONFLICT (project_id, name) DO NOTHING`;
    const row = await sql()`SELECT id FROM tags WHERE project_id = ${projectId} AND name = ${name.trim()} LIMIT 1`;
    const tagId = row[0].id as string;
    tagCache.set(key, tagId);
    return tagId;
  }

  const conflicts: TpyConflict[] = [];
  const imported: Record<string, number> = {
    subjects: 0, items: 0, photos: 0, selections: 0, notes: 0, metadata: 0, tags: 0, lists: 0,
  };

  // Dependency order: items -> photos -> selections (FK-safe within/across chunks).
  const pending = subjects
    .filter((s) => !mapped.has(String(s.tpy_id)))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.tpy_id - b.tpy_id);
  const limit = opts.limit ?? pending.length;
  const batch = pending.slice(0, limit);

  const remapDuplicate = async (tpyId: number, freshId: string, existingId: string, via: string) => {
    // Duplicate-skip: drop the fresh subject, point the tpy id at the
    // canonical existing subject so selections/list_items still resolve.
    await sql()`DELETE FROM subjects WHERE id = ${freshId}`;
    await sql()`INSERT INTO tpy_import_map (job_id, tpy_subject_id, new_subject_id)
      VALUES (${jobId}, ${String(tpyId)}, ${existingId})
      ON CONFLICT (job_id, tpy_subject_id) DO UPDATE SET new_subject_id = EXCLUDED.new_subject_id`;
    newIds.set(tpyId, existingId);
    imported.subjects--;
    imported.photos--;
    conflicts.push({ tpy_id: tpyId, kind: 'photo', reason: 'duplicate_skipped', detail: via });
  };

  for (let c = 0; c < batch.length; c += CHUNK_SUBJECTS) {
    const chunk = batch.slice(c, c + CHUNK_SUBJECTS);
    const queries: TxQuery[] = [];
    const q = (text: string, params?: unknown[]): TxQuery => ({ text, params });
    const photoWork: { subject: NormalizedSubject; newId: string }[] = [];

    for (const s of chunk) {
      const newId = randomUUID();
      newIds.set(s.tpy_id, newId);
      const observedProps = s.metadata.map((m) => m.property);
      const templateId = await resolveTemplate(s.template_uri, observedProps);
      const rawJson = s.raw && Object.keys(s.raw).length ? JSON.stringify(s.raw) : null;

      queries.push(q(
        `INSERT INTO subjects (id, project_id, kind, template_id, raw_import)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [newId, projectId, s.kind, templateId, rawJson],
      ));
      imported.subjects++;

      if (s.kind === 'item') {
        itemNewIds.set(s.tpy_id, newId);
        queries.push(q(`INSERT INTO items (subject_id) VALUES ($1)`, [newId]));
        imported.items++;
      } else if (s.kind === 'photo') {
        const ph = s.photo!;
        const img = s.image;
        const imageId = randomUUID();
        queries.push(q(
          `INSERT INTO images (id, width, height, angle, mirror, brightness, contrast, hue, saturation, negative, sharpen)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [imageId, img?.width ?? 0, img?.height ?? 0, img?.angle ?? 0, img?.mirror ?? false,
            img?.brightness ?? 0, img?.contrast ?? 0, img?.hue ?? 0, img?.saturation ?? 0,
            img?.negative ?? false, img?.sharpen ?? 0],
        ));
        const itemId = itemNewIds.get(ph.item_tpy_id);
        if (!itemId) {
          conflicts.push({ tpy_id: s.tpy_id, kind: 'photo', reason: 'orphan_item', detail: `item tpy id ${ph.item_tpy_id} not imported` });
          continue; // skip the photo row; subject row stays (raw preserved)
        }
        queries.push(q(
          `INSERT INTO photos (subject_id, item_id, image_id, position, r2_key, thumb_r2_key,
             missing_original, original_filename, mimetype, checksum_sha256, tpy_checksum_md5,
             size_bytes, width, height, exif, page, density, keep_original)
           VALUES ($1,$2,$3,$4,NULL,'tpy:pending',true,$5,$6,'',$7,$8,$9,$10,'{}',$11,$12,true)`,
          [newId, itemId, imageId, ph.position, ph.filename.slice(0, 255),
            ph.mimetype || 'application/octet-stream', ph.md5 || null, 0,
            img?.width ?? 0, img?.height ?? 0, ph.page, ph.density],
        ));
        imported.photos++;
        photoWork.push({ subject: s, newId });
      } else if (s.kind === 'selection') {
        const sel = s.selection!;
        const img = s.image;
        const imageId = randomUUID();
        queries.push(q(
          `INSERT INTO images (id, width, height, angle, mirror, brightness, contrast, hue, saturation, negative, sharpen)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [imageId, img?.width ?? 0, img?.height ?? 0, img?.angle ?? 0, false, 0, 0, 0, 0, false, 0],
        ));
        const photoId = newIds.get(sel.photo_tpy_id);
        if (!photoId) {
          conflicts.push({ tpy_id: s.tpy_id, kind: 'selection', reason: 'orphan_photo', detail: `photo tpy id ${sel.photo_tpy_id} not imported` });
          continue;
        }
        queries.push(q(
          `INSERT INTO selections (subject_id, photo_id, name, x, y, width, height, position)
           VALUES ($1,$2,'Selection',$3,$4,$5,$6,$7)`,
          [newId, photoId, Math.round(sel.x), Math.round(sel.y),
            Math.round(sel.width), Math.round(sel.height), sel.position],
        ));
        imported.selections++;
      }

      // Notes: per-note try/catch + sanitizer BEFORE storage (B13).
      for (const n of s.notes) {
        try {
          let state: unknown = {};
          try {
            state = n.state ? JSON.parse(n.state) : {};
          } catch {
            state = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: n.text }] }] };
          }
          const { doc, stripped } = sanitizeTiptapDoc(state);
          if (stripped > 0) {
            conflicts.push({ tpy_id: n.note_tpy_id, kind: 'note', reason: 'link_sanitized', detail: `${stripped} disallowed link(s) stripped` });
          }
          const text = n.text || tiptapToText(doc);
          queries.push(q(
            `INSERT INTO notes (subject_id, text, state, language, deleted_at)
             VALUES ($1,$2,$3::jsonb,$4,$5)`,
            [newId, text.slice(0, 100000), JSON.stringify(doc), n.language, n.deleted ? new Date().toISOString() : null],
          ));
          imported.notes++;
        } catch (err) {
          conflicts.push({ tpy_id: n.note_tpy_id, kind: 'note', reason: 'note_failed', detail: String(err).slice(0, 200) });
        }
      }

      // Metadata (immutable-value semantics: fresh value rows).
      const pushMetadata = (property: string, datatype: string, text: string, language: string | null) => {
        const valueId = randomUUID();
        queries.push(q(
          `INSERT INTO metadata_values (value_id, datatype, text, data) VALUES ($1,$2,$3,NULL)`,
          [valueId, datatype || 'http://www.w3.org/2001/XMLSchema#string', text.slice(0, 10000)],
        ));
        queries.push(q(
          `INSERT INTO metadata (subject_id, property_uri, value_id, language) VALUES ($1,$2,$3,$4)`,
          [newId, property, valueId, language],
        ));
        imported.metadata++;
      };
      for (const m of s.metadata) pushMetadata(m.property, m.datatype, m.text, m.language);
      // Photo inline metadata JSON (photos.metadata column).
      if (s.photo?.inline_metadata) {
        for (const [prop, val] of Object.entries(s.photo.inline_metadata)) {
          if (!prop.includes(':')) continue;
          pushMetadata(prop, 'http://www.w3.org/2001/XMLSchema#string', String(val), null);
        }
      }

      // Tags (CITEXT dedupe).
      for (const t of s.tags) {
        if (!t.name.trim()) continue;
        const tagId = await resolveTag(t.name, t.color);
        queries.push(q(
          `INSERT INTO taggings (tag_id, subject_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [tagId, newId],
        ));
        imported.tags++;
      }

      // Trash.
      if (s.trash) {
        const reason = ['user', 'auto', 'merge'].includes(s.trash.reason) ? s.trash.reason : 'user';
        queries.push(q(`INSERT INTO trash (subject_id, reason) VALUES ($1,$2)`, [newId, reason]));
      }

      // Idempotency map (same txn).
      queries.push(q(
        `INSERT INTO tpy_import_map (job_id, tpy_subject_id, new_subject_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [jobId, String(s.tpy_id), newId],
      ));
    }

    queries.push(bumpRevQuery(projectId));
    await tx(() => queries);

    // Photo asset phase (outside the metadata txn; per-photo, CPU-charged).
    for (const { subject: s, newId } of photoWork) {
      await importTpyPhotoAsset(jobId, projectId, s, newId, opts, conflicts, imported, newIds, remapDuplicate);
    }

    await sql()`UPDATE import_jobs SET checkpoint = ${JSON.stringify({ subjects_done: c + chunk.length })}::jsonb,
      done = done + ${chunk.length}, updated_at = now() WHERE id = ${jobId}`;
  }

  // Lists (project-level; items are all mapped by now).
  await importTpyLists(jobId, projectId, conflicts, imported, newIds, itemNewIds);

  const done = pending.length <= limit;
  if (done) {
    await sql()`UPDATE import_jobs SET status = 'done', updated_at = now() WHERE id = ${jobId}`;
  }
  return { processed: batch.length, imported, conflicts, done };
}

/** Project-level lists + list_items from the analyze sidecar. */
async function importTpyLists(
  jobId: string,
  projectId: string,
  conflicts: TpyConflict[],
  imported: Record<string, number>,
  newIds: Map<number, string>,
  itemNewIds: Map<number, string>,
): Promise<void> {
  const sidecar = await readListsSidecar(jobId);
  if (!sidecar.lists.length) return;
  const listIdMap = new Map<number, string>();
  // Parents before children (iterative depth resolution).
  const remaining = [...sidecar.lists];
  let guard = remaining.length + 1;
  while (remaining.length && guard-- > 0) {
    const li = remaining.shift()!;
    if (li.parent_tpy_id != null && !listIdMap.has(li.parent_tpy_id)) {
      remaining.push(li);
      continue;
    }
    const id = randomUUID();
    const parentId = li.parent_tpy_id != null ? listIdMap.get(li.parent_tpy_id)! : null;
    try {
      await sql()`INSERT INTO lists (id, project_id, name, parent_list_id, position)
        VALUES (${id}, ${projectId}, ${li.name}, ${parentId}, ${li.position})`;
      listIdMap.set(li.tpy_id, id);
      imported.lists++;
    } catch (err) {
      conflicts.push({ tpy_id: li.tpy_id, kind: 'list', reason: 'list_failed', detail: String(err).slice(0, 200) });
    }
  }
  for (const li of sidecar.list_items) {
    const listId = listIdMap.get(li.list_tpy_id);
    const itemId = itemNewIds.get(li.item_tpy_id) ?? newIds.get(li.item_tpy_id);
    if (!listId || !itemId) {
      conflicts.push({ tpy_id: li.list_tpy_id, kind: 'list_item', reason: 'unresolved', detail: `list ${li.list_tpy_id} / item ${li.item_tpy_id}` });
      continue;
    }
    await sql()`INSERT INTO list_items (list_id, item_id, position)
      VALUES (${listId}, ${itemId}, ${li.position}) ON CONFLICT DO NOTHING`;
  }
  await tx((q) => [bumpRevQuery(projectId)]);
}

/** Asset handling for one imported photo (Standard vs Advanced, B8). */
async function importTpyPhotoAsset(
  jobId: string,
  projectId: string,
  s: NormalizedSubject,
  newId: string,
  opts: TpyRunOptions,
  conflicts: TpyConflict[],
  imported: Record<string, number>,
  newIds: Map<number, string>,
  remapDuplicate: (tpyId: number, freshId: string, existingId: string, via: string) => Promise<void>,
): Promise<void> {
  const ph = s.photo!;
  const storage = await getStorageDriver();

  // Duplicate detection: md5 first, then sha256 (phase2 §6.2.3).
  if (ph.md5 && opts.duplicatePolicy !== 'keep_both') {
    const dup = await sql()`SELECT p.subject_id FROM photos p JOIN subjects sb ON sb.id = p.subject_id
      WHERE sb.project_id = ${projectId} AND p.tpy_checksum_md5 = ${ph.md5} LIMIT 1`;
    if (dup.length) {
      if (opts.duplicatePolicy === 'skip') {
        await remapDuplicate(s.tpy_id, newId, dup[0].subject_id as string, `md5 ${ph.md5}`);
        return;
      }
      conflicts.push({ tpy_id: s.tpy_id, kind: 'photo', reason: 'duplicate_ask', detail: `md5 ${ph.md5} already imported` });
    }
  }

  const isHeic = /heic|heif/i.test(ph.mimetype) || /\.heic|\.heif/i.test(ph.path);
  const conversionKey = opts.conversions?.[String(s.tpy_id)];

  const placeholder = async (reason: string, detail: string) => {
    const { key, bytes } = await makePlaceholderThumb(projectId, newId);
    await tx((q) => [
      q(`UPDATE photos SET thumb_r2_key = $2 WHERE subject_id = $1`, [newId, key]),
      bumpCountersQuery(projectId, { thumbs: bytes }),
      bumpRevQuery(projectId),
    ]);
    conflicts.push({ tpy_id: s.tpy_id, kind: 'photo', reason, detail });
  };

  // Advanced mode without a conversion: named placeholder, re-link later.
  if (opts.mode === 'advanced' && !conversionKey) {
    await placeholder('missing_original', ph.path);
    return;
  }

  // Standard mode: locate the asset bytes.
  let assetKey: string | undefined = opts.assetKeys?.[String(s.tpy_id)];
  if (!assetKey && ph.path) {
    const candidate = keys.tpyStaging(jobId, `assets/${assetBaseName(ph.path)}`);
    if (await storage.head(candidate)) assetKey = candidate;
    else {
      const candidate2 = keys.tpyStaging(jobId, ph.path.replace(/^[/\\]+/, ''));
      if (await storage.head(candidate2)) assetKey = candidate2;
    }
  }
  if (!assetKey) {
    await placeholder('asset_missing', ph.path);
    return;
  }

  // HEIC without a browser conversion -> placeholder + conflict (ADR-2.16:
  // server cannot decode HEVC; the wizard must supply conversions).
  if (isHeic && !conversionKey) {
    await placeholder('heic_needs_conversion', `${ph.filename}: supply a browser-converted JPEG via resolve-missing`);
    return;
  }

  // Stage the asset into uploads/ and reuse the hardened process pipeline.
  const stagedKey = keys.upload(jobId, randomUUID(), stagedExtension(ph.mimetype || 'image/jpeg'));
  const assetBytes = await storage.getBytes(assetKey);
  await storage.putBytes(stagedKey, assetBytes, { contentType: ph.mimetype || 'image/jpeg' });

  const probe = assetBytes.subarray(0, 16384);
  const detected = detectFormat(probe);
  const sha256 = createHash('sha256').update(assetBytes).digest('hex');

  // sha256 dedupe second pass.
  if (opts.duplicatePolicy === 'skip') {
    const dup = await sql()`SELECT p.subject_id FROM photos p JOIN subjects sb ON sb.id = p.subject_id
      WHERE sb.project_id = ${projectId} AND p.checksum_sha256 = ${sha256} AND p.subject_id != ${newId} LIMIT 1`;
    if (dup.length) {
      await storage.delete(stagedKey).catch(() => {});
      await remapDuplicate(s.tpy_id, newId, dup[0].subject_id as string, `sha256 ${sha256.slice(0, 12)}...`);
      return;
    }
  }

  try {
    await processPhoto({
      projectId,
      jobId,
      stagedKey,
      artifactKey: conversionKey,
      photoSubjectId: newId,
      originalFilename: assetBaseName(ph.filename || ph.path),
      mimetype: ph.mimetype && isAllowedUploadMimetype(ph.mimetype)
        ? ph.mimetype
        : (detected ? mimetypeForFormat(detected) : 'image/jpeg'),
      checksumSha256: sha256,
    });
    // Finalize the tpy linkage: md5 recorded, placeholder flags cleared.
    await sql()`UPDATE photos SET tpy_checksum_md5 = ${ph.md5 || null}, missing_original = false WHERE subject_id = ${newId}`;
    void newIds;
  } catch (err) {
    conflicts.push({ tpy_id: s.tpy_id, kind: 'photo', reason: 'process_failed', detail: String(err).slice(0, 200) });
    await sql()`UPDATE import_jobs SET failed = failed + 1, updated_at = now() WHERE id = ${jobId}`;
  }
}
