// SPDX-License-Identifier: MIT
/**
 * lib/notes/sanitize.ts — shared note/link sanitizer (build gate B13).
 *
 * OWNERSHIP: backend writes this file first; the frontend consumes it
 * (see CONTRACT.md shared handoff order). Never fork a copy.
 *
 * Wired into (per phase3-security-review §6 B13 / AppSec §1.7 / Red §2.1):
 *   (i)   .tpy note-state import — strip disallowed `link` marks, keep text
 *         (pre-pass MUST run BEFORE TipTap `setContent`, per-note try/catch);
 *   (ii)  JSON-LD accept — both HTML→TipTap and Markdown→TipTap paths;
 *   (iii) TipTap editor config via `Link.configure(tiptapLinkOptions())`;
 *   (iv)  JSON-LD emit (`lib/export/jsonld.js`) drops disallowed hrefs
 *         (defense-in-depth, covers state stored before the import fix).
 *
 * No DOM dependency: implemented on a small tokenizer so it runs in
 * Node route handlers, the browser, and unit tests unchanged.
 */

// ---------------------------------------------------------------------------
// Link URL policy — http/https/mailto/tel only (explicit allowlist).
// ---------------------------------------------------------------------------

const ALLOWED_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Returns true only if `raw` is an absolute URL whose scheme is one of
 * http/https/mailto/tel. Relative URLs, protocol-relative URLs, `javascript:`,
 * `data:`, `vbscript:`, `file:` and friends all return false.
 *
 * Control characters (which the WHATWG URL parser would otherwise strip,
 * e.g. `java\tscript:`) are rejected before parsing.
 */
export function isAllowedLinkUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const url = raw.trim();
  if (url.length === 0 || url.length > 8192) return false;
  // Reject C0 controls + DEL before the URL parser can strip them.
  if (/[\u0000-\u0020\u007F]/.test(url)) return false;
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return false; // relative URL or unparseable
  }
  if (!ALLOWED_LINK_SCHEMES.has(protocol)) return false;
  // Belt-and-braces: require the literal string to start with an allowed
  // scheme so parser normalization can never smuggle one through.
  const lower = url.toLowerCase();
  return (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('tel:')
  );
}

/**
 * TipTap v3 `Link` extension options honoring the shared policy.
 * Usage (frontend): `Link.configure(tiptapLinkOptions())`
 */
export function tiptapLinkOptions(): {
  isAllowedUri: (url: string) => boolean;
  HTMLAttributes: Record<string, string>;
} {
  return {
    isAllowedUri: (url: string) => isAllowedLinkUrl(url),
    HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
  };
}

// ---------------------------------------------------------------------------
// TipTap JSON path — sanitize `link` marks BEFORE `setContent`.
// ---------------------------------------------------------------------------

export interface SanitizeDocResult {
  /** The (mutated-in-place-safe) document; structurally unchanged on error. */
  doc: unknown;
  /** Number of link marks stripped. */
  stripped: number;
}

/**
 * Walk a TipTap/ProseMirror document JSON tree and drop every `link` mark
 * whose `href` fails {@link isAllowedLinkUrl}. Text is always preserved.
 * Unknown node/mark shapes are passed through untouched (text preserved).
 *
 * Callers MUST wrap per-note in try/catch so one hostile note cannot throw
 * inside a 50-item import transaction (availability, phase3 §2.1).
 */
export function sanitizeTiptapDoc(doc: unknown): SanitizeDocResult {
  let stripped = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const marks = obj['marks'];
    if (Array.isArray(marks)) {
      const kept = marks.filter((mark) => {
        if (mark === null || typeof mark !== 'object') return true;
        const m = mark as Record<string, unknown>;
        if (m['type'] !== 'link') return true;
        const attrs = m['attrs'];
        const href =
          attrs !== null && typeof attrs === 'object'
            ? (attrs as Record<string, unknown>)['href']
            : undefined;
        if (isAllowedLinkUrl(href)) return true;
        stripped += 1;
        return false;
      });
      obj['marks'] = kept;
    }
    if (obj['content'] !== undefined) visit(obj['content']);
  };
  visit(doc);
  return { doc, stripped };
}

// ---------------------------------------------------------------------------
// HTML path — sanitizeNoteHtml: allowlist tags/attributes, escape the rest.
// ---------------------------------------------------------------------------

/** Tags permitted in note HTML. Everything else is unwrapped (children kept), except dropped tags. */
const ALLOWED_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'code',
  'ul', 'ol', 'li',
  'strong', 'b', 'em', 'i', 'u', 's', 'del',
  'sub', 'sup',
  'a', 'br', 'hr',
  'span', 'div',
]);

/** Tag whose entire subtree (including text) is discarded. */
const DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'noscript']);

/** Attributes permitted per tag (lowercased tag → allowed attr names). */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'target', 'rel']),
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

interface Token {
  kind: 'open' | 'close' | 'text';
  name: string; // lowercased tag name for open/close
  attrs: Array<[string, string]>;
  selfClosing: boolean;
  text: string;
}

