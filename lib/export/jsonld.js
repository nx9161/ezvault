// SPDX-License-Identifier: MIT
/**
 * lib/export/jsonld.js — shared JSON-LD emit module (phase2 §6.6).
 *
 * Consumed by BOTH:
 *   - GET /api/projects/[id]/export/jsonld (Next route handler), and
 *   - the monthly backup workflow (scripts/backup-jsonld.mjs).
 *
 * Plain JavaScript (no TypeScript) so the backup script can import it with
 * plain node. Takes a neon `sql` query function as a parameter — it never
 * reads env or opens connections itself.
 *
 * Emit contract (Tropy-compatible envelope + selections extension):
 *   - `@context` with `@vocab https://tropy.org/v1/tropy#`, `@graph` array
 *   - `template` = the subject's template `uri`
 *   - metadata at template property URIs, tropy-capture value-encoding:
 *     blank omitted; integer -> JSON number; rdfs:Class -> {"@id"};
 *     else {"@value","@type"}
 *   - `tag[]`, `list[]` (nested list path joined " / ")
 *   - photos: protocol "file", filename, mimetype, size, checksum (sha256),
 *     density, w/h, page 0-based
 *   - notes: {"@type":"Note","text","html"} (or "markdown" per preference)
 *   - selections emitted as an EZVault extension (Tropy ignores unknown
 *     predicates)
 *
 * Security (binding):
 *   - B13 emit gate: disallowed hrefs are dropped at render (link unwrapped,
 *     text kept) — defense-in-depth for state stored before the import fix.
 *   - B24: `subjects.raw_import` and note `_importedFrom` audit JSON are
 *     NEVER emitted.
 */

export const TROPY_VOCAB = 'https://tropy.org/v1/tropy#';

// --- link policy (mirrors lib/notes/sanitize.ts isAllowedLinkUrl) ------------
function isAllowedHref(raw) {
  if (typeof raw !== 'string') return false;
  const url = raw.trim();
  if (!url || url.length > 8192) return false;
  if (/[\u0000-\u0020\u007F]/.test(url)) return false;
  let protocol;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return false;
  }
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(protocol)) return false;
  const lower = url.toLowerCase();
  return (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('tel:')
  );
}

// --- tiny HTML helpers --------------------------------------------------------
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMarks(text, marks, format) {
  let out = format === 'html' ? escHtml(text) : String(text);
  if (!Array.isArray(marks)) return out;
  for (const mark of marks) {
    if (!mark || typeof mark !== 'object') continue;
    const t = mark.type;
    if (format === 'html') {
      if (t === 'bold' || t === 'strong') out = `<strong>${out}</strong>`;
      else if (t === 'italic' || t === 'em') out = `<em>${out}</em>`;
      else if (t === 'underline') out = `<u>${out}</u>`;
      else if (t === 'strike') out = `<s>${out}</s>`;
      else if (t === 'code') out = `<code>${out}</code>`;
      else if (t === 'superscript') out = `<sup>${out}</sup>`;
      else if (t === 'subscript') out = `<sub>${out}</sub>`;
      else if (t === 'link') {
        // B13: drop disallowed hrefs, keep the text.
        const href = mark.attrs && mark.attrs.href;
        if (isAllowedHref(href)) {
          out = `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer">${out}</a>`;
        }
      }
    } else {
      if (t === 'bold' || t === 'strong') out = `**${out}**`;
      else if (t === 'italic' || t === 'em') out = `_${out}_`;
      else if (t === 'code') out = `\`${out}\``;
      else if (t === 'strike') out = `~~${out}~~`;
      else if (t === 'link') {
        const href = mark.attrs && mark.attrs.href;
        out = isAllowedHref(href) ? `[${out}](${href})` : out;
      }
    }
  }
  return out;
}

function renderNodes(nodes, format) {
  if (!Array.isArray(nodes)) return '';
  return nodes.map((n) => renderNode(n, format)).join('');
}

function renderNode(node, format) {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return renderMarks(node.text ?? '', node.marks, format);
  const inner = renderNodes(node.content, format);
  if (format === 'html') {
    switch (node.type) {
      case 'paragraph': return `<p>${inner}</p>`;
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number((node.attrs && node.attrs.level) || 1)));
        return `<h${level}>${inner}</h${level}>`;
      }
      case 'bulletList': return `<ul>${inner}</ul>`;
      case 'orderedList': return `<ol>${inner}</ol>`;
      case 'listItem': return `<li>${inner}</li>`;
      case 'blockquote': return `<blockquote>${inner}</blockquote>`;
      case 'codeBlock': return `<pre><code>${inner}</code></pre>`;
      case 'hardBreak': return '<br>';
      case 'horizontalRule': return '<hr>';
      default: return inner; // unknown nodes: text preserved, wrapper dropped
    }
  }
  switch (node.type) {
    case 'paragraph': return `${inner}\n\n`;
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number((node.attrs && node.attrs.level) || 1)));
      return `${'#'.repeat(level)} ${inner}\n\n`;
    }
    case 'bulletList': return `${inner}\n`;
    case 'orderedList': return `${inner}\n`;
    case 'listItem': return `- ${inner.trim()}\n`;
    case 'blockquote': return inner.split('\n').map((l) => `> ${l}`).join('\n');
    case 'codeBlock': return `\`\`\`\n${inner}\n\`\`\`\n\n`;
    case 'hardBreak': return '  \n';
    case 'horizontalRule': return '\n---\n\n';
    default: return inner;
  }
}

