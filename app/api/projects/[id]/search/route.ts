// SPDX-License-Identifier: MIT
import { handle, ok, requireProject, pagination, nextCursor } from '@/lib/api/route-utils';
import { queryRaw } from '@/lib/db/index';
import { headlineOptions, sentinelToMark, isEmptyQuery } from '@/lib/search/query';
import type { SearchScope } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/[id]/search?q=&scope=
 * FTS over metadata+notes+tags (trigger-maintained search_documents).
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
  const scope = (url.searchParams.get('scope') ?? 'all') as SearchScope;
  const { limit, offset } = pagination(url, 100);

  if (isEmptyQuery(q)) {
    return ok({ query: q, hits: [], badges: {} });
  }

  // Scope selects which field vector/text participate (default: all three).
  const useMeta = scope === 'all' || scope === 'metadata';
  const useNotes = scope === 'all' || scope === 'notes';
  const useTags = scope === 'all' || scope === 'tags';

  const rows = await queryRaw<{
    subject_id: string; subject_kind: string; rank: number; snippet: string | null;
  }>(
    `WITH q AS (
       SELECT (websearch_to_tsquery('english', $2) || websearch_to_tsquery('simple', $2)) AS query
     ),
     agg AS (
       SELECT s.id AS subject_id, s.kind AS subject_kind,
         (CASE WHEN $4 THEN to_tsvector('english', COALESCE(mt.v_meta,'')) || to_tsvector('simple', COALESCE(mt.v_meta,'')) ELSE ''::tsvector END
          || CASE WHEN $5 THEN to_tsvector('english', COALESCE(nt.v_text,'')) || to_tsvector('simple', COALESCE(nt.v_text,'')) ELSE ''::tsvector END
          || CASE WHEN $6 THEN to_tsvector('english', COALESCE(tt.v_tags,'')) || to_tsvector('simple', COALESCE(tt.v_tags,'')) ELSE ''::tsvector END) AS vec,
         (CASE WHEN $4 THEN COALESCE(mt.v_meta,'') ELSE '' END || ' ' ||
          CASE WHEN $5 THEN COALESCE(nt.v_text,'') ELSE '' END || ' ' ||
          CASE WHEN $6 THEN COALESCE(tt.v_tags,'') ELSE '' END) AS doctext
       FROM subjects s
       LEFT JOIN (
         SELECT m.subject_id, string_agg(mv.text, ' ') AS v_meta
         FROM metadata m JOIN metadata_values mv ON mv.value_id = m.value_id
         WHERE mv.datatype NOT IN (
           'http://www.w3.org/2001/XMLSchema#boolean',
           'http://www.w3.org/2001/XMLSchema#hexBinary',
           'http://www.w3.org/2001/XMLSchema#base64Binary',
           'http://www.w3.org/1999/02/22-rdf-syntax-ns#HTML',
           'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString',
           'http://www.w3.org/1999/02/22-rdf-syntax-ns#XMLLiteral')
         GROUP BY m.subject_id
       ) mt ON mt.subject_id = s.id
       LEFT JOIN (
         SELECT subject_id, string_agg(text, ' ') AS v_text FROM notes
         WHERE deleted_at IS NULL GROUP BY subject_id
       ) nt ON nt.subject_id = s.id
       LEFT JOIN (
         SELECT tg.subject_id, string_agg(t.name::text, ' ') AS v_tags
         FROM taggings tg JOIN tags t ON t.id = tg.tag_id GROUP BY tg.subject_id
       ) tt ON tt.subject_id = s.id
       WHERE s.project_id = $1
     )
     SELECT a.subject_id, a.subject_kind,
            ts_rank_cd(a.vec, q.query) AS rank,
            ts_headline('english', a.doctext, q.query, $3) AS snippet
     FROM agg a, q
     WHERE a.vec @@ q.query
     ORDER BY rank DESC
     LIMIT $7 OFFSET $8`,
    [id, q, headlineOptions(), useMeta, useNotes, useTags, limit, offset],
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
