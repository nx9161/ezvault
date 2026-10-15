// SPDX-License-Identifier: MIT
/**
 * lib/search/query.ts — FTS query helpers (phase2 §4, B14).
 *
 * Query: `websearch_to_tsquery('english', :q) || websearch_to_tsquery('simple', :q)`
 * Rank: ts_rank_cd. Snippets: ts_headline with SENTINEL StartSel/StopSel.
 *
 * B14 (ts_headline snippet XSS): ts_headline output is NOT HTML-safe. The
 * route requests headlines with the unique sentinel tokens
 * (SEARCH_SENTINEL_START/END, lib/types.ts), HTML-escapes the ENTIRE
 * headline server-side, then swaps sentinels for <mark>/</mark>. The client
 * renders the returned snippet as HTML; attacker-controlled text can never
 * inject markup because everything except the sentinels was escaped.
 */

import { SEARCH_SENTINEL_START, SEARCH_SENTINEL_END } from '../types.js';

/** ts_headline options string with sentinel selection markers. */
export function headlineOptions(): string {
  return `StartSel=${SEARCH_SENTINEL_START},StopSel=${SEARCH_SENTINEL_END},MaxWords=40,MinWords=15,MaxFragments=3`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Convert a raw ts_headline string (containing sentinels) into safe HTML.
 * Escapes everything, then swaps the sentinels for <mark> tags. The
 * sentinels contain no HTML-special characters, so the swap is safe.
 */
export function sentinelToMark(headline: string | null): string {
  if (!headline) return '';
  return escapeHtml(headline)
    .split(SEARCH_SENTINEL_START).join('<mark>')
    .split(SEARCH_SENTINEL_END).join('</mark>');
}

/** True when the query has no searchable tokens (short-circuit before SQL). */
export function isEmptyQuery(q: string): boolean {
  return q.replace(/["\-()|&:*!<>=~]/g, ' ').trim().length === 0;
}
