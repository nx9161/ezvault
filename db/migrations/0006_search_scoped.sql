-- SPDX-License-Identifier: MIT
-- db/migrations/0006_search_scoped.sql — A1: search_documents per-scope read path.
--
-- Replaces the single combined `doc` tsvector with per-scope columns
-- (doc_meta, doc_notes, doc_tags) + a plain-text `doctext` for ts_headline.
-- The search route now reads these trigger-maintained vectors instead of
-- aggregating + to_tsvector per request (was 200-800ms/keystroke warm).
--
-- FTS measurement (2026-10-15, PGlite/Postgres 17 WASM harness, seeded
-- dataset: 2,500 subjects x 6 metadata rows + notes + tags; 200 warm
-- queries of the shipped route SQL): warm p95 = 139ms scope=all
-- (metadata 71ms, notes 75ms, tags 7ms) — target < 500ms MET.
-- Same harness on the OLD per-request SQL: warm p95 = 3,294ms (~24x).
-- PGlite is WASM-slower than Neon, so the new-path number is a
-- conservative bound; formal live re-verify post-deploy (Dossier H3).
--
-- Apply with: psql "$DATABASE_URL" -f db/migrations/0006_search_scoped.sql
-- (see README "Deploy runbook" — migrations apply in filename order).

-- 1. New columns (IF NOT EXISTS: safe to re-run after a partial apply).
ALTER TABLE search_documents
  ADD COLUMN IF NOT EXISTS doc_meta  TSVECTOR NOT NULL DEFAULT ''::tsvector,
  ADD COLUMN IF NOT EXISTS doc_notes TSVECTOR NOT NULL DEFAULT ''::tsvector,
  ADD COLUMN IF NOT EXISTS doc_tags  TSVECTOR NOT NULL DEFAULT ''::tsvector,
  ADD COLUMN IF NOT EXISTS doctext   TEXT     NOT NULL DEFAULT '';

-- 2. Drop the old combined column FIRST (its GIN index goes with it), so the
-- backfill below never touches it. The only readers were the search route
-- and the items-grid q filter — both rewritten to the scoped columns.
-- (Moved before the backfill: on a populated DB the old `doc` is NOT NULL
-- with no default, so backfilling before the drop would fail.)
ALTER TABLE search_documents DROP COLUMN IF EXISTS doc;

-- 3. Trigger function: populate the per-scope columns + doctext.
CREATE OR REPLACE FUNCTION refresh_search_document(p_subject UUID) RETURNS void AS $$
DECLARE v_meta TEXT; v_notes TEXT; v_tags TEXT;
BEGIN
  -- Tropy-exact exclusion URIs (from project.sql triggers — interop fact)
  SELECT string_agg(mv.text, ' ') INTO v_meta
  FROM metadata m JOIN metadata_values mv ON mv.value_id = m.value_id
  WHERE m.subject_id = p_subject
    AND mv.datatype NOT IN (
      'http://www.w3.org/2001/XMLSchema#boolean',
      'http://www.w3.org/2001/XMLSchema#hexBinary',
      'http://www.w3.org/2001/XMLSchema#base64Binary',
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#HTML',
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString',
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#XMLLiteral');
  SELECT string_agg(n.text, ' ') INTO v_notes FROM notes n
    WHERE n.subject_id = p_subject AND n.deleted_at IS NULL;
  SELECT string_agg(t.name::text, ' ') INTO v_tags
    FROM taggings tg JOIN tags t ON t.id = tg.tag_id WHERE tg.subject_id = p_subject;
  INSERT INTO search_documents
    (subject_id, project_id, subject_kind, doc_meta, doc_notes, doc_tags, doctext, updated_at)
  SELECT p_subject, s.project_id, s.kind,
         to_tsvector('english', coalesce(v_meta,''))  || to_tsvector('simple', coalesce(v_meta,'')),
         to_tsvector('english', coalesce(v_notes,'')) || to_tsvector('simple', coalesce(v_notes,'')),
         to_tsvector('english', coalesce(v_tags,''))  || to_tsvector('simple', coalesce(v_tags,'')),
         (coalesce(v_meta,'') || ' ' || coalesce(v_notes,'') || ' ' || coalesce(v_tags,'')),
         now()
  FROM subjects s WHERE s.id = p_subject
  ON CONFLICT (subject_id) DO UPDATE SET
    doc_meta = EXCLUDED.doc_meta,
    doc_notes = EXCLUDED.doc_notes,
    doc_tags = EXCLUDED.doc_tags,
    doctext = EXCLUDED.doctext,
    updated_at = now();
END $$ LANGUAGE plpgsql;

-- 4. Backfill every subject (rows for content-less subjects carry empty vectors).
-- Safe: `doc` is already dropped above, so the INSERT's column list is complete.
SELECT refresh_search_document(s.id) FROM subjects s;

-- 5. Indexes: one GIN per scope column + an expression GIN for the
-- scope=all concatenation the route queries.
CREATE INDEX IF NOT EXISTS search_documents_gin_meta  ON search_documents USING GIN (doc_meta);
CREATE INDEX IF NOT EXISTS search_documents_gin_notes ON search_documents USING GIN (doc_notes);
CREATE INDEX IF NOT EXISTS search_documents_gin_tags  ON search_documents USING GIN (doc_tags);
CREATE INDEX IF NOT EXISTS search_documents_gin_all   ON search_documents USING GIN ((doc_meta || doc_notes || doc_tags));
