// SPDX-License-Identifier: MIT
import 'server-only';
/**
 * lib/api/transcriptions.ts — Wave C (rows 13/14): transcription CRUD.
 *
 * Transcriptions attach to IMAGES (transcriptions.image_id FK), while the
 * API is photo-addressed: every handler resolves photo subject -> photos
 * .image_id first (project-scoped; a photo in another project 404s).
 * Soft-delete only (deleted_at), mirroring notes. The search trigger
 * (migration 0010) keeps search_documents in sync on every write.
 */

import { handle, ok, parseJson, parseCappedJson, pagination, nextCursor, requireProject, HttpError } from '@/lib/api/route-utils';
import { requirePluginEnabled } from '@/lib/plugins/server';
import { sql, tx, bumpRevQuery, queryRaw } from '@/lib/db/index';
import { getStorageDriver, keys } from '@/lib/storage/driver';
import { idempotentCreate, readStashedResult, resolveClientOpId } from '@/lib/api/idempotency';
import { parseAlto, AltoParseError } from '@/lib/transcription/alto';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_TEXT_CHARS = 200_000;
const MAX_WORDS = 20_000;

export interface PhotoImageRef {
  image_id: string;
  width: number;
  height: number;
  angle: number;
  mirror: boolean;
}

/** Resolve a photo subject to its image row (project-scoped). */
export async function requirePhotoImage(projectId: string, photoId: string): Promise<PhotoImageRef> {
  const rows = await sql()`SELECT p.image_id, p.width, p.height, i.angle, i.mirror
    FROM photos p
    JOIN subjects s ON s.id = p.subject_id
    JOIN images i ON i.id = p.image_id
    WHERE s.project_id = ${projectId} AND p.subject_id = ${photoId}`;
  if (!rows.length) throw new HttpError(404, 'not_found', 'photo not found');
  const r = rows[0];
  return {
    image_id: r['image_id'] as string,
    width: Number(r['width']),
    height: Number(r['height']),
    angle: Number(r['angle']),
    mirror: Boolean(r['mirror']),
  };
}

function rowToJson(r: Record<string, unknown>) {
  return {
    id: r['id'] as string,
    photo_id: r['photo_id'] as string,
    image_id: r['image_id'] as string,
    project_id: r['project_id'] as string,
    text: r['text'] as string,
    alto_r2_key: r['alto_r2_key'] as string | null,
    config: (r['config'] ?? {}) as Record<string, unknown>,
    status: r['status'] as string,
    angle: Number(r['angle']),
    mirror: Boolean(r['mirror']),
    words: (r['words'] ?? []) as unknown[],
    page_width: r['page_width'] != null ? Number(r['page_width']) : null,
    page_height: r['page_height'] != null ? Number(r['page_height']) : null,
    created_at: r['created_at'] as string,
    updated_at: r['updated_at'] as string,
  };
}

const SELECT = `
  SELECT t.id, t.image_id, t.text, t.alto_r2_key, t.config, t.status,
         t.angle, t.mirror, t.words, t.page_width, t.page_height,
         t.created_at, t.updated_at,
         (SELECT p.subject_id FROM photos p WHERE p.image_id = t.image_id LIMIT 1) AS photo_id,
         (SELECT s.project_id FROM photos p JOIN subjects s ON s.id = p.subject_id
          WHERE p.image_id = t.image_id LIMIT 1) AS project_id
  FROM transcriptions t`;

export async function getTranscriptionJson(projectId: string, transcriptionId: string) {
  const found = await queryRaw<Record<string, unknown>>(
    `${SELECT} WHERE t.id = $1 AND t.deleted_at IS NULL`, [transcriptionId]);
  if (!found.length || found[0]['project_id'] !== projectId) {
    throw new HttpError(404, 'not_found', 'transcription not found');
  }
  return rowToJson(found[0]);
}

// --- validation -------------------------------------------------------------

export interface ValidatedBody {
  text: string;
  config: Record<string, unknown>;
  status: string;
  angle: number | undefined;
  mirror: boolean | undefined;
  words: unknown[];
  page_width: number | null | undefined;
  page_height: number | null | undefined;
}