/** TipTap doc JSON -> HTML (sanitized links) or Markdown. */
export function tiptapToHtml(state) {
  if (!state || typeof state !== 'object') return '';
  return renderNodes(state.content, 'html');
}

export function tiptapToMarkdown(state) {
  if (!state || typeof state !== 'object') return '';
  return renderNodes(state.content, 'markdown').trim();
}

/** Plain-text extraction (mirrors the import-side extractor). */
export function tiptapToText(state) {
  const parts = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'text' && typeof n.text === 'string') parts.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(state);
  return parts.join('');
}

// --- metadata value encoding (tropy-capture rules, §6.6) ----------------------
function encodeValue(datatype, text) {
  if (text === null || text === undefined || String(text).trim() === '') return undefined; // blank omitted
  const t = String(text);
  const dt = String(datatype || '');
  if (/XMLSchema#integer$/.test(dt) || /XMLSchema#(long|int|short|nonNegativeInteger)$/.test(dt)) {
    const n = Number(t);
    if (Number.isInteger(n)) return n;
  }
  if (/rdf-syntax-ns#.*Class$/.test(dt) || dt === 'http://www.w3.org/2000/01/rdf-schema#Class') {
    return { '@id': t };
  }
  return { '@value': t, '@type': dt || 'http://www.w3.org/2001/XMLSchema#string' };
}

// --- main builder -------------------------------------------------------------
/**
 * @param {Function} sql neon query function (tagged template)
 * @param {object} project project row
 * @param {object} opts { format: 'html'|'markdown', itemId?: string }
 * @returns {object} JSON-LD document
 */
