-- SPDX-License-Identifier: MIT
-- db/migrations/0001_init.sql — EZVault v1 schema.
-- Source: phase2-architecture.md §3 (DDL) + §4 (FTS), plus build gates:
--   B24: subjects.raw_import JSONB (unknown .tpy tables/columns — never rendered/emitted)
--   B16: rate_buckets (durable Neon rate limiting)
-- Pin: Postgres >= 14 (verify CREATE EXTENSION allowlist on the real Neon project).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------- projects
CREATE TABLE projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  rev           BIGINT NOT NULL DEFAULT 0,   -- cross-tab staleness counter (Frontend)
  default_template_id UUID,
  duplicate_policy TEXT NOT NULL DEFAULT 'skip' CHECK (duplicate_policy IN ('skip','keep_both','ask')),
  notes_export_format TEXT NOT NULL DEFAULT 'html' CHECK (notes_export_format IN ('html','markdown')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- subjects
CREATE TABLE subjects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('item','photo','selection')),
  template_id   UUID,
  -- B24: raw JSON for unknown .tpy tables/columns. NEVER rendered via
  -- dangerouslySetInnerHTML, NEVER spread into HTML-rendered API responses,
  -- NEVER re-emitted by lib/export/jsonld.js. Inert audit storage only.
  raw_import    JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX subjects_project_idx ON subjects(project_id, kind);

-- ---------------------------------------------------------------- items
CREATE TABLE items (
  subject_id    UUID PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
  cover_image_id UUID
);

-- ---------------------------------------------------------------- images (edit params — Tropy-exact)
CREATE TABLE images (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  width         INT NOT NULL, height INT NOT NULL,
  angle         NUMERIC NOT NULL DEFAULT 0,  -- Tropy stores 0-360, not 90deg steps
  mirror        BOOLEAN NOT NULL DEFAULT FALSE, -- horizontal-flip ONLY
  brightness    INT NOT NULL DEFAULT 0,      -- -100..100
  contrast      INT NOT NULL DEFAULT 0,      -- -100..100
  hue           INT NOT NULL DEFAULT 0,      -- -180..180
  saturation    INT NOT NULL DEFAULT 0,      -- -100..100
  negative      BOOLEAN NOT NULL DEFAULT FALSE,
  sharpen       INT NOT NULL DEFAULT 0       -- 0..100
);

-- ---------------------------------------------------------------- photos
CREATE TABLE photos (
  subject_id    UUID PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
  item_id       UUID NOT NULL REFERENCES items(subject_id) ON DELETE CASCADE,
  image_id      UUID NOT NULL REFERENCES images(id),
  position      INT NOT NULL DEFAULT 0,
  r2_key        TEXT UNIQUE,                 -- NULL = missing original (Advanced re-link placeholder)
  thumb_r2_key  TEXT NOT NULL,
  missing_original BOOLEAN NOT NULL DEFAULT FALSE,
  original_filename TEXT NOT NULL,
  mimetype      TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,             -- our upload dedupe standard
  tpy_checksum_md5 TEXT,                     -- Tropy parity; re-import matches md5 first
  size_bytes    BIGINT NOT NULL,
  width         INT NOT NULL, height INT NOT NULL,
  exif          JSONB NOT NULL DEFAULT '{}',
  page          INT NOT NULL DEFAULT 0,      -- 0-based (Tropy + tropy-capture)
  density       INT,
  keep_original BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX photos_item_idx ON photos(item_id, position);
CREATE INDEX photos_sha256_idx ON photos(checksum_sha256);
CREATE INDEX photos_md5_idx ON photos(tpy_checksum_md5);

-- ---------------------------------------------------------------- selections
CREATE TABLE selections (
  subject_id    UUID PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
  photo_id      UUID NOT NULL REFERENCES photos(subject_id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT 'Selection',
  x INT NOT NULL, y INT NOT NULL,
  width INT NOT NULL, height INT NOT NULL,   -- explicit rect
  position      INT NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------- notes
CREATE TABLE notes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id    UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  text          TEXT NOT NULL DEFAULT '',
  state         JSONB NOT NULL,              -- TipTap/ProseMirror doc JSON
  language      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX notes_subject_idx ON notes(subject_id) WHERE deleted_at IS NULL;

-- ------------------------------------------------------- transcriptions (v1: DDL only)
CREATE TABLE transcriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_id      UUID NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  text          TEXT NOT NULL DEFAULT '',
  alto_r2_key   TEXT,                        -- full ALTO-XML in R2, never Neon
  config        JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'done',
  angle         NUMERIC NOT NULL DEFAULT 0,
  mirror        BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at    TIMESTAMPTZ
);

-- ---------------------------------------------------------------- templates
CREATE TABLE templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  uri           TEXT,
  label_i18n    JSONB NOT NULL DEFAULT '{}', -- i18n hook now, EN-only v1
  fields        JSONB NOT NULL DEFAULT '[]', -- [{property_uri,label,label_i18n,datatype,required,order}]
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, name)
);
ALTER TABLE subjects ADD CONSTRAINT subjects_template_fk
  FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- metadata (immutable values)
