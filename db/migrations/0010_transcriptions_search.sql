-- SPDX-License-Identifier: MIT
-- db/migrations/0010_transcriptions_search.sql — Wave C (rows 13/14/19):
-- transcriptions become a real feature surface.
--
-- 1. Word boxes + page geometry live on the row (NOT inside config):
--    `words` is a JSONB array of {text,x,y,w,h,confidence?} in page
--    coordinates; `page_width`/`page_height` are the coordinate space
--    (ALTO <Page WIDTH/HEIGHT>, or the photo's pixel size for OCR/manual).
--    Rationale: boxes are first-class render data for the viewer's text
--    layer — queryable and validatable without unpacking provenance JSON.
--    `config` stays provenance-only (source/engine/lang/ALTO version).
--    created_at/added so lists have a stable order (0001 had none).
-- 2. Search (row 19 remainder): per-scope tsvector `doc_transcriptions`
--    on search_documents; refresh_search_document() now aggregates
--    transcriptions.text for BOTH owning scopes — the photo subject and
--    its parent item subject (a transcription hangs off images, and a
--    photo's image is what ties it to those subjects).
-- 3. The 0001 trigger `trg_search_transcriptions` was scaffolding that
--    could never fire successfully: it ran trg_refresh_search_document(),
--    which reads NEW.subject_id — a column transcriptions does not have.
--    Replaced with a mapping trigger: image_id -> every photo using that
--    image -> refresh the photo subject AND its item subject.
--
-- Apply with: psql "$DATABASE_URL" -f db/migrations/0010_transcriptions_search.sql
-- (migrations apply in filename order).

-- 1. Transcription row shape ------------------------------------------------
ALTER TABLE transcriptions
  ADD COLUMN IF NOT EXISTS words      JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS page_width  INT,
  ADD COLUMN IF NOT EXISTS page_height INT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS transcriptions_image_idx
  ON transcriptions(image_id) WHERE deleted_at IS NULL;

-- 2. Search document scope ---------------------------------------------------
ALTER TABLE search_documents
  ADD COLUMN IF NOT EXISTS doc_transcriptions TSVECTOR NOT NULL DEFAULT ''::tsvector;

CREATE OR REPLACE FUNCTION refresh_search_document(p_subject UUID) RETURNS void AS $$
DECLARE v_meta TEXT; v_notes TEXT; v_tags TEXT; v_trans TEXT;
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
  -- Wave C: transcription text for this subject's scope. A subject owns a
  -- transcription when it IS the photo (photos.subject_id) or CONTAINS the
  -- photo (photos.item_id). Soft-deleted transcriptions never contribute.
  SELECT string_agg(tr.text, ' ') INTO v_trans
  FROM transcriptions tr
  JOIN photos p ON p.image_id = tr.image_id
  WHERE tr.deleted_at IS NULL
    AND (p.subject_id = p_subject OR p.item_id = p_subject);
  INSERT INTO search_documents
    (subject_id, project_id, subject_kind, doc_meta, doc_notes, doc_tags, doc_transcriptions, doctext, updated_at)
  SELECT p_subject, s.project_id, s.kind,
         to_tsvector('english', coalesce(v_meta,''))  || to_tsvector('simple', coalesce(v_meta,'')),
         to_tsvector('english', coalesce(v_notes,'')) || to_tsvector('simple', coalesce(v_notes,'')),
         to_tsvector('english', coalesce(v_tags,''))  || to_tsvector('simple', coalesce(v_tags,'')),
         to_tsvector('english', coalesce(v_trans,'')) || to_tsvector('simple', coalesce(v_trans,'')),
         (coalesce(v_meta,'') || ' ' || coalesce(v_notes,'') || ' ' || coalesce(v_tags,'') || ' ' || coalesce(v_trans,'')),
         now()
  FROM subjects s WHERE s.id = p_subject
  ON CONFLICT (subject_id) DO UPDATE SET
    doc_meta = EXCLUDED.doc_meta,
    doc_notes = EXCLUDED.doc_notes,
    doc_tags = EXCLUDED.doc_tags,
    doc_transcriptions = EXCLUDED.doc_transcriptions,
    doctext = EXCLUDED.doctext,
    updated_at = now();
END $$ LANGUAGE plpgsql;

-- 3. Transcription trigger: image_id -> owning photo + item subjects --------
DROP TRIGGER IF EXISTS trg_search_transcriptions ON transcriptions;

CREATE OR REPLACE FUNCTION trg_refresh_search_from_transcription() RETURNS trigger AS $$
DECLARE v_images UUID[]; r RECORD;
BEGIN
  v_images := ARRAY(
    SELECT DISTINCT img FROM (
      SELECT OLD.image_id AS img WHERE TG_OP IN ('UPDATE','DELETE')
      UNION ALL
      SELECT NEW.image_id AS img WHERE TG_OP IN ('INSERT','UPDATE')
    ) u WHERE img IS NOT NULL
  );
  FOR r IN
    SELECT p.subject_id AS photo_id, p.item_id
    FROM photos p WHERE p.image_id = ANY(v_images)
  LOOP
    PERFORM refresh_search_document(r.photo_id);
    PERFORM refresh_search_document(r.item_id);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_search_transcriptions
  AFTER INSERT OR UPDATE OR DELETE ON transcriptions
  FOR EACH ROW EXECUTE FUNCTION trg_refresh_search_from_transcription();

-- 4. Indexes ------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS search_documents_gin_transcriptions
  ON search_documents USING GIN (doc_transcriptions);
DROP INDEX IF EXISTS search_documents_gin_all;
CREATE INDEX IF NOT EXISTS search_documents_gin_all
  ON search_documents USING GIN ((doc_meta || doc_notes || doc_tags || doc_transcriptions));

-- 5. Backfill: existing rows gain their transcription scope ------------------
SELECT refresh_search_document(s.id) FROM subjects s;
