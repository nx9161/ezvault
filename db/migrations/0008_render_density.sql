-- SPDX-License-Identifier: MIT
-- db/migrations/0008_render_density.sql — Wave B1 (parity rows 7 + 34).
--
-- Global default render density (PPI) for vector / multi-page formats
-- (PDF, SVG): the value the import pipeline rasterizes at when a photo
-- carries no per-photo override in photos.density. Persisted per project
-- (Project settings), default 300 — the archival-scan standard that v1's
-- TIFF workflow assumed and Tropy's own PDF default. Range enforced in
-- lib/import/density.ts (36..1200) and re-checked here.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS default_density INT NOT NULL DEFAULT 300
  CHECK (default_density >= 36 AND default_density <= 1200);