CREATE TABLE metadata_values (
  value_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  datatype      TEXT NOT NULL,
  text          TEXT NOT NULL,
  data          JSONB
);
CREATE TABLE metadata (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id    UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  property_uri  TEXT NOT NULL,
  value_id      UUID NOT NULL REFERENCES metadata_values(value_id),
  language      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX metadata_subject_idx ON metadata(subject_id);
CREATE INDEX metadata_property_idx ON metadata(property_uri);
CREATE OR REPLACE FUNCTION forbid_metadata_value_update() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'metadata_values are immutable (Tropy parity)'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER metadata_values_immutable BEFORE UPDATE ON metadata_values
  FOR EACH ROW EXECUTE FUNCTION forbid_metadata_value_update();

-- ---------------------------------------------------------------- tags
CREATE TABLE tags (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          CITEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT '#B3541E',
  UNIQUE(project_id, name)
);
CREATE TABLE taggings (
  tag_id        UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  subject_id    UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  PRIMARY KEY (tag_id, subject_id)
);
CREATE INDEX taggings_subject_idx ON taggings(subject_id);

-- ---------------------------------------------------------------- lists (cycle-guarded tree)
CREATE TABLE lists (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  parent_list_id UUID REFERENCES lists(id) ON DELETE CASCADE,
  position      INT NOT NULL DEFAULT 0,
  color         TEXT
);
CREATE OR REPLACE FUNCTION forbid_list_cycle() RETURNS trigger AS $$
DECLARE p UUID;
BEGIN
  p := COALESCE(NEW.parent_list_id, OLD.parent_list_id);
  WHILE p IS NOT NULL LOOP
    IF p = COALESCE(NEW.id, OLD.id) THEN RAISE EXCEPTION 'list cycle rejected (Tropy parity)'; END IF;
    SELECT parent_list_id INTO p FROM lists WHERE id = p;
  END LOOP;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER lists_no_cycle BEFORE INSERT OR UPDATE ON lists
  FOR EACH ROW EXECUTE FUNCTION forbid_list_cycle();

CREATE TABLE list_items (
  list_id       UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  item_id       UUID NOT NULL REFERENCES items(subject_id) ON DELETE CASCADE,
  position      INT NOT NULL DEFAULT 0,
  PRIMARY KEY (list_id, item_id)
);

-- ---------------------------------------------------------------- trash
CREATE TABLE trash (
  subject_id    UUID PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
  deleted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason        TEXT NOT NULL CHECK (reason IN ('user','auto','merge')),
  prior_lists   JSONB NOT NULL DEFAULT '[]'
);
CREATE TABLE deleted_photos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_subject_id UUID NOT NULL,
  r2_key        TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  deleted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- import jobs + .tpy idempotency
CREATE TABLE import_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('upload','folder','tpy','jsonld','compress')),
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','paused_cpu','failed','done','cancelled')),
  total         INT NOT NULL DEFAULT 0,
  done          INT NOT NULL DEFAULT 0,
  failed        INT NOT NULL DEFAULT 0,
  cpu_seconds   NUMERIC NOT NULL DEFAULT 0,  -- per-job audit readout
  checkpoint    JSONB NOT NULL DEFAULT '{}',
  report        JSONB,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tpy_import_map (
  job_id        UUID NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  tpy_subject_id TEXT NOT NULL,
  new_subject_id UUID NOT NULL,
  PRIMARY KEY (job_id, tpy_subject_id)
);

