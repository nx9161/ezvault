// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/import/jsonld-accept.ts — JSON-LD import (phase2 §6.6 accept).
 *
 * - Accepts compacted-or-expanded `@graph`; `@vocab` resolved.
 * - B10: custom documentLoader REJECTING ALL remote contexts — only the
 *   inline allowlisted `https://tropy.org/v1/tropy#` context is served.
 * - B11: depth/width caps enforced by the route via parseCappedJson.
 * - `template` URI -> templates.uri match (else sibling .ttp, else Generic
 *   fallback with unmapped properties preserved raw — never dropped).
 * - note.html/text/markdown -> TipTap (B13: sanitizer on HTML and Markdown
 *   paths; link marks gated by isAllowedLinkUrl).
 * - photo.path -> staged-file match (opts.pathKeys) or checksum match.
 * - Unknown keys preserved raw on subjects.raw_import (B24 — never rendered
 *   or re-emitted).
 */

import { randomUUID } from 'node:crypto';
import { sql, tx, bumpRevQuery, type TxQuery } from '../db/index';
import { sanitizeNoteHtml, sanitizeTiptapDoc, isAllowedLinkUrl } from '../notes/sanitize';
import { tiptapToText } from '../export/jsonld.js';
import { HttpError } from '../api/route-utils';

import { strictDocumentLoader, TROPY_CONTEXT_URL, RemoteContextRejectedError } from './jsonld-context';
import { expandAndCompact } from './jsonld-expand';
import { isAllowedUploadMimetype } from './validation';

export { strictDocumentLoader, TROPY_CONTEXT_URL };

// ---------------------------------------------------------------------------
// HTML -> TipTap (operates on sanitizeNoteHtml output, B13)
// ---------------------------------------------------------------------------

interface TiptapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

function htmlToTiptap(sanitizedHtml: string): TiptapNode {
  const root: TiptapNode = { type: 'doc', content: [] };
  const stack: TiptapNode[] = [root];
  let markStack: { type: string; attrs?: Record<string, unknown> }[] = [];

  const pushText = (text: string) => {
    if (!text) return;
    const parent = stack[stack.length - 1];
    parent.content = parent.content ?? [];
    // Merge with previous text node when marks match.
    const prev = parent.content[parent.content.length - 1];
    const marks = markStack.length ? [...markStack] : undefined;
    const sameMarks =
      prev?.type === 'text' &&
      JSON.stringify(prev.marks ?? null) === JSON.stringify(marks ?? null);
    if (sameMarks && prev.text !== undefined) {
      prev.text += text;
    } else {
      parent.content.push({ type: 'text', text, ...(marks ? { marks } : {}) });
    }
  };

  // The sanitizer emits balanced, allowlisted tags — a simple scanner suffices.
  const tagRe = /<\/?([a-z][a-z0-9]*)\b([^>]*)>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  const BLOCKS: Record<string, string> = {
    p: 'paragraph', h1: 'heading', h2: 'heading', h3: 'heading',
    h4: 'heading', h5: 'heading', h6: 'heading',
    ul: 'bulletList', ol: 'orderedList', li: 'listItem',
    blockquote: 'blockquote', pre: 'codeBlock',
  };
  const MARKS: Record<string, string> = {
    strong: 'bold', b: 'bold', em: 'italic', i: 'italic',
    u: 'underline', s: 'strike', del: 'strike',
    code: 'code', sup: 'superscript', sub: 'subscript',
  };

  const openBlock = (type: string, attrs?: Record<string, unknown>) => {
    const node: TiptapNode = { type, ...(attrs ? { attrs } : {}), content: [] };
    const parent = stack[stack.length - 1];
    parent.content = parent.content ?? [];
    parent.content.push(node);
    stack.push(node);
  };

  while ((m = tagRe.exec(sanitizedHtml)) !== null) {
    if (m[3] !== undefined) {
      // Text — decode the entities the sanitizer wrote.
      pushText(
        m[3].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'),
      );
      continue;
    }
    const closing = m[0][1] === '/';
    const name = m[1].toLowerCase();
    const attrStr = m[2] ?? '';
    if (closing) {
      if (BLOCKS[name]) {
        if (stack.length > 1) stack.pop();
      } else if (MARKS[name]) {
        markStack = markStack.slice(0, -1);
      } else if (name === 'a') {
        markStack = markStack.filter((mk) => mk.type !== 'link');
      }
      continue;
    }
    if (name === 'br') {
      const parent = stack[stack.length - 1];
      parent.content = parent.content ?? [];
      parent.content.push({ type: 'hardBreak' });
      continue;
    }
    if (name === 'hr') continue; // no-op in notes
    if (BLOCKS[name]) {
      const attrs = name[0] === 'h' ? { level: Number(name.slice(1)) } : undefined;
      openBlock(BLOCKS[name], attrs);
      continue;
    }
    if (MARKS[name]) {
      markStack = [...markStack, { type: MARKS[name] }];
      continue;
    }
    if (name === 'a') {
      const hrefM = /\bhref\s*=\s*"([^"]*)"/i.exec(attrStr);
      const href = hrefM?.[1] ?? '';
      // B13: disallowed hrefs never become link marks (text kept).
      if (isAllowedLinkUrl(href)) markStack = [...markStack, { type: 'link', attrs: { href } }];
      continue;
    }
    // span/div/code-inline fall through as transparent containers
  }
  return root;
}

