// SPDX-License-Identifier: MIT
// Search snippet rendering (build gate B14; CONTRACT.md "Search snippet
// contract" — binding wire format).
//
// Wire format: the server HTML-escapes the whole ts_headline, then swaps the
// unique sentinel tokens for `<mark>`/`</mark>` — the payload arriving here
// is safe HTML containing ONLY `<mark>` elements. This module renders those
// highlights as React `<mark>` nodes — never via dangerouslySetInnerHTML,
// never rendering raw HTML. Any other markup in the payload is treated as
// literal text (React-escaped), so a buggy or compromised server cannot
// inject elements or attributes; visual output is identical to rendering
// the payload as-is for conforming input.
//
// Entity note (F3): the wire text is server-escaped, so React text nodes
// would double-escape it (`R&amp;D` rendering literally). Every text segment
// is decoded for exactly the five wire entities (`&amp; &lt; &gt; &quot;`
// `&#39;`) in one pass before becoming a React node — `<mark>` structure is
// honored, and a literal `&amp;lt;` in the source decodes to the text `&lt;`,
// never to markup.
//
// The sentinel branch below is a defensive fallback (sentinels never appear
// in the wire payload per the contract); it renders them safely rather than
// leaking raw tokens into the UI.

import type { ReactNode } from "react";
import { SEARCH_SENTINEL_START, SEARCH_SENTINEL_END } from "@/lib/types";

// F3 — the wire payload is server-escaped HTML (B14): every `& < > " '`
// arrives as one of exactly five entities. React text nodes re-escape on
// render, so pushing the raw wire text double-escapes (`R&amp;D` renders
// literally). Decode the five entities in a SINGLE left-to-right pass
// before pushing text nodes — a single pass guarantees `&amp;lt;` decodes
// to the literal text `&lt;` (one level), never to `<`.
const ENTITY_RE = /&(amp|lt|gt|quot|#39);/g;
const ENTITY_CHAR: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
};

function decodeWireEntities(text: string): string {
  return text.replace(ENTITY_RE, (m) => ENTITY_CHAR[m.slice(1, -1)] ?? m);
}

function splitSentinels(snippet: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = snippet.split(SEARCH_SENTINEL_START);
  out.push(decodeWireEntities(parts[0]));
  for (let i = 1; i < parts.length; i++) {
    const [hit, rest] = parts[i].split(SEARCH_SENTINEL_END);
    if (rest === undefined) {
      // Unbalanced sentinel — render literally, never silently drop text.
      out.push(SEARCH_SENTINEL_START, decodeWireEntities(parts[i]));
    } else {
      out.push(<mark key={`m${i}`}>{decodeWireEntities(hit)}</mark>, decodeWireEntities(rest));
    }
  }
  return out;
}

/**
 * Render a server-escaped snippet that uses `<mark>` highlights directly.
 * Only exact `<mark>`/`</mark>` tokens are honored; every other `<...>`
 * sequence is rendered as inert text.
 */
function splitMarks(snippet: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /<\/?mark>/gi;
  let last = 0;
  let key = 0;
  let open = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) {
    const token = m[0].toLowerCase();
    if (token === "<mark>" && !open) {
      out.push(decodeWireEntities(snippet.slice(last, m.index)));
      open = true;
      last = m.index + m[0].length;
    } else if (token === "</mark>" && open) {
      out.push(<mark key={`m${key++}`}>{decodeWireEntities(snippet.slice(last, m.index))}</mark>);
      open = false;
      last = m.index + m[0].length;
    }
    // Stray/duplicate tokens fall through and stay in the text verbatim.
  }
  out.push((open ? "<mark>" : "") + decodeWireEntities(snippet.slice(last)));
  return out;
}

/** AND/"phrase" query parser for the client-side rank fallback (server ranks). */
export function parseQuery(q: string): { must: string[]; phrases: string[] } {
  const phrases: string[] = [];
  const rest = q.replace(/"([^"]*)"/g, (_, p: string) => {
    if (p.trim()) phrases.push(p.trim());
    return " ";
  });
  const must = rest.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  return { must, phrases };
}

export function renderSnippet(snippet: string): ReactNode[] {
  if (!snippet) return [];
  if (snippet.includes(SEARCH_SENTINEL_START)) return splitSentinels(snippet);
  return splitMarks(snippet);
}