function validateWords(raw: unknown): unknown[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'validation', 'words must be an array');
  if (raw.length > MAX_WORDS) throw new HttpError(400, 'validation', `words exceeds ${MAX_WORDS} entries`);
  for (const w of raw) {
    if (w === null || typeof w !== 'object') throw new HttpError(400, 'validation', 'each word must be an object');
    const o = w as Record<string, unknown>;
    if (typeof o['text'] !== 'string'
      || typeof o['x'] !== 'number' || typeof o['y'] !== 'number'
      || typeof o['w'] !== 'number' || typeof o['h'] !== 'number'
      || ![o['x'], o['y'], o['w'], o['h']].every((n) => Number.isFinite(n as number))) {
      throw new HttpError(400, 'validation', 'each word needs text + finite x/y/w/h');
    }
  }
  return raw;
}

function validateBody(body: Record<string, unknown>, partial: boolean): ValidatedBody {
  const text = body['text'];
  if (!partial || text !== undefined) {
    if (typeof text !== 'string') throw new HttpError(400, 'validation', 'text is required');
    if (text.length > MAX_TEXT_CHARS) throw new HttpError(400, 'validation', `text exceeds ${MAX_TEXT_CHARS} characters`);
  }
  const config = body['config'];
  if (config !== undefined && (config === null || typeof config !== 'object' || Array.isArray(config))) {
    throw new HttpError(400, 'validation', 'config must be a JSON object');
  }
  const status = body['status'];
  if (status !== undefined && (typeof status !== 'string' || status.length > 32)) {
    throw new HttpError(400, 'validation', 'status must be a short string');
  }
  const angle = body['angle'];
  if (angle !== undefined && (typeof angle !== 'number' || !Number.isFinite(angle))) {
    throw new HttpError(400, 'validation', 'angle must be a finite number');
  }
  const mirror = body['mirror'];
  if (mirror !== undefined && typeof mirror !== 'boolean') {
    throw new HttpError(400, 'validation', 'mirror must be a boolean');
  }
  const dim = (v: unknown, name: string): number | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      throw new HttpError(400, 'validation', `${name} must be a positive integer or null`);
    }
    return v;
  };
  return {
    text: (text as string) ?? '',
    config: (config as Record<string, unknown>) ?? {},
    status: (status as string) ?? 'done',
    angle: angle as number | undefined,
    mirror: mirror as boolean | undefined,
    words: validateWords(body['words']),
    page_width: dim(body['page_width'], 'page_width'),
    page_height: dim(body['page_height'], 'page_height'),
  };
}

// --- handlers (shared by the route files) -----------------------------------

type PhotoCtx = { params: Promise<{ id: string; photoId: string }> };
type TrCtx = { params: Promise<{ id: string; transcriptionId: string }> };

async function listForPhoto(projectId: string, photoId: string, url: URL) {
  const ref = await requirePhotoImage(projectId, photoId);
  const { limit, offset } = pagination(url);
  const rows = await queryRaw<Record<string, unknown>>(
    `${SELECT} WHERE t.image_id = $1 AND t.deleted_at IS NULL
     ORDER BY t.created_at, t.id LIMIT $2 OFFSET $3`,
    [ref.image_id, limit, offset]);
  const total = await sql()`SELECT COUNT(*)::int AS c FROM transcriptions
    WHERE image_id = ${ref.image_id} AND deleted_at IS NULL`;
  return ok({
    items: rows.map((r) => rowToJson({ ...r, photo_id: photoId, project_id: projectId })),
    total: (total[0]['c'] as number),
    ...(nextCursor(offset, limit, rows.length) ? { nextCursor: nextCursor(offset, limit, rows.length) } : {}),
  });
}

async function insertTranscription(
  projectId: string,
  ref: PhotoImageRef,
  v: ValidatedBody,
  altoKey: string | null,
  op: { opId: string | null; req: Request; body: Record<string, unknown> },
) {
  const newId = randomUUID();
  // angle/mirror describe the WORD-BOX SPACE relative to the stored
  // image (CONTRACT.md Wave C): 0/false = boxes are in stored-image
  // coordinates — the normal case for ALTO files and for our OCR, whose
  // boxes come from the stored pixels. A producer that recognized a
  // rotated/flipped rendering passes its orientation explicitly.
  void ref;
  const angle = v.angle ?? 0;
  const mirror = v.mirror ?? false;
  const qq = (t: string, p?: unknown[]) => ({ text: t, params: p });
  const { result, replayed, clientOpId } = await idempotentCreate({
    projectId,
    opId: op.opId,
    kind: 'transcription.create',
    payload: { image_id: ref.image_id },
    create: async () => {
      await tx(() => [
        qq(`INSERT INTO transcriptions
              (id, image_id, text, alto_r2_key, config, status, angle, mirror, words, page_width, page_height)
            VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11)`,
          [newId, ref.image_id, v.text, altoKey, JSON.stringify(v.config), v.status,
            angle, mirror, JSON.stringify(v.words), v.page_width ?? null, v.page_height ?? null]),
        bumpRevQuery(projectId),
      ]);
      return { transcription_id: newId };
    },
    findPrior: async () => {
      const stashed = await readStashedResult<{ transcription_id: string }>(op.opId!);
      return stashed?.transcription_id ? { transcription_id: stashed.transcription_id } : null;
    },
  });
  const readId = replayed ? (result?.transcription_id ?? newId) : newId;
  const json = await getTranscriptionJson(projectId, readId);
  const revRows = await sql()`SELECT rev FROM projects WHERE id = ${projectId}`;
  return ok({
    ...json, rev: Number(revRows[0]['rev']),
    ...(replayed ? { replayed: true } : {}),
    ...(clientOpId ? { clientOpId } : {}),
  }, replayed ? 200 : 201);
}

