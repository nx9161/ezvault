// SPDX-License-Identifier: MIT
import { handle, ok, requireProject, pagination, nextCursor } from '@/lib/api/route-utils';
import { queryRaw } from '@/lib/db/index';
import { headlineOptions, sentinelToMark, isEmptyQuery } from '@/lib/search/query';
import type { SearchScope } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * Scope → precomputed tsvector expression on search_documents (A1).
 * The vecExpr text must match the indexed expressions exactly so the
 * planner uses the GIN indexes (plain per-column for scoped searches,
 * search_documents_gin_all for the scope=all concatenation).
 */
const VEC_EXPRS: Record<SearchScope, string> = {
  all: `(sd.doc_meta || sd.doc_notes || sd.doc_tags)`,
  metadata: `sd.doc_meta`,
  notes: `sd.doc_notes`,
  tags: `sd.doc_tags`,
};

function parseScope(raw: string | null): SearchScope {
  return raw === 'metadata' || raw === 'notes' || raw === 'tags' ? raw : 'all';
}

/**
 * GET /api/projects/[id]/search?q=&scope=
 * FTS over metadata+notes+tags, read from the trigger-maintained
 * search_documents table (A1): per-scope tsvector columns (doc_meta,
 * doc_notes, doc_tags) + doctext for ts_headline. Scope selects which
 * precomputed vector participates — no per-request aggregation, no
 * per-row to_tsvector.
 * `websearch_to_tsquery` english+simple, AND default, "phrase" supported,
 * ranked by ts_rank_cd, snippets via ts_headline.
 *
 * B14: ts_headline is called with unique SENTINEL StartSel/StopSel tokens;
 * the ENTIRE headline is HTML-escaped server-side, then sentinels are
 * swapped for <mark>/</mark>. Attacker-controlled text can never inject
 * markup (covers metadata + notes + tags in one place).
 */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').slice(0, 500);
  const scope = parseScope(url.searchParams.get('scope'));
  const { limit, offset } = pagination(url, 100);

  if (isEmptyQuery(q)) {
    return ok({ query: q, hits: [], badges: {} });
  }

  // vecExpr comes from a fixed allowlist keyed by the validated scope —
  // never from raw user input.
  const vecExpr = VEC_EXPRS[scope];

  const rows = await queryRaw<{
    subject_id: string; subject_kind: string; rank: number; snippet: string | null;
  }>(
    `WITH q AS (
       SELECT (websearch_to_tsquery('english', $2) || websearch_to_tsquery('simple', $2)) AS query
     )
     SELECT sd.subject_id, sd.subject_kind,
            ts_rank_cd(${vecExpr}, q.query) AS rank,
            ts_headline('english', sd.doctext, q.query, $3) AS snippet
     FROM search_documents sd, q
     WHERE sd.project_id = $1 AND ${vecExpr} @@ q.query
     ORDER BY rank DESC
     LIMIT $4 OFFSET $5`,
    [id, q, headlineOptions(), limit, offset],
  );

  const hits = rows.map((r) => ({
    subject_id: r.subject_id,
    project_id: id,
    subject_kind: r.subject_kind,
    rank: Number(r.rank),
    snippet: sentinelToMark(r.snippet),
  }));

  // Sidebar hit-count badges per list/tag: which lists/tags contain hits.
  const hitIds = hits.map((h) => h.subject_id);
  const badges: Record<string, number> = {};
  if (hitIds.length) {
    const listHits = await queryRaw<{ list_id: string; c: number }>(
      `SELECT li.list_id, COUNT(*)::int AS c FROM list_items li
       WHERE li.item_id = ANY($1) GROUP BY li.list_id`, [hitIds]);
    for (const r of listHits) badges[r.list_id] = r.c;
    const tagHits = await queryRaw<{ tag_id: string; c: number }>(
      `SELECT tg.tag_id, COUNT(*)::int AS c FROM taggings tg
       WHERE tg.subject_id = ANY($1) GROUP BY tg.tag_id`, [hitIds]);
    for (const r of tagHits) badges[r.tag_id] = r.c;
  }

  return ok({
    query: q,
    hits,
    badges,
    ...(nextCursor(offset, limit, rows.length) ? { nextCursor: nextCursor(offset, limit, rows.length) } : {}),
  });
});
