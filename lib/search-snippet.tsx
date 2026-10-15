// SPDX-License-Identifier: MIT
// Search snippet rendering (build gate B14).
//
// The server HTML-escapes the whole headline and marks hits with unique
// sentinel tokens (`SEARCH_SENTINEL_START/END` in lib/types.ts); per B14 the
// handler then swaps sentinels for `<mark>`. Either form may arrive — this
// module renders BOTH safely as React nodes, never via
// dangerouslySetInnerHTML. Any other markup in the payload is treated as
// literal text (React-escaped), so a compromised or buggy server cannot
// inject elements or attributes.

import type { ReactNode } from "react";
import { SEARCH_SENTINEL_START, SEARCH_SENTINEL_END } from "@/lib/types";

function splitSentinels(snippet: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = snippet.split(SEARCH_SENTINEL_START);
  out.push(parts[0]);
  for (let i = 1; i < parts.length; i++) {
    const [hit, rest] = parts[i].split(SEARCH_SENTINEL_END);
    if (rest === undefined) {
      // Unbalanced sentinel — render literally, never silently drop text.
      out.push(SEARCH_SENTINEL_START, parts[i]);
    } else {
      out.push(<mark key={`m${i}`}>{hit}</mark>, rest);
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
      out.push(snippet.slice(last, m.index));
      open = true;
      last = m.index + m[0].length;
    } else if (token === "</mark>" && open) {
      out.push(<mark key={`m${key++}`}>{snippet.slice(last, m.index)}</mark>);
      open = false;
      last = m.index + m[0].length;
    }
    // Stray/duplicate tokens fall through and stay in the text verbatim.
  }
  out.push((open ? "<mark>" : "") + snippet.slice(last));
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