export async function buildProjectJsonLd(sql, project, opts = {}) {
  const format = opts.format === 'markdown' ? 'markdown' : 'html';
  // Wave B2 (additive): opts.itemIds exports a selection of items; the
  // singular opts.itemId keeps its original meaning. Backup callers pass
  // neither and are unaffected.
  const itemIdList = opts.itemId
    ? [opts.itemId]
    : Array.isArray(opts.itemIds)
      ? opts.itemIds
      : null;
  // An explicitly empty selection exports NOTHING (never falls through
  // to the whole project).
  const itemFilter = itemIdList
    ? itemIdList.length
      ? sql`AND i.subject_id = ANY(${itemIdList})`
      : sql`AND false`
    : sql``;

  const templates = await sql`SELECT id, name, uri, fields FROM templates WHERE project_id = ${project.id}`;
  const tplById = new Map(templates.map((t) => [t.id, t]));

  const tags = await sql`SELECT id, name FROM tags WHERE project_id = ${project.id}`;
  const tagById = new Map(tags.map((t) => [t.id, t.name]));

  const lists = await sql`SELECT id, name, parent_list_id FROM lists WHERE project_id = ${project.id}`;
  const listById = new Map(lists.map((l) => [l.id, l]));
  const listPath = (id) => {
    const parts = [];
    let cur = id;
    const seen = new Set();
    while (cur && listById.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const l = listById.get(cur);
      parts.unshift(l.name);
      cur = l.parent_list_id;
    }
    return parts.join(' / ');
  };

  const items = await sql`
    SELECT s.id AS subject_id, s.template_id
    FROM subjects s JOIN items i ON i.subject_id = s.id
    WHERE s.project_id = ${project.id} ${itemFilter}
    ORDER BY s.created_at`;

  // NOTE: raw_import is deliberately never selected (B24).
  const metaRows = await sql`
    SELECT m.subject_id, m.property_uri, m.language, v.datatype, v.text
    FROM metadata m JOIN metadata_values v ON v.value_id = m.value_id
    JOIN subjects s ON s.id = m.subject_id
    WHERE s.project_id = ${project.id}`;
  const metaBySubject = new Map();
  for (const r of metaRows) {
    if (!metaBySubject.has(r.subject_id)) metaBySubject.set(r.subject_id, []);
    metaBySubject.get(r.subject_id).push(r);
  }

  const tagRows = await sql`
    SELECT tg.subject_id, tg.tag_id
    FROM taggings tg JOIN subjects s ON s.id = tg.subject_id
    WHERE s.project_id = ${project.id}`;
  const tagsBySubject = new Map();
  for (const r of tagRows) {
    const name = tagById.get(r.tag_id);
    if (!name) continue;
    if (!tagsBySubject.has(r.subject_id)) tagsBySubject.set(r.subject_id, []);
    tagsBySubject.get(r.subject_id).push(name);
  }

  const listRows = await sql`
    SELECT li.item_id, li.list_id
    FROM list_items li JOIN lists l ON l.id = li.list_id
    WHERE l.project_id = ${project.id}`;
  const listsByItem = new Map();
  for (const r of listRows) {
    if (!listsByItem.has(r.item_id)) listsByItem.set(r.item_id, []);
    listsByItem.get(r.item_id).push(listPath(r.list_id));
  }

  const noteRows = await sql`
    SELECT n.id, n.subject_id, n.text, n.state, n.language
    FROM notes n JOIN subjects s ON s.id = n.subject_id
    WHERE s.project_id = ${project.id} AND n.deleted_at IS NULL
    ORDER BY n.created_at`;
  const notesBySubject = new Map();
  for (const r of noteRows) {
    if (!notesBySubject.has(r.subject_id)) notesBySubject.set(r.subject_id, []);
    // B24: _importedFrom audit JSON is never emitted — only text/state/language.
    notesBySubject.get(r.subject_id).push({
      '@type': 'Note',
      text: r.text,
      ...(format === 'markdown'
        ? { markdown: tiptapToMarkdown(r.state) }
        : { html: tiptapToHtml(r.state) }),
    });
  }

  const photoRows = await sql`
    SELECT p.subject_id, p.item_id, p.r2_key, p.original_filename, p.mimetype,
           p.checksum_sha256, p.tpy_checksum_md5, p.size_bytes, p.width, p.height,
           p.density, p.page, p.missing_original, s.template_id
    FROM photos p JOIN subjects s ON s.id = p.subject_id
    WHERE s.project_id = ${project.id} ${itemFilter.length ? sql`AND p.item_id = ANY(${itemIdList})` : sql``}
    ORDER BY p.position`;

  const selRows = await sql`
    SELECT sel.subject_id, sel.photo_id, sel.name, sel.x, sel.y, sel.width, sel.height, s.template_id
    FROM selections sel JOIN subjects s ON s.id = sel.subject_id
    WHERE s.project_id = ${project.id}
    ORDER BY sel.subject_id`;
  const selsByPhoto = new Map();
  for (const r of selRows) {
    if (!selsByPhoto.has(r.photo_id)) selsByPhoto.set(r.photo_id, []);
    const tpl = r.template_id ? tplById.get(r.template_id) : null;
    const selNotes = notesBySubject.get(r.subject_id) || [];
    selsByPhoto.get(r.photo_id).push({
      '@type': 'Selection',
      name: r.name,
      x: r.x, y: r.y, width: r.width, height: r.height,
      ...(tpl && tpl.uri ? { template: tpl.uri } : {}),
      ...(selNotes.length ? { note: selNotes } : {}),
    });
  }

  const photosByItem = new Map();
  for (const r of photoRows) {
    if (!photosByItem.has(r.item_id)) photosByItem.set(r.item_id, []);
    const tpl = r.template_id ? tplById.get(r.template_id) : null;
    const photoMeta = metaBySubject.get(r.subject_id) || [];
    const photo = {
      protocol: 'file',
      filename: r.original_filename,
      mimetype: r.mimetype,
      size: Number(r.size_bytes),
      checksum: r.checksum_sha256,
      width: r.width,
      height: r.height,
      page: r.page,
      ...(r.density != null ? { density: r.density } : {}),
      ...(r.missing_original ? { missing: true } : {}),
      ...(tpl && tpl.uri ? { template: tpl.uri } : {}),
    };
    for (const m of photoMeta) {
      const enc = encodeValue(m.datatype, m.text);
      if (enc !== undefined) photo[m.property_uri] = enc;
    }
    const photoTags = tagsBySubject.get(r.subject_id) || [];
    if (photoTags.length) photo.tag = photoTags;
    const photoNotes = notesBySubject.get(r.subject_id) || [];
    if (photoNotes.length) photo.note = photoNotes;
    const photoSels = selsByPhoto.get(r.subject_id) || [];
    if (photoSels.length) photo.selection = photoSels; // EZVault extension
    photosByItem.get(r.item_id).push(photo);
  }

  const graph = [];
  for (const item of items) {
    const tpl = item.template_id ? tplById.get(item.template_id) : null;
    const entry = {
      '@type': 'Item',
      ...(tpl && tpl.uri ? { template: tpl.uri } : {}),
    };
    for (const m of metaBySubject.get(item.subject_id) || []) {
      const enc = encodeValue(m.datatype, m.text);
      if (enc !== undefined) entry[m.property_uri] = enc;
    }
    const itemTags = tagsBySubject.get(item.subject_id) || [];
    if (itemTags.length) entry.tag = itemTags;
    const itemLists = listsByItem.get(item.subject_id) || [];
    if (itemLists.length) entry.list = itemLists;
    const itemNotes = notesBySubject.get(item.subject_id) || [];
    if (itemNotes.length) entry.note = itemNotes;
    const itemPhotos = photosByItem.get(item.subject_id) || [];
    if (itemPhotos.length) entry.photo = itemPhotos;
    graph.push(entry);
  }

  return {
    '@context': { '@vocab': TROPY_VOCAB },
    '@graph': graph,
  };
}