-- ---------------------------------------------------------------- storage counters + cpu budget + compress log
CREATE TABLE storage_counters (
  project_id    UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  bytes_originals BIGINT NOT NULL DEFAULT 0,
  bytes_thumbs    BIGINT NOT NULL DEFAULT 0,
  bytes_exports   BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Build rule: every asset-touching transaction does SELECT ... FOR UPDATE on the
-- counters row FIRST (lock order: counters -> photos -> jobs).

CREATE TABLE cpu_budget_windows (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  window_start  TIMESTAMPTZ NOT NULL,
  window_end    TIMESTAMPTZ NOT NULL,
  cpu_seconds   NUMERIC NOT NULL DEFAULT 0,
  paused        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE compress_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  photo_subject_id UUID NOT NULL,
  old_r2_key    TEXT NOT NULL, new_r2_key TEXT NOT NULL,
  old_bytes     BIGINT NOT NULL, new_bytes BIGINT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- command log (undo idempotency; NO inverse column)
CREATE TABLE command_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  op_id         UUID NOT NULL UNIQUE,        -- client-generated idempotency key
  kind          TEXT NOT NULL,
  payload       JSONB NOT NULL,
  job_id        UUID REFERENCES import_jobs(id) ON DELETE SET NULL, -- compound import-undo
  undone_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX command_log_project_idx ON command_log(project_id, created_at DESC);

-- ---------------------------------------------------------------- rate buckets (B16: durable Neon rate limiting)
CREATE TABLE rate_buckets (
  key           TEXT PRIMARY KEY,            -- e.g. 'import:presign' (single-user: route-scoped)
  tokens        NUMERIC NOT NULL,
  capacity      INT NOT NULL,
  refill_per_sec NUMERIC NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ================================================================ FTS (§4)
CREATE TABLE search_documents (
  subject_id    UUID PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subject_kind  TEXT NOT NULL,
  doc           TSVECTOR NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX search_documents_gin ON search_documents USING GIN (doc);
CREATE INDEX search_documents_project_idx ON search_documents(project_id);

CREATE OR REPLACE FUNCTION refresh_search_document(p_subject UUID) RETURNS void AS $$
DECLARE v_text TEXT; v_tags TEXT; v_meta TEXT;
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
  SELECT string_agg(n.text, ' ') INTO v_text FROM notes n
    WHERE n.subject_id = p_subject AND n.deleted_at IS NULL;
  SELECT string_agg(t.name::text, ' ') INTO v_tags
    FROM taggings tg JOIN tags t ON t.id = tg.tag_id WHERE tg.subject_id = p_subject;
  INSERT INTO search_documents (subject_id, project_id, subject_kind, doc, updated_at)
  SELECT p_subject, s.project_id, s.kind,
         to_tsvector('english', coalesce(v_meta,'') || ' ' || coalesce(v_text,'') || ' ' || coalesce(v_tags,''))
         || to_tsvector('simple', coalesce(v_meta,'') || ' ' || coalesce(v_text,'') || ' ' || coalesce(v_tags,'')),
         now()
  FROM subjects s WHERE s.id = p_subject
  ON CONFLICT (subject_id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now();
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_refresh_search_document() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_search_document(OLD.subject_id);
    RETURN OLD;
  ELSE
    PERFORM refresh_search_document(NEW.subject_id);
    RETURN NEW;
  END IF;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_search_metadata
  AFTER INSERT OR UPDATE OR DELETE ON metadata
  FOR EACH ROW EXECUTE FUNCTION trg_refresh_search_document();
CREATE TRIGGER trg_search_notes
  AFTER INSERT OR UPDATE OR DELETE ON notes
  FOR EACH ROW EXECUTE FUNCTION trg_refresh_search_document();
CREATE TRIGGER trg_search_taggings
  AFTER INSERT OR UPDATE OR DELETE ON taggings
  FOR EACH ROW EXECUTE FUNCTION trg_refresh_search_document();
CREATE TRIGGER trg_search_transcriptions
  AFTER INSERT OR UPDATE OR DELETE ON transcriptions
  FOR EACH ROW EXECUTE FUNCTION trg_refresh_search_document();
-- No trigger on metadata_values: values are immutable; lifecycle arrives via metadata rows.
-- No trigger on subjects: doc refresh keyed off content tables; subjects without content get no row.
