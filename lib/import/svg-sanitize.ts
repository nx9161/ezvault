// SPDX-License-Identifier: MIT
/**
 * lib/import/svg-sanitize.ts — server-side SVG sanitization (B6).
 *
 * librsvg has no JS engine (no script execution), but event-handler / style
 * attributes and <script> survive byte-preserved into originals/, and
 * gigapixel viewBoxes are possible. So at /process, before persisting an
 * SVG original: strict-parse with `sax`, strip <script>/<foreignObject>
 * subtrees, strip event-handler attributes (`on*`), strip `style`
 * attributes, strip non-allowlisted URL attributes, and enforce the pixel
 * cap on declared dimensions. Unparseable SVG is rejected.
 */

import { parser as saxParser } from 'sax';
import { MAX_INPUT_PIXELS } from './validation';

export class SvgRejectedError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Tags whose whole subtree is dropped (B6: script, style, foreignObject). */
const DROP_TAGS = new Set(['script', 'style', 'foreignobject', 'foreignObject']);

/** Attributes stripped everywhere. */
function isStrippedAttr(name: string): boolean {
  const n = name.toLowerCase();
  if (n === 'style') return true;
  if (n.startsWith('on')) return true; // event handlers: onclick, onload, ...
  return false;
}

/** URL-ish attributes: only http/https/mailto/tel/data:image allowed... */
function sanitizeUrlAttr(name: string, value: string): string | null {
  const n = name.toLowerCase();
  if (n !== 'href' && n !== 'xlink:href') return value;
  const v = value.trim().toLowerCase();
  if (
    v.startsWith('http://') || v.startsWith('https://') ||
    v.startsWith('mailto:') || v.startsWith('tel:') ||
    v.startsWith('#') || v.startsWith('data:image/')
  ) {
    return value;
  }
  return null; // drop javascript:/data:text/html etc.
}

function parseDimension(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^\s*([\d.]+)\s*(px|pt|pc|in|cm|mm|q|em|ex|%)?\s*$/i.exec(v);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  // Rough px conversion for absolute units; relative units treated as px.
  const unit = (m[2] || 'px').toLowerCase();
  const factor: Record<string, number> = {
    px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6,
    em: 16, ex: 8, '%': 1,
  };
  return num * (factor[unit] ?? 1);
}

/**
 * Sanitize SVG bytes. Returns the sanitized SVG as a Buffer.
 * Throws SvgRejectedError when the SVG is unparseable or exceeds the
 * pixel cap.
 */
export function sanitizeSvg(input: Buffer): Buffer {
  const text = input.toString('utf8');
  const out: string[] = [];
  const dropStack: string[] = [];
  const errBox: { current: Error | null } = { current: null };
  let rootSeen = false;
  let dimsChecked = false;

  const p = saxParser(true, { trim: false, normalize: false, lowercase: true });

  p.onerror = (err) => {
    errBox.current = err;
  };

  const checkDimensions = (attrs: Record<string, string>) => {
    if (dimsChecked) return;
    dimsChecked = true;
    let w = parseDimension(attrs['width']);
    let h = parseDimension(attrs['height']);
    if ((w === null || h === null) && attrs['viewbox']) {
      const parts = attrs['viewbox'].trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)) {
        if (w === null) w = Math.abs(parts[2]);
        if (h === null) h = Math.abs(parts[3]);
      }
    }
    if (w !== null && h !== null && w * h > MAX_INPUT_PIXELS) {
      errBox.current = new SvgRejectedError(
        `SVG dimensions ${Math.round(w)}x${Math.round(h)} exceed the ${MAX_INPUT_PIXELS}px input cap`,
      );
    }
  };

  p.onopentag = (tag) => {
    const name = tag.name.toLowerCase();
    if (DROP_TAGS.has(name)) {
      dropStack.push(name);
      return;
    }
    if (dropStack.length) return;
    if (!rootSeen) {
      rootSeen = true;
      if (name !== 'svg') {
        errBox.current = new SvgRejectedError('SVG root element must be <svg>');
        return;
      }
    }
    checkDimensions(tag.attributes);
    let attrStr = '';
    for (const [rawName, rawVal] of Object.entries(tag.attributes)) {
      const aname = rawName.toLowerCase();
      if (isStrippedAttr(aname)) continue;
      const kept = sanitizeUrlAttr(aname, rawVal);
      if (kept === null) continue;
      attrStr += ` ${aname}="${escapeAttr(kept)}"`;
    }
    out.push(tag.isSelfClosing ? `<${name}${attrStr}/>` : `<${name}${attrStr}>`);
  };

  p.onclosetag = (name) => {
    const n = name.toLowerCase();
    if (dropStack.length && DROP_TAGS.has(n)) {
      dropStack.pop();
      return;
    }
    if (dropStack.length) return;
    out.push(`</${n}>`);
  };

  p.ontext = (t) => {
    if (dropStack.length) return;
    out.push(escapeText(t));
  };
  p.oncdata = (c) => {
    if (dropStack.length) return;
    // CDATA inside SVG is almost always script-adjacent; escape as text.
    out.push(escapeText(c));
  };
  p.oncomment = () => { /* drop comments */ };
  p.onprocessinginstruction = (pi) => {
    if (dropStack.length) return;
    if (pi.name.toLowerCase() === 'xml') {
      out.push(`<?${pi.name} ${escapeAttr(pi.body)}?>`);
    }
    // other PIs dropped
  };
  p.ondoctype = () => { /* drop doctype (no external DTDs) */ };

  p.write(text).close();

  if (errBox.current) {
    if (errBox.current instanceof SvgRejectedError) throw errBox.current;
    throw new SvgRejectedError(`SVG parse failed: ${errBox.current.message}`);
  }
  if (!rootSeen) throw new SvgRejectedError('no <svg> root element found');
  return Buffer.from(out.join(''), 'utf8');
}
