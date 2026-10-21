// SPDX-License-Identifier: MIT
/**
 * lib/transcription/alto.ts — ALTO XML parser (Wave C, row 13).
 *
 * Pure module (no server-only, no storage): routes feed it the uploaded
 * XML string; tests feed it fixtures. Uses the repo's existing SAX
 * approach (`sax`, strict mode — same dependency and local typings
 * pattern as lib/import/svg-sanitize.ts) — no new parser dependency.
 *
 * ALTO (Library of Congress standard; ns-v2/v3/v4 + namespace-less
 * variants all occur in the wild) structure handled:
 *   alto > Layout > Page[WIDTH,HEIGHT] > PrintSpace
 *     > (ComposedBlock|TextBlock) > TextLine
 *       > String[CONTENT,HPOS,VPOS,WIDTH,HEIGHT,WC?] (SP | HYP)*
 * Tag/attribute matching is local-name based and case-normalized, so
 * prefixed documents (<alto:Page>) parse identically.
 *
 * Text assembly (plain-text extraction):
 *   - words within a line join with a single space (SP elements are
 *     advisory; String order is authoritative);
 *   - a line terminated by HYP joins the NEXT line with no separator
 *     and drops the trailing hyphen from the assembled text (the word
 *     boxes keep their original CONTENT);
 *   - lines join with '\n'; blocks join with '\n' (no blank-line
 *     invention — consumers split on '\n' either way).
 * Word boxes are returned in PAGE coordinates; the page's WIDTH/HEIGHT
 * ride along so renderers can scale into photo pixel space.
 */

import { parser as saxParser } from 'sax';

export interface AltoWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Word confidence 0..1 (ALTO WC attribute), when present. */
  confidence?: number;
}

export interface AltoDocument {
  /** Assembled plain text (reading order). */
  text: string;
  words: AltoWord[];
  pageWidth: number | null;
  pageHeight: number | null;
  /** ALTO namespace URI from the root element (e.g. .../alto/ns-v4#). */
  namespace: string | null;
  /** ALTO schema version: SCHEMAVERSION attr, else inferred from the ns. */
  version: string | null;
}

export class AltoParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AltoParseError';
  }
}

function localName(raw: string): string {
  const n = raw.toLowerCase();
  const i = n.lastIndexOf(':');
  return i >= 0 ? n.slice(i + 1) : n;
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function inferVersion(ns: string | null, schemaVersion: string | null): string | null {
  if (schemaVersion) return schemaVersion;
  if (!ns) return null;
  const m = /ns-v(\d+)/i.exec(ns);
  return m ? m[1] : null;
}

export function parseAlto(xml: string): AltoDocument {
  if (typeof xml !== 'string' || !xml.trim()) {
    throw new AltoParseError('empty ALTO document');
  }
  const words: AltoWord[] = [];
  const lines: string[] = [];
  let pageWidth: number | null = null;
  let pageHeight: number | null = null;
  let namespace: string | null = null;
  let schemaVersion: string | null = null;
  let sawAltoRoot = false;
  let sawPage = false;

  // Current line assembly.
  let lineWords: string[] = [];
  let lineOpen = false;
  let lineHyphenated = false;
  // Set when the just-closed line ended in HYP: the next line glues on.
  let glueNextLine = false;

  const errBox: { current: Error | null } = { current: null };

  const closeLine = () => {
    if (!lineOpen) return;
    let text = lineWords.join(' ');
    if (lineHyphenated && text.endsWith('-')) text = text.slice(0, -1);
    if (glueNextLine && lines.length) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
    glueNextLine = lineHyphenated;
    lineWords = [];
    lineOpen = false;
    lineHyphenated = false;
  };

  const p = saxParser(true, { trim: false, normalize: false, lowercase: true });
  p.onerror = (err) => {
    errBox.current = err;
  };

  p.onopentag = (tag) => {
    const name = localName(tag.name);
    // Attribute keys are normalized here (this sax build does not
    // lowercase them despite the option): ALTO attrs arrive as
    // CONTENT/HPOS/... and are read as content/hpos/... (values keep
    // their case).
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(tag.attributes)) attrs[k.toLowerCase()] = v;
    if (!sawAltoRoot) {
      if (name !== 'alto') {
        errBox.current = new AltoParseError('root element must be <alto>');
        return;
      }
      sawAltoRoot = true;
      namespace = attrs['xmlns'] ?? null;
      schemaVersion = attrs['schemaversion'] ?? null;
      return;
    }
    switch (name) {
      case 'page': {
        if (!sawPage) {
          sawPage = true;
          pageWidth = num(attrs['width']);
          pageHeight = num(attrs['height']);
        }
        break;
      }
      case 'textline': {
        closeLine();
        lineOpen = true;
        lineWords = [];
        lineHyphenated = false;
        break;
      }
      case 'string': {
        const content = attrs['content'] ?? '';
        const x = num(attrs['hpos']);
        const y = num(attrs['vpos']);
        const w = num(attrs['width']);
        const h = num(attrs['height']);
        if (x !== null && y !== null && w !== null && h !== null) {
          const wc = num(attrs['wc']);
          words.push({
            text: content,
            x, y, w, h,
            ...(wc !== null ? { confidence: wc } : {}),
          });
        }
        if (lineOpen && content) lineWords.push(content);
        break;
      }
      case 'hyp': {
        if (lineOpen) lineHyphenated = true;
        break;
      }
      default:
        break;
    }
  };

  p.onclosetag = (rawName) => {
    const name = localName(rawName);
    if (name === 'textline' || name === 'textblock' || name === 'composedblock' || name === 'page') {
      closeLine();
      if (name === 'textblock' || name === 'composedblock') glueNextLine = false;
    }
  };

  p.write(xml).close();

  if (errBox.current) {
    if (errBox.current instanceof AltoParseError) throw errBox.current;
    throw new AltoParseError(`ALTO parse failed: ${errBox.current.message}`);
  }
  if (!sawAltoRoot) throw new AltoParseError('no <alto> root element found');
  closeLine();

  return {
    text: lines.join('\n').trim(),
    words,
    pageWidth,
    pageHeight,
    namespace,
    version: inferVersion(namespace, schemaVersion),
  };
}