export function photoTranscriptionsRoute() {
  return {
    GET: handle(async (req: Request, ctx: PhotoCtx) => {
      const { id, photoId } = await ctx.params;
      await requireProject(id);
      return listForPhoto(id, photoId, new URL(req.url));
    }),
    POST: handle(async (req: Request, ctx: PhotoCtx) => {
      const { id, photoId } = await ctx.params;
      await requireProject(id);
      const ref = await requirePhotoImage(id, photoId);
      const body = await parseJson<Record<string, unknown>>(req);
      const v = validateBody(body, false);
      // Provenance: manual by default; an explicit config.source (the OCR
      // client sends source:'ocr' + engine fields) is preserved.
      if (typeof v.config['source'] !== 'string') v.config = { ...v.config, source: 'manual' };
      // Plugin gate (Wave E part 2): OCR results land through this
      // create; with the tesseract-ocr extension off they are refused.
      if (v.config['source'] === 'ocr') await requirePluginEnabled(id, 'tesseract-ocr');
      // OCR/manual word boxes are in photo pixel space unless the caller
      // says otherwise.
      if (v.page_width === undefined) v.page_width = ref.width;
      if (v.page_height === undefined) v.page_height = ref.height;
      const opId = resolveClientOpId(req, body as { clientOpId?: string });
      return insertTranscription(id, ref, v, null, { opId, req, body });
    }),
  };
}

/** POST an ALTO XML document for a photo: parse -> store XML in R2 -> row. */
export function photoAltoImportRoute() {
  return {
    POST: handle(async (req: Request, ctx: PhotoCtx) => {
      const { id, photoId } = await ctx.params;
      await requireProject(id);
      await requirePluginEnabled(id, 'alto-import');
      const ref = await requirePhotoImage(id, photoId);
      const body = await parseCappedJson<{ xml?: unknown; clientOpId?: string }>(req);
      if (typeof body.xml !== 'string' || !body.xml.trim()) {
        throw new HttpError(400, 'validation', 'xml (ALTO document string) is required');
      }
      let doc;
      try {
        doc = parseAlto(body.xml);
      } catch (err) {
        if (err instanceof AltoParseError) throw new HttpError(400, 'validation', err.message);
        throw err;
      }
      const newId = randomUUID();
      const altoKey = keys.transcription(id, newId);
      const storage = await getStorageDriver();
      await storage.putBytes(altoKey, Buffer.from(body.xml, 'utf8'), { contentType: 'application/xml' });
      const v: ValidatedBody = {
        text: doc.text.slice(0, MAX_TEXT_CHARS),
        config: {
          source: 'alto',
          alto: { namespace: doc.namespace, version: doc.version },
        },
        status: 'done',
        angle: undefined,
        mirror: undefined,
        words: doc.words,
        page_width: doc.pageWidth,
        page_height: doc.pageHeight,
      };
      try {
        const opId = resolveClientOpId(req, body as { clientOpId?: string });
        // The id is pre-minted (the R2 key embeds it), so creation here is
        // a direct insert rather than the idempotent-create helper.
        void opId;
        const qq = (t: string, p?: unknown[]) => ({ text: t, params: p });
        await tx(() => [
          qq(`INSERT INTO transcriptions
                (id, image_id, text, alto_r2_key, config, status, angle, mirror, words, page_width, page_height)
              VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11)`,
            [newId, ref.image_id, v.text, altoKey, JSON.stringify(v.config), v.status,
              v.angle ?? 0, v.mirror ?? false, JSON.stringify(v.words),
              v.page_width ?? null, v.page_height ?? null]),
          bumpRevQuery(id),
        ]);
      } catch (err) {
        // Roll back the stored object — never orphan ALTO bytes.
        await storage.delete(altoKey).catch(() => {});
        throw err;
      }
      const json = await getTranscriptionJson(id, newId);
      const revRows = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
      return ok({ ...json, rev: Number(revRows[0]['rev']) }, 201);
    }),
  };
}

