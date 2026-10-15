-- SPDX-License-Identifier: MIT
-- db/migrations/0002_vocabularies.sql — Turtle/N3 vocabulary imports (phase2 §2.5).
-- Built-ins (DC elements+terms, RDF, Europeana) stay code-defined and
-- read-only; this table holds user-imported vocabularies only.

CREATE TABLE vocabularies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prefix        TEXT NOT NULL DEFAULT '',
  uri           TEXT NOT NULL DEFAULT '',
  label         TEXT NOT NULL,
  source_format TEXT NOT NULL DEFAULT 'turtle' CHECK (source_format IN ('turtle','n3')),
  triples       JSONB NOT NULL DEFAULT '[]',   -- first 1000 triples (sample)
  properties    JSONB NOT NULL DEFAULT '[]',   -- [{uri, label, type}] inventory
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