/** Minimal HTML tokenizer: handles tags, quoted/unquoted attrs, comments, text. */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      tokens.push({ kind: 'text', name: '', attrs: [], selfClosing: false, text: html.slice(i) });
      break;
    }
    if (lt > i) {
      tokens.push({ kind: 'text', name: '', attrs: [], selfClosing: false, text: html.slice(i, lt) });
    }
    // Comment?
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    // Declaration / processing instruction (<!DOCTYPE, <?xml): skip.
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    // Find tag end, respecting quotes.
    let j = lt + 1;
    let quote: string | null = null;
    while (j < n) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j++;
    }
    if (j >= n) {
      // Unterminated tag: treat the rest as text.
      tokens.push({ kind: 'text', name: '', attrs: [], selfClosing: false, text: html.slice(lt) });
      break;
    }
    const inner = html.slice(lt + 1, j).trim();
    i = j + 1;
    if (inner.length === 0) continue;
    if (inner[0] === '/') {
      const name = inner.slice(1).split(/[\s/>]/)[0].toLowerCase();
      tokens.push({ kind: 'close', name, attrs: [], selfClosing: false, text: '' });
      continue;
    }
    const selfClosing = /\/\s*$/.test(inner);
    const body = selfClosing ? inner.replace(/\/\s*$/, '').trim() : inner;
    const nameMatch = /^[^\s/>]+/.exec(body);
    if (!nameMatch) continue;
    const name = nameMatch[0].toLowerCase();
    const attrs: Array<[string, string]> = [];
    const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let m: RegExpExecArray | null;
    const rest = body.slice(nameMatch[0].length);
    while ((m = attrRe.exec(rest)) !== null) {
      const attrName = m[1].toLowerCase();
      const attrVal = m[2] ?? m[3] ?? m[4] ?? '';
      attrs.push([attrName, decodeEntities(attrVal)]);
    }
    tokens.push({ kind: 'open', name, attrs, selfClosing, text: '' });
  }
  return tokens;
}

/**
 * Sanitize note HTML to the allowlisted tag/attribute set.
 *
 * - `<script>`, `<style>`, event-handler attributes, `style` attributes and
 *   disallowed tags are removed; text content is preserved except inside
 *   DROP_TAGS (script/style/iframe/…), whose subtree is discarded.
 * - `<a href>` must pass {@link isAllowedLinkUrl}; otherwise the link is
 *   unwrapped (text kept) and `target`/`rel` are normalized to the safe
 *   values (`_blank` / `noopener noreferrer`).
 * - All text nodes are HTML-escaped.
 */
export function sanitizeNoteHtml(html: string): string {
  if (!html) return '';
  const out: string[] = [];
  const openStack: string[] = [];
  let dropDepth = 0;

  const emitOpen = (tok: Token): void => {
    const allowed = ALLOWED_ATTRS[tok.name];
    let attrStr = '';
    if (allowed) {
      for (const [k, v] of tok.attrs) {
        if (!allowed.has(k)) continue;
        if (tok.name === 'a' && k === 'href') {
          if (!isAllowedLinkUrl(v)) {
            // Disallowed href: unwrap the link (keep children as text flow).
            openStack.push(''); // marker: no closing tag to emit
            return;
          }
          attrStr += ` href="${escapeHtml(v)}"`;
          continue;
        }
        if (tok.name === 'a' && k === 'target') {
          attrStr += ' target="_blank"';
          continue;
        }
        if (tok.name === 'a' && k === 'rel') {
          attrStr += ' rel="noopener noreferrer"';
          continue;
        }
        attrStr += ` ${k}="${escapeHtml(v)}"`;
      }
      if (tok.name === 'a' && !/target=/.test(attrStr)) attrStr += ' target="_blank"';
      if (tok.name === 'a' && !/rel=/.test(attrStr)) attrStr += ' rel="noopener noreferrer"';
    }
    out.push(`<${tok.name}${attrStr}>`);
    openStack.push(tok.name);
  };

  for (const tok of tokenize(html)) {
    if (tok.kind === 'text') {
      if (dropDepth === 0) out.push(escapeHtml(decodeEntities(tok.text)));
      continue;
    }
    if (tok.kind === 'open') {
      if (DROP_TAGS.has(tok.name)) {
        dropDepth += 1;
        openStack.push('!' + tok.name); // drop marker
        continue;
      }
      if (dropDepth > 0) {
        openStack.push('!' + tok.name);
        continue;
      }
      if (!ALLOWED_TAGS.has(tok.name)) {
        openStack.push(''); // unwrap: no tag emitted
        continue;
      }
      if (tok.selfClosing && (tok.name === 'br' || tok.name === 'hr')) {
        out.push(`<${tok.name}>`);
        continue;
      }
      emitOpen(tok);
      continue;
    }
    // close
    const marker = openStack.pop();
    if (marker === undefined) continue; // stray close tag
    if (marker.startsWith('!')) {
      const droppedName = marker.slice(1);
      if (DROP_TAGS.has(droppedName)) dropDepth = Math.max(0, dropDepth - 1);
      continue;
    }
    if (marker === '') continue; // unwrapped/dropped-link: no close tag
    if (dropDepth === 0 && marker === tok.name) out.push(`</${tok.name}>`);
  }
  return out.join('');
}