export function transcriptionRoute() {
  return {
    GET: handle(async (_req: Request, ctx: TrCtx) => {
      const { id, transcriptionId } = await ctx.params;
      await requireProject(id);
      return ok(await getTranscriptionJson(id, transcriptionId));
    }),
    PATCH: handle(async (req: Request, ctx: TrCtx) => {
      const { id, transcriptionId } = await ctx.params;
      await requireProject(id);
      const current = await getTranscriptionJson(id, transcriptionId);
      const body = await parseJson<Record<string, unknown>>(req);
      const v = validateBody(body, true);
      const sets: string[] = ['updated_at = now()'];
      const params: unknown[] = [transcriptionId];
      const push = (col: string, val: unknown, cast = '') => {
        params.push(val);
        sets.push(`${col} = $${params.length}${cast}`);
      };
      if (body['text'] !== undefined) push('text', v.text);
      if (body['config'] !== undefined) push('config', JSON.stringify(v.config), '::jsonb');
      if (body['status'] !== undefined) push('status', v.status);
      if (body['angle'] !== undefined) push('angle', v.angle);
      if (body['mirror'] !== undefined) push('mirror', v.mirror);
      if (body['words'] !== undefined) push('words', JSON.stringify(v.words), '::jsonb');
      if (body['page_width'] !== undefined) push('page_width', v.page_width);
      if (body['page_height'] !== undefined) push('page_height', v.page_height);
      void current;
      const qq = (t: string, p?: unknown[]) => ({ text: t, params: p });
      await tx(() => [
        qq(`UPDATE transcriptions SET ${sets.join(', ')} WHERE id = $1`, params),
        bumpRevQuery(id),
      ]);
      const json = await getTranscriptionJson(id, transcriptionId);
      const revRows = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
      return ok({ ...json, rev: Number(revRows[0]['rev']) });
    }),
    DELETE: handle(async (_req: Request, ctx: TrCtx) => {
      const { id, transcriptionId } = await ctx.params;
      await requireProject(id);
      await getTranscriptionJson(id, transcriptionId); // 404 gate
      const qq = (t: string, p?: unknown[]) => ({ text: t, params: p });
      await tx(() => [
        qq(`UPDATE transcriptions SET deleted_at = now(), updated_at = now() WHERE id = $1`, [transcriptionId]),
        bumpRevQuery(id),
      ]);
      const revRows = await sql()`SELECT rev FROM projects WHERE id = ${id}`;
      return ok({ deleted: transcriptionId, rev: Number(revRows[0]['rev']) });
    }),
  };
}

/** GET the stored ALTO XML: 302 to a presigned URL (file-route pattern). */
export function transcriptionAltoDownloadRoute() {
  return {
    GET: handle(async (_req: Request, ctx: TrCtx) => {
      const { id, transcriptionId } = await ctx.params;
      await requireProject(id);
      const json = await getTranscriptionJson(id, transcriptionId);
      if (!json.alto_r2_key) throw new HttpError(404, 'not_found', 'no ALTO XML stored for this transcription');
      const storage = await getStorageDriver();
      const target = await storage.presignGet(json.alto_r2_key, {
        disposition: 'attachment',
        contentType: 'application/xml',
        filename: `transcription-${transcriptionId}.xml`,
      });
      return new Response(null, {
        status: 302,
        headers: { Location: target, 'Cache-Control': 'private, max-age=240' },
      });
    }),
  };
}

/** GET the plain text as a download (straight from the row — no storage). */
export function transcriptionTextDownloadRoute() {
  return {
    GET: handle(async (_req: Request, ctx: TrCtx) => {
      const { id, transcriptionId } = await ctx.params;
      await requireProject(id);
      const json = await getTranscriptionJson(id, transcriptionId);
      return new Response(json.text, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="transcription-${transcriptionId}.txt"`,
          'Cache-Control': 'private, no-store',
        },
      });
    }),
  };
}
