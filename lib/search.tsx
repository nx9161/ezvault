// SPDX-License-Identifier: MIT
// B14 — search snippet rendering.
//
// The server (`GET /api/projects/[id]/search`) escapes the ENTIRE headline as
// HTML and marks matches with unique sentinel tokens instead of real <mark>
// tags (ts_headline output is not HTML-safe — Red Team §2.2). The client swaps
// sentinels for <mark> elements WITHOUT ever touching dangerouslySetInnerHTML:
// the snippet is split into React text nodes (React escapes by default) and
// match segments are wrapped in <mark>.
//
// SENTINEL CONTRACT (must match the backend search handler exactly):
//   SEARCH_MARK_START = '\u0000ezmark\u0000'
//   SEARCH_MARK_END   = '\u0000/ezmark\u0000'
// Recorded in CONTRACT.md; the backend implements the escape+swap server-side.

import type { ReactNode } from "react";

export const SEARCH_MARK_START = "\u0000ezmark\u0000";
export const SEARCH_MARK_END = "\u0000/ezmark\u0000";

/**
 * Split a sentinel-tagged snippet into React nodes.
 * Never renders raw HTML — text segments are plain strings (React-escaped).
 */
export function renderSnippet(snippet: string): ReactNode[] {
  const out: ReactNode[] = [];
  if (!snippet) return out;
  // Split on START; the first chunk is always plain text.
  const parts = snippet.split(SEARCH_MARK_START);
  out.push(parts[0]);
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const endIdx = part.indexOf(SEARCH_MARK_END);
    if (endIdx === -1) {
      // Malformed (no END): render the remainder as marked text — still safe,
      // it is a plain string, never HTML.
      out.push(
        <mark key={`m-${i}`}>{part}</mark>,
      );
    } else {
      out.push(
        <mark key={`m-${i}`}>{part.slice(0, endIdx)}</mark>,
        part.slice(endIdx + SEARCH_MARK_END.length),
      );
    }
  }
  return out;
}