// ---------------------------------------------------------------------------
// Markdown -> TipTap (minimal: paragraphs, headings, emphasis, links, lists)
// ---------------------------------------------------------------------------

function mdInline(text: string): TiptapNode[] {
  const out: TiptapNode[] = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|__([^_]+)__|_([^_]+)_|`([^`]+)`|~~([^~]+)~~|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (t: string, marks?: TiptapNode['marks']) => {
    if (t) out.push({ type: 'text', text: t, ...(marks ? { marks } : {}) });
  };
  while ((m = re.exec(text)) !== null) {
    push(text.slice(last, m.index));
    const full = m[1];
    if (m[2] !== undefined || m[4] !== undefined) push(m[2] ?? m[4], [{ type: 'bold' }]);
    else if (m[3] !== undefined || m[5] !== undefined) push(m[3] ?? m[5], [{ type: 'italic' }]);
    else if (m[6] !== undefined) push(m[6], [{ type: 'code' }]);
    else if (m[7] !== undefined) push(m[7], [{ type: 'strike' }]);
    else if (m[8] !== undefined) {
      // B13: link href gated.
      const href = m[9];
      push(m[8], isAllowedLinkUrl(href) ? [{ type: 'link', attrs: { href } }] : undefined);
    }
    void full;
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  return out;
}

function markdownToTiptap(md: string): TiptapNode {
  const root: TiptapNode = { type: 'doc', content: [] };
  const lines = md.split('\n');
  let list: TiptapNode | null = null;
  const flushList = () => { list = null; };
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      root.content!.push({ type: 'heading', attrs: { level: h[1].length }, content: mdInline(h[2]) });
    } else if (li) {
      if (!list) {
        list = { type: 'bulletList', content: [] };
        root.content!.push(list);
      }
      list.content!.push({ type: 'listItem', content: [{ type: 'paragraph', content: mdInline(li[1]) }] });
    } else if (!line.trim()) {
      flushList();
    } else {
      flushList();
      root.content!.push({ type: 'paragraph', content: mdInline(line) });
    }
  }
  return root;
}

// ---------------------------------------------------------------------------
// accept
// ---------------------------------------------------------------------------

export interface JsonLdAcceptOptions {
  /** Sibling .ttp template definitions: uri -> {name, fields}. */
  ttp?: { uri: string; name: string; fields: { property_uri: string; label: string }[] }[];
  /** photo.path -> staged R2 key (folder-session uploads). */
  pathKeys?: Record<string, string>;
  duplicatePolicy?: 'skip' | 'keep_both' | 'ask';
}

export interface JsonLdAcceptResult {
  items: number;
  photos: number;
  notes: number;
  jobId: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonLdNode = Record<string, any>;

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function nodeText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o['@value'] === 'string') return o['@value'];
  }
  return '';
}

export async function acceptJsonLd(
  projectId: string,
  doc: unknown,
  opts: JsonLdAcceptOptions = {},
): Promise<JsonLdAcceptResult> {
  // B10: expansion with the strict documentLoader (no remote contexts),
  // then re-compaction to the compact vocabulary shape the walk below is
  // written against (see lib/import/jsonld-expand.ts — walking the raw
  // expanded form silently dropped tags/lists/notes/photos/selections).
  let nodes: JsonLdNode[];
  try {
    nodes = await expandAndCompact(doc);
  } catch (err) {
    if (err instanceof RemoteContextRejectedError) {
      throw new HttpError(422, 'remote_context_rejected', err.message);
    }
    throw err;
  }

  const jobId = randomUUID();
  await sql()`INSERT INTO import_jobs (id, project_id, kind, status, total)
    VALUES (${jobId}, ${projectId}, 'jsonld', 'running', ${nodes.length})`;

  // Template cache: uri -> id.
  const tplCache = new Map<string, string>();
  const genericTpl = async (): Promise<string> => {
    const existing = await sql()`SELECT id FROM templates WHERE project_id = ${projectId} AND name = 'Generic' LIMIT 1`;
    if (existing.length) return existing[0].id as string;
    const created = await sql()`INSERT INTO templates (project_id, name, fields)
      VALUES (${projectId}, 'Generic', '[]'::jsonb) RETURNING id`;
    return created[0].id as string;
  };
  const resolveTemplate = async (uri: string | undefined): Promise<string> => {
    if (uri && tplCache.has(uri)) return tplCache.get(uri)!;
    if (uri) {
      const existing = await sql()`SELECT id FROM templates WHERE project_id = ${projectId} AND uri = ${uri} LIMIT 1`;
      if (existing.length) {
        tplCache.set(uri, existing[0].id as string);
        return existing[0].id as string;
      }
      const sib = opts.ttp?.find((t) => t.uri === uri);
      if (sib) {
        const created = await sql()`INSERT INTO templates (project_id, name, uri, fields)
          VALUES (${projectId}, ${sib.name}, ${sib.uri}, ${JSON.stringify(sib.fields)}::jsonb) RETURNING id`;
        tplCache.set(uri, created[0].id as string);
        return created[0].id as string;
      }
    }
    return genericTpl();
  };

  const tagCache = new Map<string, string>();
  const resolveTag = async (name: string): Promise<string> => {
    const key = name.trim().toLowerCase();
    if (tagCache.has(key)) return tagCache.get(key)!;
    await sql()`INSERT INTO tags (id, project_id, name) VALUES (${randomUUID()}, ${projectId}, ${name.trim()})
      ON CONFLICT (project_id, name) DO NOTHING`;
    const row = await sql()`SELECT id FROM tags WHERE project_id = ${projectId} AND name = ${name.trim()} LIMIT 1`;
    tagCache.set(key, row[0].id as string);
    return row[0].id as string;
  };

  const listCache = new Map<string, string>(); // path -> list id
  const resolveListPath = async (path: string): Promise<string> => {
    if (listCache.has(path)) return listCache.get(path)!;
    const parts = path.split('/').map((p) => p.trim()).filter(Boolean);
    let parent: string | null = null;
    let full = '';
    for (const part of parts) {
      full = full ? `${full} / ${part}` : part;
      if (listCache.has(full)) {
        parent = listCache.get(full)!;
        continue;
      }
      const newListId = randomUUID();
      await sql()`INSERT INTO lists (id, project_id, name, parent_list_id)
        VALUES (${newListId}, ${projectId}, ${part}, ${parent})
        ON CONFLICT DO NOTHING`;
      let id: string;
      {
        const existing = parent === null
          ? await sql()`SELECT id FROM lists WHERE project_id = ${projectId}
              AND name = ${part} AND parent_list_id IS NULL LIMIT 1`
          : await sql()`SELECT id FROM lists WHERE project_id = ${projectId}
              AND name = ${part} AND parent_list_id = ${parent} LIMIT 1`;
        id = (existing[0]?.['id'] ?? newListId) as string;
      }
      listCache.set(full, id);
      parent = id;
    }
    return parent!;
  };

  let items = 0;
  let photos = 0;
  let notes = 0;

  // noteToTiptap conversion helper (B13 on both paths).
  const noteToTiptap = (note: JsonLdNode): { state: TiptapNode; text: string } => {
    let state: TiptapNode;
    if (typeof note['html'] === 'string' || (note['html'] && typeof note['html']['@value'] === 'string')) {
      const html = sanitizeNoteHtml(nodeText(note['html']));
      state = htmlToTiptap(html);
    } else if (typeof note['markdown'] === 'string' || (note['markdown'] && typeof note['markdown']['@value'] === 'string')) {
      state = markdownToTiptap(nodeText(note['markdown']));
    } else if (note['state'] && typeof note['state'] === 'object') {
      state = note['state'] as TiptapNode;
    } else {
      const text = nodeText(note['text']);
      state = { type: 'doc', content: text ? [{ type: 'paragraph', content: [{ type: 'text', text }] }] : [] };
    }
    // B13: JSON path sanitizer BEFORE storage (per-note try/catch at call site).
    const { doc } = sanitizeTiptapDoc(state);
    const text = nodeText(note['text']) || tiptapToText(doc);
    return { state: doc as TiptapNode, text };
  };

  const KNOWN_ITEM_KEYS = new Set(['@id', '@type', 'template', 'tag', 'list', 'photo', 'note']);
  const KNOWN_PHOTO_KEYS = new Set(['@id', '@type', 'protocol', 'filename', 'path', 'mimetype', 'size', 'checksum', 'density', 'width', 'height', 'page', 'template', 'tag', 'note', 'selection']);

  for (const node of nodes) {
    const types = asArray<string>(node['@type']);
    const isItem = types.some((t) => /Item$/.test(t)) || node['photo'] !== undefined;
    if (!isItem) continue;

    const templateUri = typeof node['template'] === 'string' ? node['template']
      : node['template']?.['@id'];
    const templateId = await resolveTemplate(templateUri);

    // Unknown keys preserved raw (B24).
    const raw: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (!KNOWN_ITEM_KEYS.has(k) && !k.startsWith('http')) raw[k] = v;
    }

    const itemId = randomUUID();
    const queries: TxQuery[] = [];
    const q = (text: string, params?: unknown[]): TxQuery => ({ text, params });
    queries.push(q(
      `INSERT INTO subjects (id, project_id, kind, template_id, raw_import) VALUES ($1,$2,'item',$3,$4::jsonb)`,
      [itemId, projectId, templateId, Object.keys(raw).length ? JSON.stringify(raw) : null],
    ));
    queries.push(q(`INSERT INTO items (subject_id) VALUES ($1)`, [itemId]));

    // Metadata: every URI-looking key -> metadata row (never dropped).
    for (const [k, v] of Object.entries(node)) {
      if (KNOWN_ITEM_KEYS.has(k) || !k.startsWith('http')) continue;
      const vals = asArray(v);
      for (const val of vals) {
        const text = nodeText(val);
        if (!text.trim()) continue; // blank omitted (§6.6)
        let datatype = 'http://www.w3.org/2001/XMLSchema#string';
        let outText = text;
        let data: string | null = null;
        if (val && typeof val === 'object') {
          if (typeof val['@type'] === 'string') datatype = val['@type'];
          if (typeof val['@id'] === 'string') {
            datatype = 'http://www.w3.org/2000/01/rdf-schema#Class';
            outText = val['@id'];
          }
          if (val['@value'] !== undefined && typeof val['@value'] !== 'string') data = JSON.stringify(val['@value']);
        }
        // integer -> JSON number per §6.6 value-encoding
        const asNum = /XMLSchema#(integer|long|int|short)$/.test(datatype) ? Number(outText) : NaN;
        const valueId = randomUUID();
        queries.push(q(
          `INSERT INTO metadata_values (value_id, datatype, text, data) VALUES ($1,$2,$3,$4::jsonb)`,
          [valueId, datatype, Number.isInteger(asNum) ? String(asNum) : outText, data],
        ));
        queries.push(q(
          `INSERT INTO metadata (subject_id, property_uri, value_id) VALUES ($1,$2,$3)`,
          [itemId, k, valueId],
        ));
      }
    }

    // Tags / lists.
    for (const t of asArray<unknown>(node['tag'])) {
      const name = nodeText(t);
      if (!name.trim()) continue;
      const tagId = await resolveTag(name);
      queries.push(q(`INSERT INTO taggings (tag_id, subject_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [tagId, itemId]));
    }
    for (const l of asArray<unknown>(node['list'])) {
      const listId = await resolveListPath(nodeText(l));
      queries.push(q(`INSERT INTO list_items (list_id, item_id, position)
        VALUES ($1,$2,COALESCE((SELECT MAX(position)+1 FROM list_items WHERE list_id=$1),0)) ON CONFLICT DO NOTHING`,
        [listId, itemId]));
    }

    // Item notes.
    for (const n of asArray<JsonLdNode>(node['note'])) {
      try {
        const { state, text } = noteToTiptap(n);
        queries.push(q(
          `INSERT INTO notes (subject_id, text, state) VALUES ($1,$2,$3::jsonb)`,
          [itemId, text.slice(0, 100000), JSON.stringify(state)],
        ));
        notes++;
      } catch { /* hostile note skipped, batch survives (B13) */ }
    }

    // Photos.
    for (const p of asArray<JsonLdNode>(node['photo'])) {
      const photoId = randomUUID();
      const imageId = randomUUID();
      const filename = nodeText(p['filename']) || nodeText(p['path'])?.split('/').pop() || 'photo';
      // F-B1: the mimetype comes from untrusted JSON-LD — allowlist it before
      // it lands in photos.mimetype (later reflected as ResponseContentType).
      const claimedMimetype = nodeText(p['mimetype']) || 'image/jpeg';
      const mimetype = isAllowedUploadMimetype(claimedMimetype) ? claimedMimetype.toLowerCase() : 'image/jpeg';
      const checksum = nodeText(p['checksum']);
      const stagedKey = p['path'] && opts.pathKeys ? opts.pathKeys[nodeText(p['path'])] : undefined;

      // Checksum dedupe when we know the sha256.
      if (checksum && opts.duplicatePolicy !== 'keep_both') {
        const dup = await sql()`SELECT p.subject_id FROM photos p JOIN subjects s ON s.id = p.subject_id
          WHERE s.project_id = ${projectId} AND p.checksum_sha256 = ${checksum} LIMIT 1`;
        if (dup.length && opts.duplicatePolicy !== 'ask') continue;
      }

      const photoTemplateId = await resolveTemplate(
        typeof p['template'] === 'string' ? p['template'] : p['template']?.['@id'],
      );
      const photoRaw: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p)) {
        if (!KNOWN_PHOTO_KEYS.has(k) && !k.startsWith('http')) photoRaw[k] = v;
      }
      queries.push(q(
        `INSERT INTO subjects (id, project_id, kind, template_id, raw_import) VALUES ($1,$2,'photo',$3,$4::jsonb)`,
        [photoId, projectId, photoTemplateId, Object.keys(photoRaw).length ? JSON.stringify(photoRaw) : null],
      ));
      queries.push(q(
        `INSERT INTO images (id, width, height) VALUES ($1,$2,$3)`,
        [imageId, Number(nodeText(p['width'])) || 0, Number(nodeText(p['height'])) || 0],
      ));
      queries.push(q(
        `INSERT INTO photos (subject_id, item_id, image_id, position, r2_key, thumb_r2_key, missing_original,
           original_filename, mimetype, checksum_sha256, size_bytes, width, height, page, density)
         VALUES ($1,$2,$3,0,NULL,'jsonld:pending',$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [photoId, itemId, imageId, !stagedKey, filename.slice(0, 255), mimetype,
          checksum || '', Number(nodeText(p['size'])) || 0,
          Number(nodeText(p['width'])) || 0, Number(nodeText(p['height'])) || 0,
          Number(nodeText(p['page'])) || 0,
          nodeText(p['density']) ? Number(nodeText(p['density'])) : null],
      ));
      for (const t of asArray<unknown>(p['tag'])) {
        const name = nodeText(t);
        if (!name.trim()) continue;
        const tagId = await resolveTag(name);
        queries.push(q(`INSERT INTO taggings (tag_id, subject_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [tagId, photoId]));
      }
      for (const n of asArray<JsonLdNode>(p['note'])) {
        try {
          const { state, text } = noteToTiptap(n);
          queries.push(q(`INSERT INTO notes (subject_id, text, state) VALUES ($1,$2,$3::jsonb)`,
            [photoId, text.slice(0, 100000), JSON.stringify(state)]));
          notes++;
        } catch { /* skip hostile note */ }
      }
      // Photo metadata (URI keys).
      for (const [k, v] of Object.entries(p)) {
        if (KNOWN_PHOTO_KEYS.has(k) || !k.startsWith('http')) continue;
        const text = nodeText(v);
        if (!text.trim()) continue;
        const valueId = randomUUID();
        queries.push(q(`INSERT INTO metadata_values (value_id, datatype, text) VALUES ($1,$2,$3)`,
          [valueId, 'http://www.w3.org/2001/XMLSchema#string', text.slice(0, 10000)]));
        queries.push(q(`INSERT INTO metadata (subject_id, property_uri, value_id) VALUES ($1,$2,$3)`, [photoId, k, valueId]));
      }
      // Selections (EZVault extension).
      for (const sel of asArray<JsonLdNode>(p['selection'])) {
        const selId = randomUUID();
        const selImg = randomUUID();
        queries.push(q(`INSERT INTO subjects (id, project_id, kind) VALUES ($1,$2,'selection')`, [selId, projectId]));
        queries.push(q(`INSERT INTO images (id, width, height) VALUES ($1,$2,$3)`,
          [selImg, Number(sel['width']) || 0, Number(sel['height']) || 0]));
        queries.push(q(`INSERT INTO selections (subject_id, photo_id, name, x, y, width, height)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [selId, photoId, String(sel['name'] ?? 'Selection').slice(0, 200),
            Math.round(Number(sel['x']) || 0), Math.round(Number(sel['y']) || 0),
            Math.round(Number(sel['width']) || 0), Math.round(Number(sel['height']) || 0)]));
        for (const n of asArray<JsonLdNode>(sel['note'])) {
          try {
            const { state, text } = noteToTiptap(n);
            queries.push(q(`INSERT INTO notes (subject_id, text, state) VALUES ($1,$2,$3::jsonb)`,
              [selId, text.slice(0, 100000), JSON.stringify(state)]));
            notes++;
          } catch { /* skip */ }
        }
      }
      photos++;
      void stagedKey; // staged bytes are linked later via /tpy/resolve-missing-style flow (wave-1.5)
    }

    queries.push(bumpRevQuery(projectId));
    await tx(() => queries);
    items++;
    await sql()`UPDATE import_jobs SET done = done + 1, updated_at = now() WHERE id = ${jobId}`;
  }

  await sql()`UPDATE import_jobs SET status = 'done', updated_at = now() WHERE id = ${jobId}`;
  return { items, photos, notes, jobId };
}
